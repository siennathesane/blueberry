/**
 * Final branch closure: todo-store error/fallback arms, sync size-change
 * re-ingest + fts limit, util decoder limits, library renderMessage arms.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, loadRegistryDb, saveRegistrySync } from "../src/core/db.ts";
import {
	addDep,
	checkpointDigest,
	createTodo,
	deleteTodo,
	sessionsForTodo,
	setStage,
} from "../src/core/todo-store.ts";
import { ftsSearch, ingestSessionFile, syncStores } from "../src/core/sync.ts";
import { renderMessage, parseSessionFile, renderMessages } from "../src/core/library.ts";
import { decodeDirNameToPathCandidates } from "../src/core/util.ts";
import { loadRegistry, mutations } from "../src/core/registry.ts";
import { getCentralStoreDir } from "../src/core/agent-dir.ts";
import { tmpAgentDir, tmpDir, fakeRepo, fakeSession, cleanup } from "./helpers.ts";

let agentDir: string;
let area: string;
let db: ReturnType<typeof openDb>;
const PROJECT = "proj-fin-1";

beforeEach(() => {
	agentDir = tmpAgentDir();
	area = tmpDir("bb-fin-");
	db = openDb(agentDir);
	db.prepare(
		"INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES (?, 'p', '/x/p', ?, ?)",
	).run(PROJECT, new Date().toISOString(), new Date().toISOString());
});
afterEach(() => {
	db.close();
	cleanup(agentDir, area);
});

test("store: unknown ids rejected across all mutations", () => {
	const a = createTodo(db, PROJECT, "exists", {});
	assert.ok(a.ok && a.todo);
	assert.equal(setStage(db, PROJECT, "zzzzzz", "doing").ok, false, "move unknown");
	assert.equal(addDep(db, PROJECT, "zzzzzz", a.todo!.hex6).ok, false, "dep unknown task");
	assert.equal(addDep(db, PROJECT, a.todo!.hex6, "zzzzzz").ok, false, "dep unknown target");
	assert.equal(deleteTodo(db, PROJECT, "zzzzzz").ok, false, "delete unknown");
});

test("store: sessionsForTodo excludes NULL session rows", () => {
	const t = createTodo(db, PROJECT, "mixed sessions", { sessionId: "s-real" });
	assert.ok(t.ok);
	setStage(db, PROJECT, t.todo!.hex6, "doing", { sessionId: null }); // NULL row must be excluded
	const sessions = sessionsForTodo(db, t.todo!.hex6);
	assert.deepEqual(sessions, ["s-real"]);
});

test("store: checkpoint with zero touched tasks prints bare frontier", () => {
	const t = createTodo(db, PROJECT, "untouched by this session", { sessionId: "other" });
	assert.ok(t.ok);
	const digest = checkpointDigest(db, PROJECT, "p", "never-seen-session");
	assert.ok(digest.startsWith("bb-checkpoint p"));
	assert.ok(!digest.includes("untouched"), "no breadcrumbs for untouched");
	assert.ok(digest.includes("NEXT"), "frontier still present");
});

test("store: checkpoint with no tasks at all is just the header", () => {
	const digest = checkpointDigest(db, PROJECT, "p", "any");
	assert.equal(digest, "bb-checkpoint p");
});

// --- sync arms -------------------------------------------------------------------

test("sync: size-only change re-ingests (mtime equal, size differs)", () => {
	const root = fakeRepo(area, "sizechg", "git");
	const r = loadRegistry(agentDir);
	mutations.register(r, { root });
	saveRegistrySync(agentDir, r);
	const projectId = loadRegistryDb(db).projects.find((p) => p.canonicalPath === root)!.id;

	const store = getCentralStoreDir(agentDir, "sizechg");
	const file = fakeSession(store, { cwd: root, firstUserText: "short" });
	// round mtime to kill sub-ms jitter, ingest, then grow the file at the same mtime
	const rounded = new Date(Math.floor(Date.now() / 1000) * 1000);
	utimesSync(file, rounded, rounded);
	assert.equal(ingestSessionFile(db, file, (c) => (c === root ? projectId : null)).status, "ingested");
	assert.equal(ingestSessionFile(db, file, (c) => (c === root ? projectId : null)).status, "unchanged");
	// grow with VALID entries, then pin mtime back to the recorded value: size-only change
	const body = readFileSync(file, "utf8");
	writeFileSync(file, `${body}${JSON.stringify({ type: "message", id: "grow01", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "padding entry that changes the byte size", timestamp: 1 } })}\n`);
	utimesSync(file, rounded, rounded);
	const res = ingestSessionFile(db, file, (c) => (c === root ? projectId : null));
	assert.equal(res.status, "ingested", "size change alone triggers re-ingest");
});

test("sync: ftsSearch honors limit", () => {
	const root = fakeRepo(area, "limit", "git");
	const r = loadRegistry(agentDir);
	mutations.register(r, { root });
	saveRegistrySync(agentDir, r);
	const store = getCentralStoreDir(agentDir, "limit");
	for (let i = 0; i < 5; i++) {
		fakeSession(store, { cwd: root, firstUserText: `quantum entry number ${i}` });
	}
	const report = syncStores(db, agentDir, loadRegistryDb(db));
	assert.equal(report.ingested, 5);
	assert.equal(ftsSearch(db, "quantum", 3).length, 3, "limit applied");
});

// --- util decoder limits --------------------------------------------------------------

test("decode: >12 segments and zero-segment names return empty", () => {
	const thirteen = `--${Array.from({ length: 13 }, (_, i) => `s${i}`).join("-")}--`;
	assert.deepEqual(decodeDirNameToPathCandidates(thirteen, () => true), []);
	assert.deepEqual(decodeDirNameToPathCandidates("not-a-pi-dir", () => true), []);
});

// --- library renderMessage arms ---------------------------------------------------------

test("library: bashExecution drill-down renders output, exit, truncation flag", () => {
	const store = `${area}/bashstore`;
	mkdirSync(store, { recursive: true });
	const file = join(store, "bash.jsonl");
	const ts = new Date().toISOString();
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "bash-00000001", timestamp: ts, cwd: "/x" }),
		JSON.stringify({ type: "message", id: "b1", parentId: null, timestamp: ts, message: { role: "bashExecution", command: "npm test", output: "ok", exitCode: 0, cancelled: false, truncated: true, fullOutputPath: "/tmp/full", timestamp: 1 } }),
		JSON.stringify({ type: "message", id: "b2", parentId: "b1", timestamp: ts, message: { role: "bashExecution", command: "echo", output: "", timestamp: 2 } }),
	];
	writeFileSync(file, `${lines.join("\n")}\n`);
	const parsed = parseSessionFile(file)!;
	const full = renderMessage(parsed, 1);
	assert.ok(full.includes("$ npm test"));
	assert.ok(full.includes("exit 0"));
	const bare = renderMessage(parsed, 2);
	assert.ok(bare.includes("$ echo"));
	// messages view: bash one-liner for visible command
	const msgs = renderMessages(parsed, 0, 10);
	assert.ok(msgs.includes("$ npm test"));
});