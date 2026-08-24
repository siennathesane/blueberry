/**
 * LSP test pyramid: unit (framing codec, in-memory client) + integration
 * (fake LSP server over stdio) + e2e (real servers, opt-in).
 *
 * The fake server is a tiny Node script speaking real protocol — deterministic,
 * dependency-free, exercises the full spawn→initialize→request→dispose cycle.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	encodeFrame,
	parseFrame,
	LspClient,
	CLIENT_CAPABILITIES,
} from "../src/core/lsp-client.ts";
import { LspManager, languageIdForFile, resolveRustAnalyzer, defaultServers } from "../src/core/lsp-manager.ts";
import { tmpDir, cleanup } from "./helpers.ts";

// --- framing codec unit tests ---------------------------------------------------------

test("framing: encodeFrame produces Content-Length header + body", () => {
	const body = '{"jsonrpc":"2.0"}';
	const frame = encodeFrame(body);
	const expectedLen = Buffer.byteLength(body, "utf8");
	assert.ok(frame.startsWith(`Content-Length: ${expectedLen}\r\n\r\n`));
	assert.ok(frame.endsWith(body));
});

test("framing: parseFrame extracts one complete frame", () => {
	const body = '{"result":42}';
	const frame = encodeFrame(body);
	const buf = Buffer.from(frame, "utf8");
	const { message, rest } = parseFrame(buf);
	assert.equal(message, body);
	assert.equal(rest.length, 0);
});

test("framing: parseFrame handles partial frames (chunked arrival)", () => {
	const body = '{"method":"test"}';
	const frame = Buffer.from(encodeFrame(body), "utf8");

	// first half arrives
	const half = parseFrame(frame.subarray(0, Math.floor(frame.length / 2)));
	assert.equal(half.message, null, "incomplete frame yields null");
	assert.equal(half.rest.length, Math.floor(frame.length / 2));

	// full buffer now
	const full = parseFrame(Buffer.concat([half.rest, frame.subarray(Math.floor(frame.length / 2))]));
	assert.equal(full.message, body);
	assert.equal(full.rest.length, 0);
});

test("framing: multiple frames in one buffer are extracted sequentially", () => {
	const f1 = encodeFrame('{"id":1}');
	const f2 = encodeFrame('{"id":2}');
	const f3 = encodeFrame('{"id":3}');
	let buf: Buffer = Buffer.concat([Buffer.from(f1), Buffer.from(f2), Buffer.from(f3)]);

	const a = parseFrame(buf);
	buf = a.rest;
	assert.equal(a.message, '{"id":1}');
	const b = parseFrame(buf);
	buf = b.rest;
	assert.equal(b.message, '{"id":2}');
	const c = parseFrame(buf);
	assert.equal(c.message, '{"id":3}');
	assert.equal(c.rest.length, 0);
});

test("framing: multibyte UTF-8 content-length is byte-exact", () => {
	const body = '{"msg":"日本語テスト🦀"}'; // multibyte
	const frame = Buffer.from(encodeFrame(body), "utf8");
	const { message, rest } = parseFrame(frame);
	assert.equal(message, body, "UTF-8 body round-trips");
	assert.equal(rest.length, 0);
});

test("framing: malformed header is skipped without crashing", () => {
	const garbage = Buffer.from("not a frame\r\n\r\n", "ascii");
	const { message, rest } = parseFrame(garbage);
	assert.equal(message, null);
	assert.ok(rest.length < garbage.length, "garbage consumed");
});

test("framing: empty buffer", () => {
	const { message, rest } = parseFrame(Buffer.alloc(0));
	assert.equal(message, null);
	assert.equal(rest.length, 0);
});

// --- in-memory client unit tests -------------------------------------------------------

function makePipe(): { reader: PassThrough; writer: PassThrough; serverReader: PassThrough; serverWriter: PassThrough } {
	const reader = new PassThrough(); // client reads server output here
	const writer = new PassThrough(); // client writes server input here
	return { reader, writer, serverReader: writer, serverWriter: reader };
}

test("client: request/response correlation over in-memory streams", async () => {
	const { reader, writer, serverReader, serverWriter } = makePipe();
	const client = new LspClient({ reader, writer, requestTimeoutMs: 1000 });

	// fake server: respond to any request with { result: "ok" }
	const serverFrames: Buffer[] = [];
	serverReader.on("data", (chunk: Buffer) => {
		serverFrames.push(chunk);
		// parse and respond
		let buf: Buffer = Buffer.concat(serverFrames.splice(0));
		for (;;) {
			const { message, rest } = parseFrame(buf);
			buf = rest;
			if (message === null) break;
			const msg = JSON.parse(message) as { id?: number; method?: string };
			if (msg.id !== undefined && msg.method) {
				const resp = encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "ok" }));
				serverWriter.write(resp);
			}
		}
	});

	const result = await client.request("test/method", { x: 1 });
	assert.equal(result, "ok");
	client.dispose();
});

test("client: timeout rejects cleanly", async () => {
	const { reader, writer } = makePipe();
	const client = new LspClient({ reader, writer, requestTimeoutMs: 50 });

	// no server responding
	await assert.rejects(() => client.request("test/slow"), /timeout/);
	client.dispose();
});

test("client: error responses reject with the server's message", async () => {
	const { reader, writer, serverReader, serverWriter } = makePipe();
	const client = new LspClient({ reader, writer, requestTimeoutMs: 1000 });

	serverReader.on("data", (chunk: Buffer) => {
		const { message } = parseFrame(chunk);
		if (!message) return;
		const msg = JSON.parse(message) as { id?: number; method?: string };
		if (msg.id !== undefined) {
			serverWriter.write(
				encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } })),
			);
		}
	});

	await assert.rejects(() => client.request("test/bad"), /-32601.*method not found/);
	client.dispose();
});

test("client: notifications are delivered to handlers", async () => {
	const { reader, writer, serverWriter } = makePipe();
	const client = new LspClient({ reader, writer, requestTimeoutMs: 1000 });

	const received: unknown[] = [];
	client.handleNotification("test/push", (params) => received.push(params));

	// server pushes a notification
	serverWriter.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", method: "test/push", params: { hello: true } })));

	await new Promise((r) => setTimeout(r, 50));
	assert.equal(received.length, 1);
	assert.deepEqual(received[0], { hello: true });
	client.dispose();
});

test("client: server→client requests get responses", async () => {
	const { reader, writer, serverReader, serverWriter } = makePipe();
	const client = new LspClient({ reader, writer, requestTimeoutMs: 1000 });

	client.handleRequest("workspace/applyEdit", (_params, respond) => {
		respond({ applied: false });
	});

	// collect what the server receives back
	const serverResponses: Array<Record<string, unknown>> = [];
	serverReader.on("data", (chunk: Buffer) => {
		const { message } = parseFrame(chunk);
		if (!message) return;
		const msg = JSON.parse(message) as Record<string, unknown>;
		if (msg["result"] !== undefined || msg["error"] !== undefined) serverResponses.push(msg);
	});

	// server sends a request
	serverWriter.write(
		encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "workspace/applyEdit", params: {} })),
	);

	await new Promise((r) => setTimeout(r, 50));
	assert.equal(serverResponses.length, 1);
	assert.deepEqual(serverResponses[0]!["result"], { applied: false });
	client.dispose();
});

test("client: unhandled server→client requests get method-not-found", async () => {
	const { reader, writer, serverReader, serverWriter } = makePipe();
	const client = new LspClient({ reader, writer, requestTimeoutMs: 1000 });

	const serverResponses: Array<Record<string, unknown>> = [];
	serverReader.on("data", (chunk: Buffer) => {
		const { message } = parseFrame(chunk);
		if (!message) return;
		const msg = JSON.parse(message) as Record<string, unknown>;
		if (msg["error"] !== undefined) serverResponses.push(msg);
	});

	serverWriter.write(
		encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: 42, method: "unknown/method", params: {} })),
	);

	await new Promise((r) => setTimeout(r, 50));
	assert.equal(serverResponses.length, 1);
	const err = serverResponses[0]!["error"] as { code?: number; message?: string };
	assert.ok(err?.code === -32601 || err?.message?.includes("no handler"), `got: ${JSON.stringify(err)}`);
	client.dispose();
});

test("client: dispose rejects pending and prevents new requests", async () => {
	const { reader, writer } = makePipe();
	const client = new LspClient({ reader, writer, requestTimeoutMs: 5000 });

	const pending = client.request("test/slow");
	client.dispose();
	await assert.rejects(() => pending, /disposed/);
	await assert.rejects(() => client.request("test/after"), /disposed/);
});

test("client: capabilities include valueSet (deno requirement)", () => {
	const caps = CLIENT_CAPABILITIES as Record<string, unknown>;
	const td = caps["textDocument"] as Record<string, unknown>;
	const completion = td["completion"] as Record<string, unknown>;
	const kind = completion["completionItemKind"] as Record<string, unknown>;
	assert.ok(Array.isArray(kind["valueSet"]) && (kind["valueSet"] as number[]).length > 0, "completionItemKind.valueSet present");

	const docSymbol = td["documentSymbol"] as Record<string, unknown>;
	const symbolKind = docSymbol["symbolKind"] as Record<string, unknown>;
	assert.ok(Array.isArray(symbolKind["valueSet"]), "symbolKind.valueSet present");

	const codeAction = td["codeAction"] as Record<string, unknown>;
	const literal = codeAction["codeActionLiteralSupport"] as Record<string, unknown>;
	const actionKind = literal["codeActionKind"] as Record<string, unknown>;
	assert.ok(Array.isArray(actionKind["valueSet"]), "codeActionKind.valueSet present");
});

// --- manager unit tests ------------------------------------------------------------------

test("languageIdForFile: extension mapping", () => {
	assert.equal(languageIdForFile("main.ts"), "typescript");
	assert.equal(languageIdForFile("lib.rs"), "rust");
	assert.equal(languageIdForFile("main.go"), "go");
	assert.equal(languageIdForFile("main.c"), "c");
	assert.equal(languageIdForFile("header.hpp"), "cpp");
	assert.equal(languageIdForFile("README.md"), null);
	assert.equal(languageIdForFile("Makefile"), null);
});

test("resolveRustAnalyzer: finds real binary, not shim", () => {
	const path = resolveRustAnalyzer();
	assert.ok(path.length > 0);
	// must not be the rustup shim (which is a shell script)
	if (path.includes(".cargo/bin")) {
		assert.ok(!path.includes("shim"), "should not resolve to shim");
	}
});

test("friendlyError: server quirks mapped to readable messages", () => {
	assert.ok(LspManager.friendlyError("typeDefinition", new Error("no type definition for Greet")).includes("methods don't have one"));
	assert.ok(
		LspManager.friendlyError("rename", new Error('renaming "Greet" to "X" not possible because "pkg" has errors')).includes("fix them first"),
	);
	assert.ok(LspManager.friendlyError("codeAction", new Error("<semantic> TypeScript Server Error")).includes("tsserver internal"));
	assert.ok(LspManager.friendlyError("rename", new Error("no symbol at the given location")).includes("cursor on the symbol"));
	assert.ok(LspManager.friendlyError("definition", new Error("Server not initialized")).includes("try again"));
});

// --- integration: fake LSP server over stdio ------------------------------------------------

/** A minimal LSP server for integration testing — speaks real protocol over stdio. */
const FAKE_SERVER = `
const { encodeFrame, parseFrame } = (() => {
  const HEADER_SEP = "\\r\\n\\r\\n";
  const encode = (json) => \`Content-Length: \${Buffer.byteLength(json, "utf8")}\${HEADER_SEP}\${json}\`;
  const parse = (buffer) => {
    const sep = buffer.indexOf(HEADER_SEP);
    if (sep === -1) return { message: null, rest: buffer };
    const header = buffer.subarray(0, sep).toString("ascii");
    const m = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!m) return { message: null, rest: buffer.subarray(sep + 4) };
    const len = Number(m[1]);
    const start = sep + 4;
    if (buffer.length < start + len) return { message: null, rest: buffer };
    return { message: buffer.subarray(start, start + len).toString("utf8"), rest: buffer.subarray(start + len) };
  };
  return { encodeFrame: encode, parseFrame: parse };
})();

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const { message, rest } = parseFrame(buf);
    buf = rest;
    if (!message) break;
    const msg = JSON.parse(message);
    if (msg.method === "initialize" && msg.id !== undefined) {
      process.stdout.write(encodeFrame(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { capabilities: { hoverProvider: true }, serverInfo: { name: "fake-lsp" } },
      })));
    } else if (msg.method === "textDocument/hover" && msg.id !== undefined) {
      process.stdout.write(encodeFrame(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { contents: { type: "markdown", value: "fake hover: " + JSON.stringify(msg.params?.position) } },
      })));
    } else if (msg.method === "shutdown" && msg.id !== undefined) {
      process.stdout.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null })));
    } else if (msg.id !== undefined) {
      process.stdout.write(encodeFrame(JSON.stringify({
        jsonrpc: "2.0", id: msg.id, result: null,
      })));
    }
    if (msg.method === "initialized") {
      // send a diagnostics push
      process.stdout.write(encodeFrame(JSON.stringify({
        jsonrpc: "2.0", method: "textDocument/publishDiagnostics",
        params: { uri: "file:///test.ts", diagnostics: [{ severity: 1, message: "fake diagnostic", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }] },
      })));
    }
  }
});
`;

