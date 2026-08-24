/**
 * LSP lab probe: drive EVERY installed server through the real LspClient
 * against /tmp/lsp-lab tiny projects. No assertions about server semantics —
 * this is a bug-fleshing harness: it records what each server actually does
 * per surface and prints a matrix. Failures print full context.
 *
 * Usage: node test/lsp-lab.mjs [--server gopls]
 */
import { LspClient } from "../src/core/lsp-client.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const LAB = "/tmp/lsp-lab";

const SERVERS = [
	{
		name: "gopls",
		lang: "go",
		root: `${LAB}/go`,
		file: "main.go",
		languageId: "go",
		command: "gopls",
		args: [],
		// 1-based line/char of `Greet` definition site usage: g.Greet() at line 14
		probe: {
			line: 17,
			char: 11,
			symbol: "Greet",
			renameLine: 17,
			renameChar: 11,
		},
		warmupMs: 2500,
	},
	{
		name: "rust-analyzer",
		lang: "rust",
		root: `${LAB}/rust`,
		file: "src/main.rs",
		languageId: "rust",
		command:
			"/Users/sienna/.rustup/toolchains/nightly-aarch64-apple-darwin/bin/rust-analyzer",
		args: [],
		probe: {
			line: 17,
			char: 24,
			symbol: "describe",
			renameLine: 10,
			renameChar: 11,
		},
		warmupMs: 6000,
	},
	{
		name: "clangd",
		lang: "c",
		root: `${LAB}/c`,
		file: "main.c",
		languageId: "c",
		command: "clangd",
		args: [],
		probe: {
			line: 8,
			char: 5,
			symbol: "point_sum",
			renameLine: 18,
			renameChar: 16,
		},
		warmupMs: 3000,
	},
	{
		name: "typescript-language-server",
		lang: "typescript",
		root: `${LAB}/ts`,
		file: "main.ts",
		languageId: "typescript",
		command: join(REPO, "node_modules/.bin/typescript-language-server"),
		args: ["--stdio"],
		probe: { line: 19, char: 15, symbol: "greet", renameLine: 10, renameChar: 9 },
		warmupMs: 3000,
	},
	{
		name: "deno lsp",
		lang: "deno",
		root: `${LAB}/ts`,
		file: "main.ts",
		languageId: "typescript",
		command: "deno",
		args: ["lsp"],
		probe: { line: 19, char: 15, symbol: "greet", renameLine: 10, renameChar: 9 },
		warmupMs: 3000,
	},
];

const only = process.argv.includes("--server")
	? process.argv[process.argv.indexOf("--server") + 1]
	: null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pos(line0, char0) {
	return { line: line0 - 1, character: char0 - 1 }; // to 0-based
}
function loc(location) {
	if (!location) return "(none)";
	const uri = location.uri ?? "(no uri)";
	const r = location.range?.start;
	return `${uri.split("/").pop()}:${r ? r.line + 1 : "?"}:${r ? r.character + 1 : "?"}`;
}

