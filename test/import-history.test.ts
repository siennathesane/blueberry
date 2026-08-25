/**
 * History import tests (#45) — converter logic, offline, synthetic records.
 * Covers: claude tree flattening + sidechains + noise, kimi wire extraction
 * + epoch-ms + index mapping, normalizeContent (string/blocks/images),
 * and dry-run vs apply semantics via the driver.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/core/db.ts";
import {
	convertClaudeSession,
	convertKimiSession,
	kimiWorkDirMap,
	normalizeContent,
	importHistory,
} from "../src/core/import-history.ts";
import { tmpAgentDir, tmpDir, cleanup } from "./helpers.ts";

// --- normalizeContent ----------------------------------------------------------------

test("normalizeContent: string passes; blocks filtered; images → placeholder", () => {
	assert.equal(normalizeContent("plain"), "plain");
	const blocks = normalizeContent([
		{ type: "text", text: "keep" },
		{ type: "image", data: "xxx" },
		{ type: "tool_use", name: "bash" },
	]);
	assert.ok(Array.isArray(blocks));
	assert.equal(blocks.length, 2);
	assert.equal((blocks[0] as { text: string }).text, "keep");
	assert.ok(
		(blocks[1] as { text: string }).text.includes("[image"),
		"image placeholder",
	);
	assert.equal(normalizeContent(42), "", "unknown types → empty");
});

// --- claude converter ------------------------------------------------------------------

function claudeLine(r: Record<string, unknown>): string {
	return JSON.stringify(r);
}

test("claude: user/assistant entries, parentId chain, noise skipped, cwd/title", () => {
	const lines = [
		claudeLine({ type: "last-prompt", leafUuid: "x", sessionId: "s1" }),
		claudeLine({ type: "permission-mode", permissionMode: "default", sessionId: "s1" }),
		claudeLine({
			type: "user",
			uuid: "u1",
			parentUuid: null,
			isSidechain: false,
			sessionId: "s1",
			timestamp: "2026-01-01T00:00:00Z",
			cwd: "/work/proj",
			message: { role: "user", content: "hello" },
		}),
		claudeLine({
			type: "attachment",
			uuid: "a1",
			sessionId: "s1",
			attachment: { type: "hook_success" },
		}),
		claudeLine({
			type: "assistant",
			uuid: "u2",
			parentUuid: "u1",
			isSidechain: false,
			sessionId: "s1",
			timestamp: "2026-01-01T00:00:05Z",
			cwd: "/work/proj",
			message: { role: "assistant", content: [{ type: "text", text: "hi back" }] },
			aiTitle: "Greeting session",
		}),
	];
	const { header, entries, cwd, title } = convertClaudeSession(lines, "s1");
	assert.equal(header["id"], "s1");
	assert.equal(header["cwd"], "/work/proj");
	assert.equal(header["timestamp"], "2026-01-01T00:00:00Z");
	assert.equal(cwd, "/work/proj");
	assert.equal(title, "Greeting session");
	assert.equal(entries.length, 2, "noise skipped");
	assert.equal(entries[0]!["parentId"], null);
	assert.equal(entries[1]!["parentId"], entries[0]!["id"], "chain");
	assert.equal((entries[1] as { message: { role: string } }).message.role, "assistant");
});

test("claude: sidechain branches attach to last mainline entry", () => {
	const lines = [
		claudeLine({ type: "user", uuid: "u1", parentUuid: null, sessionId: "s1", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "main" } }),
		claudeLine({ type: "user", uuid: "u2", parentUuid: null, sessionId: "s1", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "more main" } }),
		claudeLine({ type: "assistant", uuid: "sc1", parentUuid: "u1", isSidechain: true, sessionId: "s1", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", content: "side" } }),
	];
	const { entries } = convertClaudeSession(lines, "s1");
	assert.equal(entries.length, 3);
	const side = entries[2] as { parentId: string | null };
	// sidechain attaches to the LAST mainline entry (u2), not its claude-parent
	assert.equal(side.parentId, entries[1]!["id"]);
});

test("claude: torn tail lines skipped without throwing", () => {
	const lines = [
		'{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"s1","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"ok"}}',
		'{"type":"user","uuid":"u2","par', // torn
	];
	const { entries } = convertClaudeSession(lines, "s1");
	assert.equal(entries.length, 1);
});

// --- kimi converter --------------------------------------------------------------------

test("kimi: append_message → entries, epoch-ms → ISO, index maps cwd", () => {
	const lines = [
		JSON.stringify({ type: "metadata", protocol_version: "1.4", created_at: 1783687612110 }),
		JSON.stringify({ type: "config.update", profileName: "agent", systemPrompt: "You are..." }),
		JSON.stringify({
			type: "context.append_message",
			message: { role: "user", content: [{ type: "text", text: "fix the bug" }] },
			time: 1783687633639,
		}),
		JSON.stringify({ type: "llm.request", model: "kimi" }),
		JSON.stringify({
			type: "context.append_message",
			message: { role: "assistant", content: [{ type: "text", text: "fixed" }] },
			time: 1783687640000,
		}),
	];
	const { header, entries, cwd } = convertKimiSession(lines, "abc123", "/dev/proj");
	assert.equal(header["id"], "abc123");
	assert.equal(cwd, "/dev/proj");
	assert.equal(header["timestamp"], new Date(1783687633639).toISOString());
	assert.equal(entries.length, 2, "config/llm noise skipped");
	assert.equal(entries[0]!["parentId"], null);
	assert.equal(entries[1]!["parentId"], entries[0]!["id"]);
});

test("kimiWorkDirMap: index parsing skips torn lines", () => {
	const dir = join(tmpDir("bb-kimi-idx-"));
	mkdirSync(join(dir), { recursive: true });
	writeFileSync(
		join(dir, "session_index.jsonl"),
		'{"sessionId":"ses_a","sessionDir":"/x","workDir":"/dev/a"}\n' +
			'{"sessionId":"ses_b","sessionDir":"/y","workDir":"/dev/b"}\n' +
			'{"torn',
	);
	const map = kimiWorkDirMap(dir);
	assert.equal(map.get("ses_a"), "/dev/a");
	assert.equal(map.get("ses_b"), "/dev/b");
	assert.equal(map.size, 2);
	cleanup(dir);
});

// --- driver: dry-run vs apply ------------------------------------------------------------

let agentDir: string;
let db: ReturnType<typeof openDb>;
let workRoot: string;
let claudeDir: string;
let kimiDir: string;

beforeEach(() => {
	agentDir = tmpAgentDir();
	db = openDb(agentDir);
	workRoot = tmpDir("bb-import-");
	claudeDir = join(workRoot, "claude");
	kimiDir = join(workRoot, "kimi");
});

afterEach(() => {
	db.close();
	cleanup(workRoot);
});

function seedSources(): void {
	const proj = join(claudeDir, "-work-proj");
	mkdirSync(proj, { recursive: true });
	writeFileSync(
		join(proj, "sess-c1.jsonl"),
		[
			'{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"sess-c1","timestamp":"2026-01-01T00:00:00Z","cwd":"/work/proj","message":{"role":"user","content":"hello"}}',
			'{"type":"assistant","uuid":"u2","parentUuid":"u1","sessionId":"sess-c1","timestamp":"2026-01-01T00:00:05Z","cwd":"/work/proj","message":{"role":"assistant","content":"hi"}}',
		].join("\n") + "\n",
	);
	// kimi: wd_ dir + ses_ dir + wire.jsonl + index
	const wd = join(kimiDir, "wd_test");
	const ses = join(wd, "ses_k1", "agents", "main");
	mkdirSync(ses, { recursive: true });
	writeFileSync(
		join(ses, "wire.jsonl"),
		[
			'{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"kimi hello"}]},"time":1783687633639}',
		].join("\n") + "\n",
	);
	writeFileSync(
		join(kimiDir, "session_index.jsonl"),
		'{"sessionId":"ses_k1","sessionDir":"' + join(wd, "ses_k1") + '","workDir":"/work/proj"}\n',
	);
}

test("driver: dry-run reports without writing; apply writes and is idempotent", () => {
	seedSources();
	const byCwd = new Map([["/work/proj", "proj-1"]]);
	const tmp = join(workRoot, "tmp");

	const dry = importHistory(
		db,
		(cwd) => byCwd.get(cwd ?? "") ?? null,
		{ claude: claudeDir, kimi: kimiDir },
		{ source: "all", apply: false },
		tmp,
	);
	assert.equal(dry.imported.length, 2, "dry-run: 2 would import");
	assert.equal(dry.skipped, 0);
	const rows = db.prepare("SELECT COUNT(*) n FROM sessions").get() as { n: number };
	assert.equal(rows.n, 0, "dry-run wrote nothing");

	const applied = importHistory(
		db,
		(cwd) => byCwd.get(cwd ?? "") ?? null,
		{ claude: claudeDir, kimi: kimiDir },
		{ source: "all", apply: true },
		tmp,
	);
	assert.equal(applied.imported.length, 2, "apply: 2 imported");
	const rows2 = db.prepare("SELECT COUNT(*) n FROM sessions").get() as { n: number };
	assert.equal(rows2.n, 2, "sessions landed");
	const entries = db.prepare("SELECT COUNT(*) n FROM session_entries").get() as { n: number };
	assert.equal(entries.n, 3, "2 claude + 1 kimi entries");
	const fts = db
		.prepare("SELECT COUNT(*) n FROM session_fts WHERE text LIKE '%kimi hello%'")
		.get() as { n: number };
	assert.equal(fts.n, 1, "FTS indexed");

	const rerun = importHistory(
		db,
		(cwd) => byCwd.get(cwd ?? "") ?? null,
		{ claude: claudeDir, kimi: kimiDir },
		{ source: "all", apply: true },
		tmp,
	);
	assert.equal(rerun.imported.length, 0, "re-run: nothing new");
	assert.equal(rerun.skipped, 2, "re-run: both skipped");
	const rows3 = db.prepare("SELECT COUNT(*) n FROM sessions").get() as { n: number };
	assert.equal(rows3.n, 2, "no duplicates");
});