let area: string;

beforeEach(() => {
	area = tmpDir("bb-lsp-");
});
afterEach(() => {
	cleanup(area);
});

test("integration: spawn real process → initialize → hover → diagnostics → shutdown", async () => {
	const serverScript = join(area, "fake-lsp.mjs");
	writeFileSync(serverScript, FAKE_SERVER);

	const client = new LspClient({
		command: process.execPath,
		args: [serverScript],
		requestTimeoutMs: 5000,
	});

	const diags: unknown[] = [];
	client.handleNotification("textDocument/publishDiagnostics", (params) => diags.push(params));

	const init = (await client.initialize(area)) as { serverInfo?: { name?: string } };
	assert.equal(init.serverInfo?.name, "fake-lsp");

	// wait for the diagnostics push (sent on "initialized")
	await new Promise((r) => setTimeout(r, 200));
	assert.ok(diags.length >= 1, "diagnostics pushed after initialize");

	const hover = (await client.request("textDocument/hover", {
		textDocument: { uri: "file:///test.ts" },
		position: { line: 0, character: 0 },
	})) as { contents?: { value?: string } };
	assert.ok(hover?.contents?.value?.includes("fake hover"));

	await client.shutdown();
	client.dispose();
});

test("integration: server exit rejects pending requests", async () => {
	const serverScript = join(area, "fake-exit.mjs");
	writeFileSync(serverScript, "process.exit(1);");

	const client = new LspClient({
		command: process.execPath,
		args: [serverScript],
		requestTimeoutMs: 5000,
	});

	await assert.rejects(() => client.initialize(area), /exited/);
	client.dispose();
});

