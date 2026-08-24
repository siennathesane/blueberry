/**
 * LSP wire client: JSON-RPC over Content-Length-framed stdio (§LSP).
 *
 * Two construction modes:
 * - { command, args }  → spawns a real language server (child_process)
 * - { reader, writer } → in-memory streams (unit tests; no processes)
 *
 * Pure protocol only: framing, request/response correlation, notifications,
 * server→client requests, timeouts, disposal. Lifecycle (which server for
 * which language, when to spawn/reap) is lsp-manager's job.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";

// --- framing codec ----------------------------------------------------------------

const HEADER_SEP = "\r\n\r\n";

/** Encode one JSON-RPC message into an LSP wire frame. */
export function encodeFrame(json: string): string {
	return `Content-Length: ${Buffer.byteLength(json, "utf8")}${HEADER_SEP}${json}`;
}

export interface ParsedFrame {
	/** JSON body of one complete frame, or null if the buffer has none yet. */
	message: string | null;
	/** Remaining bytes after the frame (or the whole buffer if none). */
	rest: Buffer;
}

/** Try to extract one frame from a byte buffer. Byte-exact for multibyte UTF-8. */
export function parseFrame(buffer: Buffer): ParsedFrame {
	const sep = buffer.indexOf(HEADER_SEP);
	if (sep === -1) return { message: null, rest: buffer };
	const headerBlock = buffer.subarray(0, sep).toString("ascii");
	let contentLength = -1;
	for (const line of headerBlock.split("\r\n")) {
		const m = /^Content-Length:\s*(\d+)$/i.exec(line);
		if (m) {
			contentLength = Number(m[1]);
			break;
		}
	}
	if (contentLength < 0) {
		// header present but malformed: drop through the separator, keep scanning
		return { message: null, rest: buffer.subarray(sep + HEADER_SEP.length) };
	}
	const bodyStart = sep + HEADER_SEP.length;
	if (buffer.length < bodyStart + contentLength) {
		return { message: null, rest: buffer };
	}
	const body = buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
	return { message: body, rest: buffer.subarray(bodyStart + contentLength) };
}

// --- JSON-RPC types ------------------------------------------------------------------

export interface RpcError {
	code: number;
	message: string;
	data?: unknown;
}

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
}

/** Broad client capabilities: register nearly everything (§LSP rule — servers
 * unlock their best behavior); actions stay explicit at the tool layer. */
export const CLIENT_CAPABILITIES = {
	processId: null,
	textDocument: {
		synchronization: { dynamicRegistration: false, didSave: false, willSave: false, willSaveWaitUntil: false },
		hover: { contentFormat: ["markdown", "plaintext"] },
		completion: {
			contextSupport: true,
			completionItem: {
				snippetSupport: false,
				documentationFormat: ["markdown", "plaintext"],
				resolveSupport: { properties: ["documentation", "detail"] },
			},
			completionItemKind: { valueSet: Array.from({ length: 25 }, (_, i) => i + 1) },
		},
		signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"] } },
		definition: { linkSupport: false },
		typeDefinition: { linkSupport: false },
		implementation: { linkSupport: false },
		references: {},
		documentHighlight: {},
		documentSymbol: {
			symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
			hierarchicalDocumentSymbolSupport: true,
		},
		codeAction: {
			codeActionLiteralSupport: {
				codeActionKind: { valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports"] },
			},
			isPreferredSupport: true,
		},
		codeLens: {},
		formatting: {},
		rangeFormatting: {},
		rename: { prepareSupport: true },
		foldingRange: {},
		selectionRange: {},
		linkedEditingRange: {},
		documentLink: {},
		documentColor: {},
		callHierarchy: {},
		typeHierarchy: {},
		semanticTokens: {
			tokenTypes: [],
			tokenModifiers: [],
			formats: ["relative"],
			requests: { range: true, full: true },
			overlappingTokenSupport: false,
			multilineTokenSupport: false,
		},
	},
	workspace: {
		applyEdit: true,
		workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"], failureHandling: "textOnlyTransactional" },
		symbol: { symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) } },
		workspaceFolders: true,
		configuration: false,
	},
} as const;

export interface LspClientOptions {
	command?: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** In-memory mode: read server output here. */
	reader?: Readable;
	/** In-memory mode: write server input here. */
	writer?: Writable;
	/** stderr of a spawned server: "ignore" (default) or "inherit". */
	stderr?: "ignore" | "inherit";
	requestTimeoutMs?: number;
}

export class LspClient {
	private readonly proc: ChildProcess | null = null;
	private readonly reader: Readable;
	private readonly writer: Writable;
	private readonly timeoutMs: number;
	private buffer: Buffer = Buffer.alloc(0);
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly notificationHandlers = new Map<string, (params: unknown) => void>();
	private readonly requestHandlers = new Map<
		string,
		(params: unknown, respond: (result: unknown, error?: RpcError) => void) => void
	>();
	private disposed = false;
	private exitHandler: ((code: number | null) => void) | null = null;

