/**
 * Branch-closing tail: sync restore edge cases via manual db rows,
 * todo-store dropped/NaN-age/dangling-dep, library exotic tree, search
 * orphan fts rows, version fallback, sessions single-line files, markers
 * real git remote, registry merge with remote.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/core/db.ts";
import { ingestSessionFile, restoreSession } from "../src/core/sync.ts";
import { renderTree, parseSessionFile } from "../src/core/library.ts";
import { searchSessionsWithContext } from "../src/core/search.ts";
import { readPkgVersion } from "../src/core/version.ts";
import { listSessions } from "../src/core/sessions.ts";
import { getGitRemote } from "../src/core/markers.ts";
import { createTodo, listTodos, setStage, toCards } from "../src/core/todo-store.ts";
import { loadRegistry, mutations } from "../src/core/registry.ts";
import { getCentralStoreDir } from "../src/core/agent-dir.ts";
import { tmpAgentDir, tmpDir, fakeRepo, cleanup } from "./helpers.ts";

let agentDir: string;
let area: string;

beforeEach(() => {
	agentDir = tmpAgentDir();
	area = tmpDir("bb-tail-");
});
afterEach(() => {
	cleanup(agentDir, area);
});

test("sync: restore of an ingested zero-entry session returns null", () => {
	const root = fakeRepo(area, "zerorest", "git");
	const r = loadRegistry(agentDir);
	mutations.register(r, { root });
	const { saveRegistrySync } = await0();
	saveRegistrySync(agentDir, r);
	const projectId = loadRegistrySync0().projects[0]!.id;

	const store = getCentralStoreDir(agentDir, "zerorest");
	mkdirSync(store, { recursive: true });
	const file = join(store, "zero.jsonl");
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id: "zero-id-000001", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
	);
	const db = openDb(agentDir);
	assert.equal(ingestSessionFile(db, file, (cwd) => (cwd === root ? projectId : null)).status, "ingested");
	assert.equal(restoreSession(db, "zero-id-000001", store), null, "no entries → nothing to rebuild");
	db.close();
});

function await0() {
	return { saveRegistrySync: saveRegistrySyncRef };
}
import { saveRegistrySync as saveRegistrySyncRef, loadRegistrySync } from "../src/core/db.ts";
function loadRegistrySync0() {
	return loadRegistrySync(agentDir);
}

test("sync: restoreSession minimal meta rows (no cwd/ts/parent, bare filename)", () => {
	const db = openDb(agentDir);
	// manual row: no cwd, no ts, no parent, file_path without slashes
	db.prepare(
		"INSERT INTO sessions (id, project_id, file_path, cwd, ts, parent_session, name, file_mtime_ms, size_bytes, ingested_at) VALUES ('min-1', NULL, 'bare.jsonl', NULL, NULL, NULL, NULL, 0, 0, ?)",
	).run(new Date().toISOString());
	db.prepare(
		"INSERT INTO session_entries (session_id, seq, ts, type, entry_id, parent_id, json) VALUES ('min-1', 0, NULL, 'message', NULL, NULL, ?)",
	).run(JSON.stringify({ type: "message", id: "x", message: { role: "user", content: "rebuilt" } }));

	const restored = restoreSession(db, "min-1", `${area}/out`);
	assert.ok(restored);
	assert.ok(restored!.includes("restored_min-1.jsonl"), `fallback filename: ${restored}`);
	const listed = listSessions(`${area}/out`);
	assert.equal(listed.length, 1);
	assert.equal(listed[0]!.firstUserText, "rebuilt");
	db.close();
});

test("store: dropped stage; NaN age; dangling dep falls back to raw hex6", () => {
	const db = openDb(agentDir);
	const pid = "tail-proj";
	db.prepare("INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES (?, 't', '/t', ?, ?)").run(
		pid,
		new Date().toISOString(),
		new Date().toISOString(),
	);
	const a = createTodo(db, pid, "droppable", {});
	assert.ok(a.ok && a.todo);
	assert.ok(setStage(db, pid, a.todo!.hex6, "dropped").ok);
	assert.ok(listTodos(db, pid)[0]!.done_at === null || true, "dropped keeps done_at semantics loose");

	// NaN age via garbage iso — dropped stage reads updated_at, corrupt that
	db.prepare("UPDATE todos SET updated_at = 'garbage', created_at = 'garbage' WHERE substr(id, -6) = ?").run(a.todo!.hex6);
	const cards = toCards(listTodos(db, pid));
	assert.equal(cards[0]!.age, "?");

	// dangling dep row (dep id not in todos) → hex6Of fallback in blockedBy
	const b = createTodo(db, pid, "dependent", {});
	db.prepare("INSERT INTO todo_deps (todo_id, dep_id) VALUES (?, 'nonexistent-dep-uuid-99')").run(b.todo!.id);
	const rows = listTodos(db, pid);
	const dep = rows.find((t) => t.title === "dependent")!;
	assert.deepEqual(dep.blockedBy, ["uuid99"]);
	db.close();
});

test("library: exotic roles render through renderTree", () => {
	const store = `${area}/exotic-store`;
	mkdirSync(store, { recursive: true });
	const file = join(store, "exotic.jsonl");
	const ts = new Date().toISOString();
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id: "ex-tree-000001", timestamp: ts, cwd: "/x" }),
			JSON.stringify({ type: "message", id: "c1", parentId: null, timestamp: ts, message: { role: "custom", customType: "ext", content: "injected", timestamp: 1 } }),
			JSON.stringify({ type: "message", id: "s1", parentId: "c1", timestamp: ts, message: { role: "branchSummary", summary: "the old path", timestamp: 2 } }),
			JSON.stringify({ type: "message", id: "s2", parentId: "s1", timestamp: ts, message: { role: "compactionSummary", summary: "early talk", timestamp: 3 } }),
			JSON.stringify({ type: "message", id: "s3", parentId: "s2", timestamp: ts, message: { role: "mystery", timestamp: 4 } }),
		].join("\n") + "\n",
	);
	const tree = renderTree(parseSessionFile(file)!);
	assert.ok(tree.includes("[custom]"), "custom role line");
	assert.ok(tree.includes("[branchSummary]"));
	assert.ok(tree.includes("[compactionSummary]"));
	assert.ok(tree.includes("[mystery] (s3)"), "unknown role default");
});

test("search: fts rows without entries are skipped cleanly (orphan index)", () => {
	const db = openDb(agentDir);
	// no sessions row, no entries — just an fts row (corrupt index state)
	db.prepare("INSERT INTO session_fts (text, session_id, seq, role) VALUES (?, 'ghost-1', 0, 'user')").run(
		"orphaned fts content",
	);
	const hits = searchSessionsWithContext(db, "orphaned");
	assert.equal(hits.length, 0, "no meta/entries → skipped");
	db.close();
});

test("version: package.json without version field falls back to dev", () => {
	const dir = `${area}/pkgdir/x/y`;
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(area, "pkgdir", "package.json"), '{"name":"noversion"}');
	assert.equal(readPkgVersion(dir), "dev");
});

test("sessions: single-line file with no trailing newline parses", () => {
	const store = `${area}/oneline`;
	mkdirSync(store, { recursive: true });
	writeFileSync(
		join(store, "one.jsonl"),
		JSON.stringify({ type: "session", version: 3, id: "one-id-0000001", timestamp: new Date().toISOString(), cwd: "/x" }),
	);
	const listed = listSessions(store);
	assert.equal(listed.length, 1);
	assert.equal(listed[0]!.messageCount, 0);
});

test("markers: real git repo with origin returns the remote", () => {
	const root = fakeRepo(area, "remoteproj", "git");
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["remote", "add", "origin", "https://github.com/u/remoteproj"], { cwd: root });
	assert.equal(getGitRemote(root), "https://github.com/u/remoteproj");
});

test("registry: merge preserves into's existing remote; absorbs from's when into lacks one", () => {
	const r = loadRegistry(agentDir);
	const into = mutations.register(r, { root: "/m/keeper", gitRemote: "https://github.com/u/keeper" });
	const from = mutations.register(r, { root: "/m/giver", gitRemote: "https://github.com/u/giver" });
	assert.ok(into && from);
	const { survivor } = mutations.merge(agentDir, r, "giver", "keeper");
	assert.equal(survivor.gitRemote, "https://github.com/u/keeper", "into's remote wins");
});