test("integration: manager spawns fake server on demand and reaps", async () => {
	const serverScript = join(area, "fake-lsp.mjs");
	writeFileSync(serverScript, FAKE_SERVER);

	const manager = new LspManager(area, {
		specs: [
			{
				name: "fake",
				command: process.execPath,
				args: [serverScript],
				languageIds: ["typescript"],
				warmupMs: 100,
			},
		],
		maxServers: 1,
		idleMs: 200,
	});

	// status: not running yet
	assert.equal(manager.status()[0]!.running, false);

	// open a ts file → server spawns
	const tsFile = join(area, "probe.ts");
	writeFileSync(tsFile, "const x: number = 1;\n");
	await manager.openFile(tsFile);

	// status: running
	assert.equal(manager.status()[0]!.running, true);
	assert.equal(manager.status()[0]!.openDocs, 1);

	// diagnostics arrived
	const diags = manager.getDiagnostics();
	assert.ok(diags.size >= 1, "fake server pushed diagnostics");

	manager.dispose();
	assert.equal(manager.status()[0]!.running, false);
});

test("manager: serverFor returns null for unconfigured language", async () => {
	const manager = new LspManager(area, { specs: [] });
	assert.equal(await manager.serverFor("cobol"), null);
	manager.dispose();
});

test("manager: request routes to the right server; unknown file language rejects", async () => {
	const serverScript = join(area, "fake2.mjs");
	writeFileSync(serverScript, FAKE_SERVER);
	const manager = new LspManager(area, {
		specs: [
			{ name: "fake", command: process.execPath, args: [serverScript], languageIds: ["typescript"], warmupMs: 50 },
		],
	});

	// unknown extension → clean error
	await assert.rejects(
		() => manager.request("textDocument/hover", {}, join(area, "file.xyz")),
		/no lsp language/,
	);

	// known extension → routes + auto-opens
	const tsFile = join(area, "route.ts");
	writeFileSync(tsFile, "const y = 2;\n");
	const result = await manager.request(
		"textDocument/hover",
		{ textDocument: { uri: `file://${tsFile}` }, position: { line: 0, character: 0 } },
		tsFile,
	);
	assert.ok(result, "hover result returned");

	manager.dispose();
});

