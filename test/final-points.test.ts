/**
 * The final branch points: age-string minutes, ageMs second/minute units,
 * ingest edge headers, null-slug sessions, number content, CLI arg quirks,
 * done→todo reopen, invalid-first-line files.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { main, type CliDeps } from "../src/cli/main.ts";
import { openDb } from "../src/core/db.ts";
import { ingestSessionFile } from "../src/core/sync.ts";
import { searchSessionsWithContext } from "../src/core/search.ts";
import { renderMessages, parseSessionFile } from "../src/core/library.ts";
import { listSessions } from "../src/core/sessions.ts";
import { columnItems } from "../src/core/todo-pane.ts";
import {
	createTodo,
	listTodos,
	setStage,
	toCards,
} from "../src/core/todo-store.ts";
import { loadRegistry, mutations } from "../src/core/registry.ts";
import { saveRegistrySync } from "../src/core/db.ts";
import { getCentralStoreDir } from "../src/core/agent-dir.ts";
import { tmpAgentDir, tmpDir, fakeRepo, cleanup } from "./helpers.ts";

let agentDir: string;
let area: string;
let out: string[];

function deps(cwd: string): CliDeps {
	return {
		cwd,
		agentDir,
		// deno-lint-ignore require-await
		runPi: async () => 0,
		out: (l) => out.push(l),
		err: () => {},
		gitRemoteReader: () => null,
	};
}

beforeEach(() => {
	agentDir = tmpAgentDir();
	area = tmpDir("bb-pts-");
	out = [];
});
afterEach(() => {
	cleanup(agentDir, area);
});

test("pane: ageMs orders seconds/minutes and tolerates junk", () => {
	const mk = (age: string) => ({
		id: age,
		title: age,
		stage: "review" as const,
		age,
	});
	const ordered = columnItems(
		[mk("45m"), mk("30s"), mk("2h"), mk("junk"), mk("1d"), mk("new")],
		"review",
	).map((c) => c.age);
	// oldest first: 1d, 2h, 45m, 30s, then zero-ish (junk/new) in stable order
	assert.deepEqual(ordered, ["1d", "2h", "45m", "30s", "junk", "new"]);
});

test("store: minute-scale age renders as Xm", () => {
	const db = openDb(agentDir);
	const pid = "pts";
	db
		.prepare(
			"INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES (?, 'p', '/p', ?, ?)",
		)
		.run(pid, new Date().toISOString(), new Date().toISOString());
	const t = createTodo(db, pid, "five minutes old", {});
	db
		.prepare("UPDATE todos SET created_at = ? WHERE substr(id, -6) = ?")
		.run(new Date(Date.now() - 5 * 60_000).toISOString(), t.todo!.hex6);
	assert.equal(toCards(listTodos(db, pid))[0]!.age, "5m");
	db.close();
});

test("store: done→todo reopen passes legality block (stage not in gate set)", () => {
	const db = openDb(agentDir);
	const pid = "pts2";
	db
		.prepare(
			"INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES (?, 'p2', '/p2', ?, ?)",
		)
		.run(pid, new Date().toISOString(), new Date().toISOString());
	const t = createTodo(db, pid, "reopen to todo", {});
	assert.ok(setStage(db, pid, t.todo!.hex6, "done").ok);
	assert.ok(setStage(db, pid, t.todo!.hex6, "todo").ok, "done→todo allowed");
	assert.equal(listTodos(db, pid)[0]!.stage, "todo");
	db.close();
});

import { loadRegistryDb } from "../src/core/db.ts";

test("sync: empty-string cwd header is treated as no cwd; missing timestamp tolerated", () => {
	const root = fakeRepo(area, "edgehdr", "git");
	const r = loadRegistry(agentDir);
	mutations.register(r, { root });
	saveRegistrySync(agentDir, r);
	const db0 = openDb(agentDir);
	const projectId = loadRegistryDb(db0).projects[0]!.id;
	db0.close();

	const store = getCentralStoreDir(agentDir, "edgehdr");
	mkdirSync(store, { recursive: true });
	const noCwd = join(store, "nocwd.jsonl");
	writeFileSync(
		noCwd,
		`${JSON.stringify({ type: "session", version: 3, id: "nocwd-00000001", timestamp: new Date().toISOString(), cwd: "" })}\n`,
	);
	const noTs = join(store, "nots.jsonl");
	writeFileSync(
		noTs,
		`${JSON.stringify({ type: "session", version: 3, id: "nots-00000001", cwd: root })}\n`,
	);

	const db = openDb(agentDir);
	assert.equal(
		ingestSessionFile(db, noCwd, (c) => (c === root ? projectId : null)).status,
		"orphan",
		"empty cwd → orphan",
	);
	const okRes = ingestSessionFile(db, noTs, (c) =>
		c === root ? projectId : null,
	);
	assert.equal(okRes.status, "ingested", "missing timestamp ok");
	db.close();
});

test("search: session rows without a project render bare headers", () => {
	const db = openDb(agentDir);
	db
		.prepare(
			"INSERT INTO sessions (id, project_id, file_path, cwd, ts, parent_session, name, file_mtime_ms, size_bytes, ingested_at) VALUES ('nop-1', NULL, '/x', NULL, NULL, NULL, 'loose session', 0, 0, ?)",
		)
		.run(new Date().toISOString());
	db
		.prepare(
			"INSERT INTO session_fts (text, session_id, seq, role) VALUES ('floating needle text', 'nop-1', 0, 'user')",
		)
		.run();
	db
		.prepare(
			"INSERT INTO session_entries (session_id, seq, ts, type, entry_id, parent_id, json) VALUES ('nop-1', 0, NULL, 'message', NULL, NULL, ?)",
		)
		.run(
			JSON.stringify({
				type: "message",
				id: "e",
				message: { role: "user", content: "floating needle text" },
			}),
		);

	const hits = searchSessionsWithContext(db, "floating needle");
	assert.equal(hits.length, 1);
	assert.equal(hits[0]!.projectSlug, null);
	assert.equal(hits[0]!.name, "loose session");
	db.close();
});

test("library: numeric message content renders empty without crashing", () => {
	const store = `${area}/numstore`;
	mkdirSync(store, { recursive: true });
	const file = join(store, "num.jsonl");
	const ts = new Date().toISOString();
	writeFileSync(
		file,
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "num-0000000001",
				timestamp: ts,
				cwd: resolve("/x"),
			}),
			JSON.stringify({
				type: "message",
				id: "n1",
				parentId: null,
				timestamp: ts,
				message: { role: "user", content: 42, timestamp: 1 },
			}),
		].join("\n") + "\n",
	);
	const text = renderMessages(parseSessionFile(file)!, 0, 10);
	assert.ok(text.includes("#1 user"));
	assert.ok(text.includes("(empty)"), "numeric content renders empty");
});

test("sessions: invalid first line skips the whole file", () => {
	const store = `${area}/badfirst`;
	mkdirSync(store, { recursive: true });
	writeFileSync(
		join(store, "bad.jsonl"),
		'garbage first line\n{"type":"message"}\n',
	);
	assert.deepEqual(listSessions(store), []);
});

test("cli: search --context with junk is ignored; --project at argv end", async () => {
	const root = fakeRepo(area, "argquirk", "git");
	await main([], deps(root));
	assert.equal(
		await main(["search", "anything", "--context", "abc"], deps(root)),
		0,
	); // junk context ignored
	// --project as final token: value undefined → treated as launch passthrough? projectsCmd guard:
	assert.equal(await main(["sessions", "list", "--project"], deps(root)), 0); // missing value → falls back to cwd project
});