	constructor(opts: LspClientOptions) {
		this.timeoutMs = opts.requestTimeoutMs ?? 30_000;
		if (opts.command) {
			this.proc = spawn(opts.command, opts.args ?? [], {
				cwd: opts.cwd,
				env: opts.env,
				stdio: ["pipe", "pipe", opts.stderr ?? "ignore"],
			});
			this.reader = this.proc.stdout!;
			this.writer = this.proc.stdin!;
		} else if (opts.reader && opts.writer) {
			this.reader = opts.reader;
			this.writer = opts.writer;
		} else {
			throw new Error("LspClient requires {command} or {reader,writer}");
		}
		this.reader.on("data", (chunk: Buffer) => this.onData(chunk));
		if (this.proc) {
			this.proc.on("error", () => this.rejectAll(new Error("server process error")));
			this.proc.on("exit", (code) => this.rejectAll(new Error(`server exited (code ${code ?? "null"})`)));
		}
	}

	/** Raw write of one framed message (exposed for the manager's raw needs). */
	send(message: unknown): void {
		this.writer.write(encodeFrame(JSON.stringify(message)));
	}

	/** Fire a request; resolves with `result`, rejects on error/timeout/dispose. */
	request(method: string, params?: unknown): Promise<unknown> {
		if (this.disposed) return Promise.reject(new Error("client disposed"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`lsp request timeout: ${method} (${this.timeoutMs}ms)`));
			}, this.timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	/** Fire a notification (no response expected). */
	notify(method: string, params?: unknown): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	/** Register a handler for server→client notifications (e.g. diagnostics). */
	handleNotification(method: string, handler: (params: unknown) => void): void {
		this.notificationHandlers.set(method, handler);
	}

	/** Register a handler for server→client requests (e.g. applyEdit). */
	handleRequest(
		method: string,
		handler: (params: unknown, respond: (result: unknown, error?: RpcError) => void) => void,
	): void {
		this.requestHandlers.set(method, handler);
	}

	/** Respond to a server→client request we received. */
	respond(id: number | string, result: unknown, error?: RpcError): void {
		if (error === undefined) this.send({ jsonrpc: "2.0", id, result }); else this.send({ jsonrpc: "2.0", id, error });
	}

	/** The initialize handshake. Resolves with the server's InitializeResult. */
	async initialize(rootPath: string, initializationOptions?: unknown): Promise<unknown> {
		const rootUri = pathToFileURL(rootPath).href;
		const result = await this.request("initialize", {
			processId: process.pid,
			rootUri,
			rootPath,
			clientInfo: { name: "blueberry" },
			capabilities: CLIENT_CAPABILITIES,
			initializationOptions,
			workspaceFolders: [{ uri: rootUri, name: basename(rootPath) }],
		});
		this.notify("initialized", {});
		return result;
	}

	/** Graceful shutdown: shutdown request, then exit notification. */
	async shutdown(): Promise<void> {
		try {
			await this.request("shutdown");
		} catch {
			// server may already be gone; exit anyway
		}
		this.notify("exit");
	}

	/** Promise that resolves when a spawned server's process exits. */
	onExit(): Promise<number | null> {
		if (!this.proc) return Promise.resolve(0);
		if (this.proc.exitCode !== null) return Promise.resolve(this.proc.exitCode);
		return new Promise((resolve) => {
			this.exitHandler = resolve;
			this.proc!.once("exit", (code) => {
				if (this.exitHandler === resolve) this.exitHandler = null;
				resolve(code);
			});
		});
	}

	/** Hard teardown: reject all pending, kill process if spawned. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.rejectAll(new Error("client disposed"));
		if (this.proc) {
			this.proc.kill("SIGTERM");
		}
		try {
			this.writer.end();
		} catch {
			// already closed
		}
	}

	private rejectAll(err: Error): void {
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
	}

	private onData(chunk: Buffer): void {
		if (this.disposed) return;
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const { message, rest } = parseFrame(this.buffer);
			this.buffer = rest;
			if (message === null) break;
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(message) as Record<string, unknown>;
			} catch {
				continue; // tolerate a malformed body; keep scanning
			}
			this.dispatch(msg);
		}
	}

	private dispatch(msg: Record<string, unknown>): void {
		const method = typeof msg["method"] === "string" ? msg["method"] : undefined;
		const id = msg["id"];

		if (method !== undefined && id !== undefined) {
			// server→client request
			const handler = this.requestHandlers.get(method);
			if (handler) {
				handler(msg["params"], (result, error) => this.respond(id as number | string, result, error));
			} else {
				this.respond(id as number | string, undefined, {
					code: -32601,
					message: `blueberry: no handler for ${method}`,
				});
			}
			return;
		}
		if (method !== undefined) {
			// notification
			const handler = this.notificationHandlers.get(method);
			if (handler) handler(msg["params"]);
			return;
		}
		if (id !== undefined) {
			// response to our request
			const pending = this.pending.get(Number(id));
			if (!pending) return;
			this.pending.delete(Number(id));
			clearTimeout(pending.timer);
			if (msg["error"] === undefined) {
				pending.resolve(msg["result"]);
			} else {
				const err = msg["error"] as RpcError;
				pending.reject(new Error(`lsp error ${err.code}: ${err.message}`));
			}
		}
		// anything else: ignore
	}
}