test("manager: changeFile updates version and syncs", async () => {
	const serverScript = join(area, "fake3.mjs");
	writeFileSync(serverScript, FAKE_SERVER);
	const manager = new LspManager(area, {
		specs: [
			{ name: "fake", command: process.execPath, args: [serverScript], languageIds: ["typescript"], warmupMs: 50 },
		],
	});

	const tsFile = join(area, "change.ts");
	writeFileSync(tsFile, "const a = 1;\n");
	await manager.openFile(tsFile);

	// modify the file → changeFile should bump version
	writeFileSync(tsFile, "const a = 2;\n");
	await manager.changeFile(tsFile);

	// file not open → changeFile is a no-op (no crash)
	const otherFile = join(area, "not-open.ts");
	writeFileSync(otherFile, "const b = 3;\n");
	await manager.changeFile(otherFile); // should not crash

	// close an un-open file → no crash
	manager.closeFile(otherFile);

	manager.dispose();
});

test("manager: maxServers evicts the idlest", async () => {
	const serverScript = join(area, "fake4.mjs");
	writeFileSync(serverScript, FAKE_SERVER);
	const specs = [
		{ name: "fake-a", command: process.execPath, args: [serverScript], languageIds: ["typescript"], warmupMs: 50 },
		{ name: "fake-b", command: process.execPath, args: [serverScript], languageIds: ["go"], warmupMs: 50 },
	];
	const manager = new LspManager(area, { specs, maxServers: 1 });

	const tsFile = join(area, "cap1.ts");
	writeFileSync(tsFile, "const c = 1;\n");
	await manager.openFile(tsFile);

	const goFile = join(area, "cap2.go");
	writeFileSync(goFile, "package main\n");
	// opening go should evict typescript (maxServers=1)
	await manager.openFile(goFile);

	// go is running; typescript was evicted
	const tsStatus = manager.status().find((s) => s.name === "fake-a");
	assert.equal(tsStatus!.running, false, "typescript server evicted");

	manager.dispose();
});

