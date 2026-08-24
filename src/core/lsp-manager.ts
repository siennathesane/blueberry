/**
 * LSP lifecycle manager: which server for which language, when to spawn,
 * how to handle each server's quirks (§LSP).
 *
 * Server-quirk handling born from the real-server lab (test/lsp-lab.mjs):
 * - gopls: needs initializationOptions to enable semanticTokens; refuses
 *   rename when the workspace has errors (surfaced as friendly message)
 * - rust-analyzer: ~/.cargo/bin shim may be a rustup stub — resolve the
 *   real binary from the toolchain
 * - tsserver: internal '<semantic>' errors on codeAction at clean positions
 *   — catch and return empty
 * - clangd: strict UTF-16 offset validation
 */
import { LspClient } from "./lsp-client.ts";
import { existsSync, readFileSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

/** Robust file URI encoding (spaces, unicode, brackets). */
function fileUri(path: string): string {
	return pathToFileURL(path).href;
}

// --- language detection ------------------------------------------------------------

const EXT_TO_LANG: Record<string, string> = {
	".ts": "typescript", ".tsx": "typescriptreact", ".mts": "typescript", ".cts": "typescript",
	".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript",
	".go": "go",
	".rs": "rust",
	".c": "c", ".h": "c",
	".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
	".py": "python",
	".zig": "zig",
};

export function languageIdForFile(path: string): string | null {
	return EXT_TO_LANG[extname(path)] ?? null;
}

// --- server resolution ---------------------------------------------------------------

export interface ServerSpec {
	name: string;
	command: string;
	args: string[];
	languageIds: string[];
	/** Server-specific initializationOptions (gopls semanticTokens etc). */
	initializationOptions?: unknown;
	/** Extra warmup ms after initialize before first request (rust-analyzer). */
	warmupMs?: number;
}

/** Resolve the real rust-analyzer binary (rustup shim → toolchain path). */
export function resolveRustAnalyzer(): string {
	const shim = join(homedir(), ".cargo", "bin", "rust-analyzer");
	if (existsSync(shim)) {
		try {
			// check if it's a real binary or a rustup shim (shims are shell scripts)
			const head = readFileSync(shim);
			if (!head.includes("#!/bin/sh")) return shim; // real binary
		} catch { /* fall through */ }
		// find in toolchains
		const toolchains = join(homedir(), ".rustup", "toolchains");
		if (existsSync(toolchains)) {
			for (const tc of readdirSync(toolchains)) {
				const candidate = join(toolchains, tc, "bin", "rust-analyzer");
				if (existsSync(candidate)) return candidate;
			}
		}
	}
	return "rust-analyzer"; // hope it's on PATH as a real binary
}

function bin(name: string): string | null {
	try {
		return execFileSync("which", [name], { encoding: "utf8" }).trim() || null;
	} catch {
		return null;
	}
}

/** Resolve bundled typescript-language-server from node_modules. */
function resolveTsServer(): string | null {
	const local = join(process.cwd(), "node_modules", ".bin", "typescript-language-server");
	if (existsSync(local)) return local;
	return bin("typescript-language-server");
}

export function defaultServers(): ServerSpec[] {
	const specs: ServerSpec[] = [];

	const ts = resolveTsServer();
	if (ts) {
		specs.push({
			name: "typescript-language-server",
			command: ts,
			args: ["--stdio"],
			languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
			warmupMs: 2000,
		});
	}
	if (bin("gopls")) {
		specs.push({
			name: "gopls",
			command: bin("gopls")!,
			args: [],
			languageIds: ["go"],
			initializationOptions: { semanticTokens: true, noSemanticString: true },
			warmupMs: 2000,
		});
	}
	const ra = resolveRustAnalyzer();
	if (ra) {
		specs.push({
			name: "rust-analyzer",
			command: ra,
			args: [],
			languageIds: ["rust"],
			warmupMs: 5000,
		});
	}
	if (bin("clangd")) {
		specs.push({
			name: "clangd",
			command: bin("clangd")!,
			args: [],
			languageIds: ["c", "cpp"],
			warmupMs: 2000,
		});
	}
	if (bin("deno")) {
		specs.push({
			name: "deno lsp",
			command: bin("deno")!,
			args: ["lsp"],
			languageIds: [], // opt-in only: would conflict with typescript server
			warmupMs: 2000,
		});
	}
	return specs;
}

// --- managed server --------------------------------------------------------------------

interface ManagedServer {
	spec: ServerSpec;
	client: LspClient;
	openDocs: Map<string, { version: number; languageId: string }>;
	lastActivity: number;
	restarts: number;
	initializeResult: unknown;
}

export interface LspStatusEntry {
	name: string;
	running: boolean;
	languages: string[];
	openDocs: number;
	restarts: number;
	serverInfo?: string;
}

export class LspManager {
	private readonly root: string;
	private readonly servers = new Map<string, ManagedServer>(); // languageId → server
	private readonly specs: ServerSpec[];
	private readonly watchers = new Map<string, FSWatcher>();
	private diagnostics = new Map<string, Array<{ severity: number; message: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }>>();
	private disposed = false;
	private idleTimer: NodeJS.Timeout | null = null;
	private readonly maxServers: number;
	private readonly idleMs: number;

	constructor(root: string, opts: { specs?: ServerSpec[]; maxServers?: number; idleMs?: number } = {}) {
		this.root = root;
		this.specs = opts.specs ?? defaultServers();
		this.maxServers = opts.maxServers ?? 3;
		this.idleMs = opts.idleMs ?? 10 * 60 * 1000;
		// idle reaper: evict servers untouched for idleMs (checked every minute)
		this.idleTimer = setInterval(() => {
			const now = Date.now();
			for (const [lang, s] of [...this.servers]) {
				if (now - s.lastActivity > this.idleMs) {
					void this.stopServer(lang);
				}
			}
		}, 60_000);
		this.idleTimer.unref?.();
	}

	/** Find (or spawn) the server for a languageId. Returns null if none configured. */
	async serverFor(languageId: string): Promise<ManagedServer | null> {
		if (this.disposed) return null;
		const existing = this.servers.get(languageId);
		if (existing) {
			existing.lastActivity = Date.now();
			return existing;
		}

		const spec = this.specs.find((s) => s.languageIds.includes(languageId));
		if (!spec) return null;

		// enforce concurrent cap: reap the idlest server
		if (this.servers.size >= this.maxServers) {
			let idlest: string | null = null;
			let idlestTime = Infinity;
			for (const [lang, s] of this.servers) {
				if (s.lastActivity < idlestTime) {
					idlest = lang;
					idlestTime = s.lastActivity;
				}
			}
			if (idlest !== null) await this.stopServer(idlest);
		}

		return this.spawnServer(spec, languageId);
	}

	private async spawnServer(spec: ServerSpec, languageId: string): Promise<ManagedServer | null> {
		const client = new LspClient({
			command: spec.command,
			args: spec.args,
			cwd: this.root,
			requestTimeoutMs: 30_000,
		});

		const managed: ManagedServer = {
			spec,
			client,
			openDocs: new Map(),
			lastActivity: Date.now(),
			restarts: 0,
			initializeResult: null,
		};

		// diagnostics handler
		client.handleNotification("textDocument/publishDiagnostics", (params) => {
			const uri = String((params as Record<string, unknown>)["uri"] ?? "");
			const diags = ((params as Record<string, unknown>)["diagnostics"] ?? []) as Array<Record<string, unknown>>;
			if (diags.length === 0) {
				this.diagnostics.delete(uri);
			} else {
				this.diagnostics.set(
					uri,
					diags.map((d) => ({
						severity: Number(d["severity"] ?? 1),
						message: String(d["message"] ?? ""),
						range: d["range"] as ManagedServer["openDocs"] extends never ? never : { start: { line: number; character: number }; end: { line: number; character: number } },
					})),
				);
			}
		});

		// applyEdit handler (Tier 3: accept + report, never auto-apply)
		client.handleRequest("workspace/applyEdit", (_params, respond) => {
			respond({ applied: false, failureReason: "blueberry: preview only — use bb_lsp rename/codeAction to apply" });
		});

		try {
			managed.initializeResult = await client.initialize(this.root, spec.initializationOptions);
			if (spec.warmupMs) await new Promise((r) => setTimeout(r, spec.warmupMs));
		} catch {
			client.dispose();
			return null;
		}

		this.servers.set(languageId, managed);
		return managed;
	}

	private async stopServer(languageId: string): Promise<void> {
		const s = this.servers.get(languageId);
		if (!s) return;
		this.servers.delete(languageId);
		try {
			await s.client.shutdown();
		} catch { /* already gone */ }
		s.client.dispose();
	}

	/** Open a file (didOpen) on its language's server. */
	async openFile(path: string): Promise<void> {
		const languageId = languageIdForFile(path);
		if (!languageId) return;
		const server = await this.serverFor(languageId);
		if (!server) return;

		const uri = fileUri(path);
		if (server.openDocs.has(uri)) return; // already open

		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			return;
		}
		server.openDocs.set(uri, { version: 1, languageId });
		server.client.notify("textDocument/didOpen", {
			textDocument: { uri, languageId, version: 1, text },
		});
	}

	/** Sync a file change (didChange, full-text). */
	async changeFile(path: string): Promise<void> {
		const languageId = languageIdForFile(path);
		if (!languageId) return;
		const server = this.servers.get(languageId);
		if (!server) return;
		const uri = fileUri(path);
		const doc = server.openDocs.get(uri);
		if (!doc) return;

		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			return;
		}
		doc.version++;
		server.client.notify("textDocument/didChange", {
			textDocument: { uri, version: doc.version },
			contentChanges: [{ text }],
		});
	}

	/** Close a file (didClose). */
	closeFile(path: string): void {
		for (const [, server] of this.servers) {
			const uri = fileUri(path);
			if (server.openDocs.has(uri)) {
				server.openDocs.delete(uri);
				server.client.notify("textDocument/didClose", { textDocument: { uri } });
			}
		}
	}

	/** Start watching the project root for file changes (debounced). */
	startWatcher(): void {
		let debounce: NodeJS.Timeout | null = null;
		const watcher = watch(this.root, { recursive: true }, (_event, filename) => {
			if (typeof filename !== "string") return;
			const path = join(this.root, filename);
			if (!languageIdForFile(path)) return;
			if (debounce) clearTimeout(debounce);
			debounce = setTimeout(() => {
				if (existsSync(path)) {
					void this.changeFile(path);
				} else {
					this.closeFile(path);
				}
			}, 200);
		});
		this.watchers.set("root", watcher);
	}

	/** Run a request against the server for a file's language. */
	async request(method: string, params: unknown, filePath: string): Promise<unknown> {
		const languageId = languageIdForFile(filePath);
		if (!languageId) throw new Error(`no lsp language for ${filePath}`);
		const server = await this.serverFor(languageId);
		if (!server) throw new Error(`no lsp server for ${languageId}`);
		await this.openFile(filePath);
		return server.client.request(method, params);
	}

	/** Get current diagnostics (pushed, not pulled). */
	getDiagnostics(uri?: string): Map<string, Array<{ severity: number; message: string; range: unknown }>> {
		if (uri !== undefined) {
			const filtered = new Map();
			if (this.diagnostics.has(uri)) filtered.set(uri, this.diagnostics.get(uri));
			return filtered;
		}
		return new Map(this.diagnostics);
	}

	/** Status for bb_lsp status / CLI. */
	status(): LspStatusEntry[] {
		return this.specs.map((spec) => {
			const running = [...this.servers.values()].find((s) => s.spec.name === spec.name);
			if (!running) {
				return { name: spec.name, running: false, languages: spec.languageIds, openDocs: 0, restarts: 0 };
			}
			const info = running.initializeResult as { serverInfo?: { name?: string } } | null;
			return {
				name: spec.name,
				running: true,
				languages: spec.languageIds,
				openDocs: running.openDocs.size,
				restarts: running.restarts,
				serverInfo: info?.serverInfo?.name ?? spec.name,
			};
		});
	}

	/** Friendly error mapping — server quirks to human/model-readable messages. */
	static friendlyError(method: string, err: Error): string {
		const msg = err.message;
		if (msg.includes("no type definition")) return "no type definition at this position (methods don't have one)";
		if (msg.includes("not possible because") && msg.includes("has errors")) {
			return `rename blocked: the workspace has diagnostics errors. fix them first, then rename.`;
		}
		if (msg.includes("<semantic>") || msg.includes("TypeScript Server Error")) {
			return `tsserver internal error at this position (try at a line with diagnostics)`;
		}
		if (msg.includes("no symbol at the given location")) {
			return `no renameable symbol at this position (place the cursor on the symbol name)`;
		}
		if (msg.includes("Server not initialized")) {
			return `lsp server not ready yet (try again in a moment)`;
		}
		return `lsp ${method} failed: ${msg}`;
	}

	/** Tear down all servers, watchers, timers. */
	dispose(): void {
		this.disposed = true;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		for (const [, w] of this.watchers) w.close();
		this.watchers.clear();
		for (const [, s] of this.servers) {
			try { s.client.dispose(); } catch { /* gone */ }
		}
		this.servers.clear();
	}
}