async function probeServer(spec) {
	console.log(
		`\n${"=".repeat(70)}\n${spec.name} (${spec.command} ${spec.args.join(" ")})\n${"=".repeat(70)}`,
	);
	const client = new LspClient({
		command: spec.command,
		args: spec.args,
		cwd: spec.root,
		requestTimeoutMs: 20_000,
	});
	const diagnostics = [];
	client.handleNotification("textDocument/publishDiagnostics", (params) => {
		diagnostics.push(params);
	});

	const results = {};
	const step = async (name, fn) => {
		try {
			results[name] = await fn();
			console.log(`  ✓ ${name}`);
		} catch (err) {
			results[name] = { __error: String(err.message ?? err) };
			console.log(`  ✗ ${name}: ${String(err.message ?? err).slice(0, 160)}`);
		}
	};

	try {
		await step("initialize", async () => {
			const r = await client.initialize(spec.root);
			return { server: r?.serverInfo?.name, version: r?.serverInfo?.version };
		});

		const filePath = join(spec.root, spec.file);
		const text = readFileSync(filePath, "utf8");
		const uri = new URL(`file://${filePath}`).href;
		const doc = { uri, languageId: spec.languageId, version: 1, text };

		await step("didOpen", () =>
			client.notify("textDocument/didOpen", { textDocument: doc }),
		);

		// wait for diagnostics to arrive
		await sleep(spec.warmupMs);
		await step("diagnostics", async () => {
			const d = diagnostics.find((x) => x.uri === uri);
			return (d?.diagnostics ?? []).map(
				(x) => `${x.severity ?? "?"}: ${x.message?.split("\n")[0]}`,
			);
		});

		const p = spec.probe;
		const posParams = { textDocument: { uri }, position: pos(p.line, p.char) };

		await step("definition", async () => {
			const r = await client.request("textDocument/definition", posParams);
			return Array.isArray(r) ? r.map(loc) : loc(r);
		});
		await step("typeDefinition", async () => {
			const r = await client.request("textDocument/typeDefinition", posParams);
			return Array.isArray(r) ? r.map(loc) : loc(r);
		});
		await step("hover", async () => {
			const r = await client.request("textDocument/hover", posParams);
			const v = r?.contents?.value ?? r?.contents ?? null;
			return v ? String(v).slice(0, 120) : "(empty)";
		});
		await step("references", async () => {
			const r = await client.request("textDocument/references", {
				...posParams,
				context: { includeDeclaration: true },
			});
			return Array.isArray(r) ? r.map(loc) : loc(r);
		});
		await step("documentSymbol", async () => {
			const r = await client.request("textDocument/documentSymbol", {
				textDocument: { uri },
			});
			const names = Array.isArray(r) ? r.map((s) => `${s.kind}:${s.name}`) : [];
			return names;
		});
		await step("workspaceSymbol", async () => {
			const r = await client.request("workspace/symbol", {
				query: spec.probe.symbol,
			});
			return Array.isArray(r)
				? r.slice(0, 5).map((s) => `${s.name} @${loc(s.location)}`)
				: "(none)";
		});
		await step("completion", async () => {
			const r = await client.request("textDocument/completion", posParams);
			const items = Array.isArray(r) ? r : (r?.items ?? []);
			return {
				count: items.length,
				sample: items.slice(0, 3).map((i) => i.label),
			};
		});
		await step("signatureHelp", () =>
			client.request("textDocument/signatureHelp", posParams),
		);
		await step("foldingRange", () =>
			client.request("textDocument/foldingRange", { textDocument: { uri } }),
		);
		await step("semanticTokens", async () => {
			const r = await client.request("textDocument/semanticTokens/full", {
				textDocument: { uri },
			});
			return { dataLength: r?.data?.length ?? 0 };
		});

		// rename: prepare → rename (won't apply; preview only)
		await step("rename (preview)", async () => {
			const r = await client.request("textDocument/rename", {
				textDocument: { uri },
				position: pos(spec.probe.renameLine, spec.probe.renameChar),
				newName: `renamed_${spec.probe.symbol}`,
			});
			const changes = r?.changes ?? {};
			const files = Object.keys(changes);
			return { files, edits: files.map((f) => changes[f].length) };
		});

		// formatting
		await step("formatting", async () => {
			const r = await client.request("textDocument/formatting", {
				textDocument: { uri },
				options: { tabSize: 2, insertSpaces: true },
			});
			return { editCount: r?.length ?? 0 };
		});

		// codeAction (at the deliberate error site — last line-ish)
		await step("codeAction", async () => {
			const r = await client.request("textDocument/codeAction", {
				textDocument: { uri },
				range: { start: pos(p.line, 1), end: pos(p.line, 60) },
				context: { diagnostics: [] },
			});
			return Array.isArray(r) ? r.map((a) => a.title).slice(0, 3) : "(none)";
		});

		// applyEdit (server→client request): ask rust-analyzer's runnables? just verify
		// the handler wiring exists by reporting what we registered.
		await step("shutdown", () => client.shutdown());
	} finally {
		client.dispose();
	}

	console.log(`\n--- ${spec.name} summary ---`);
	for (const [k, v] of Object.entries(results)) {
		const val = v?.__error
			? `ERROR: ${v.__error}`
			: JSON.stringify(v)?.slice(0, 100);
		console.log(`  ${v?.__error ? "✗" : "✓"} ${k.padEnd(18)} ${val}`);
	}
	return results;
}

const wanted = only ? SERVERS.filter((s) => s.name.includes(only)) : SERVERS;
const all = {};
for (const spec of wanted) {
	if (!existsSync(join(spec.root, spec.file))) {
		console.log(`\nskipping ${spec.name}: lab file missing`);
		continue;
	}
	try {
		all[spec.name] = await probeServer(spec);
	} catch (err) {
		console.log(`\n!! ${spec.name} crashed the probe: ${err.message}`);
		all[spec.name] = { __fatal: err.message };
	}
}

console.log(`\n${"=".repeat(70)}\nFULL MATRIX\n${"=".repeat(70)}`);
const surfaces = [
	"initialize",
	"diagnostics",
	"definition",
	"typeDefinition",
	"hover",
	"references",
	"documentSymbol",
	"workspaceSymbol",
	"completion",
	"signatureHelp",
	"foldingRange",
	"semanticTokens",
	"rename (preview)",
	"formatting",
	"codeAction",
	"shutdown",
];
for (const surface of surfaces) {
	const marks = wanted.map((s) => {
		const r = all[s.name]?.[surface];
		if (r === undefined) return `${s.name}:?`;
		return `${s.name}:${r?.__error ? "✗" : "✓"}`;
	});
	console.log(`  ${surface.padEnd(18)} ${marks.join("  ")}`);
}