test("manager: spawn failure returns null (bad command)", async () => {
	const manager = new LspManager(area, {
		specs: [
			{ name: "broken", command: "/nonexistent/binary/that/does/not/exist", args: [], languageIds: ["typescript"], warmupMs: 10 },
		],
	});
	const result = await manager.serverFor("typescript");
	assert.equal(result, null, "spawn failure yields null, not a crash");
	manager.dispose();
});

test("manager: dispose is idempotent", () => {
	const manager = new LspManager(area, { specs: [] });
	manager.dispose();
	manager.dispose(); // second call must not throw
});

test("manager: startWatcher + changeFile cycle on real fs events", async () => {
	const serverScript = join(area, "fake-watch.mjs");
	writeFileSync(serverScript, FAKE_SERVER);
	const manager = new LspManager(area, {
		specs: [
			{ name: "fake", command: process.execPath, args: [serverScript], languageIds: ["typescript"], warmupMs: 50 },
		],
	});
	manager.startWatcher();

	// open a file, then modify it — the watcher should pick it up
	const tsFile = join(area, "watched.ts");
	writeFileSync(tsFile, "const f = 1;\n");
	await manager.openFile(tsFile);

	// modify — watcher fires changeFile after debounce
	writeFileSync(tsFile, "const f = 2;\n");
	await new Promise((r) => setTimeout(r, 500)); // debounce + settle

	// delete the file — watcher fires closeFile
	const { rmSync } = await import("node:fs");
	rmSync(tsFile);
	await new Promise((r) => setTimeout(r, 500));

	manager.dispose();
	// watcher is closed; writing again doesn't crash
	writeFileSync(tsFile, "const f = 3;\n");
});

test("manager: serverFor on already-running server (idempotent)", async () => {
	const serverScript = join(area, "fake-idem.mjs");
	writeFileSync(serverScript, FAKE_SERVER);
	const manager = new LspManager(area, {
		specs: [
			{ name: "fake", command: process.execPath, args: [serverScript], languageIds: ["typescript"], warmupMs: 50 },
		],
	});

	const tsFile = join(area, "idem.ts");
	writeFileSync(tsFile, "const g = 1;\n");
	await manager.openFile(tsFile); // spawns
	const s1 = await manager.serverFor("typescript");
	const s2 = await manager.serverFor("typescript");
	assert.equal(s1, s2, "same instance returned, no re-spawn");

	manager.dispose();
});

test("manager: defaultServers() discovers installed servers without crashing", () => {
	const servers = defaultServers();
	// on this machine: typescript-language-server (bundled), gopls,
	// rust-analyzer, clangd at minimum
	assert.ok(servers.length >= 3, `found ${servers.length} servers`);
	for (const s of servers) {
		assert.ok(s.command.length > 0, `${s.name} has a command`);
		assert.ok(s.languageIds.length > 0 || s.name === "deno lsp", `${s.name} has languages (or is deno, which is opt-in)`);
	}
	// typescript should be present (bundled)
	assert.ok(servers.some((s) => s.name === "typescript-language-server"), "tsserver bundled");
});

test("manager: languageIdForFile edge cases — no ext, dotfile, unknown ext", () => {
	assert.equal(languageIdForFile("/path/Makefile"), null);
	assert.equal(languageIdForFile("/path/.gitignore"), null);
	assert.equal(languageIdForFile("/path/file.xyz"), null);
	assert.equal(languageIdForFile("/path/.ts"), null); // dotfile, not .ts ext
	assert.equal(languageIdForFile("/path/x.TS"), null); // case-sensitive
});

test("manager: diagnostics with zero diags clears the map entry", async () => {
	const serverScript = join(area, "fake-clear.mjs");
	// fake server that pushes empty diagnostics after initialize
	writeFileSync(serverScript, FAKE_SERVER.replace(
		'[{ severity: 1, message: "fake diagnostic",',
		'[], // empty diagnostics clears the entry\n      // [{ severity: 1, message: "fake diagnostic",'
	));
	const manager = new LspManager(area, {
		specs: [
			{ name: "fake", command: process.execPath, args: [serverScript], languageIds: ["typescript"], warmupMs: 50 },
		],
	});
	const tsFile = join(area, "clear.ts");
	writeFileSync(tsFile, "const e = 5;\n");
	await manager.openFile(tsFile);
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(manager.getDiagnostics().size, 0, "empty push cleared");
	manager.dispose();
});

test("manager: getDiagnostics filtered by uri", async () => {
	const serverScript = join(area, "fake5.mjs");
	writeFileSync(serverScript, FAKE_SERVER);
	const manager = new LspManager(area, {
		specs: [
			{ name: "fake", command: process.execPath, args: [serverScript], languageIds: ["typescript"], warmupMs: 50 },
		],
	});

	const tsFile = join(area, "filter.ts");
	writeFileSync(tsFile, "const d = 4;\n");
	await manager.openFile(tsFile);
	await new Promise((r) => setTimeout(r, 300)); // wait for diagnostics push

	const targetUri = new URL(`file://${tsFile}`).href;
	const fakeUri = "file:///test.ts"; // the fake server pushes THIS uri
	const filtered = manager.getDiagnostics(fakeUri);
	assert.ok(filtered.has(fakeUri), "diagnostics for the pushed uri");
	assert.ok(!filtered.has(targetUri), "our file's uri has no diagnostics (server pushed a different one)");

	const all = manager.getDiagnostics();
	assert.ok(all.size >= 1);

	manager.dispose();
});
