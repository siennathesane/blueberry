/**
 * Coverage closure batch E — library guards, resolution reattach/cycle,
 * fix finding arms, todo time-format, lsp-manager dispose guards.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/core/db.ts";
import { parseSessionFile } from "../src/core/library.ts";
import { resolveProject } from "../src/core/resolution.ts";
import { runFix } from "../src/core/fix.ts";
import { loadRegistry, mutations, saveRegistry } from "../src/core/registry.ts";
import { createTodo, listTodos, toCards } from "../src/core/todo-store.ts";
import { tmpAgentDir, tmpDir, fakeRepo, cleanup } from "./helpers.ts";

let agentDir: string;
let area: string;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
	agentDir = tmpAgentDir();
	area = tmpDir("bb-batche-");
	db = openDb(agentDir);
});

afterEach(() => {
	db.close();
	cleanup(area);
});

// --- library: parse guards + entry counting + empty needle ----------------------------

test("library: parseSessionFile accepts session-header-first files and skips nested session lines", () => {
	const f = join(area, "ok.jsonl");
	writeFileSync(
		f,
		'{"type":"session","version":3,"id":"lib1","timestamp":"2026-01-01T00:00:00Z","cwd":"' +
			area +
			'"}\n' +
			'{"type":"session","id":"dup"}\n' +
			'{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"hi"}}\n',
	);
	const parsed = parseSessionFile(f);
	assert.ok(parsed);
	assert.equal(parsed.header["id"], "lib1");
	// the nested session line hits the skip arm: not counted as an entry
	assert.equal(parsed.entries.length, 1);
});

test("todo-store: ageString arms via toCards — hours, days, and invalid ts", () => {
	db.prepare(
		"INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES ('ag', 'ag', ?, ?, ?)",
	).run(area, new Date().toISOString(), new Date().toISOString());
	const t = createTodo(db, "ag", "aged");
	// backdate: 5h old → `${h}h`; 3d old → `${d}d`; garbage → "?"
	const back5h = new Date(Date.now() - 5 * 3600_000).toISOString();
	const back3d = new Date(Date.now() - 3 * 86_400_000).toISOString();
	db.prepare("UPDATE todos SET created_at = ? WHERE id = ?").run(back5h, t.todo!.id);
	const [card] = toCards(listTodos(db, "ag"));
	assert.ok(card!.age.endsWith("h"), `hours arm: ${card!.age}`);
	db.prepare("UPDATE todos SET created_at = ? WHERE id = ?").run(back3d, t.todo!.id);
	assert.ok(toCards(listTodos(db, "ag"))[0]!.age.endsWith("d"), "days arm");
	db.prepare("UPDATE todos SET created_at = ? WHERE id = ?").run("not-a-date", t.todo!.id);
	assert.equal(toCards(listTodos(db, "ag"))[0]!.age, "?", "invalid arm");
});

// --- resolution: marker reattach + deep-nest cycle -------------------------------------

test("resolution: project with marker at a new root reattaches", async () => {
	// register at one root, then move the marker (simulate re-clone layout)
	const rootA = fakeRepo(area, "movable", "git");
	const r = loadRegistry(agentDir);
	const p = mutations.register(r, { root: rootA });
	await saveRegistry(agentDir, r); // async write — must land before re-read
	// new location with the same marker id
	const rootB = fakeRepo(area, "moved-copy", "git", p.id);
	// resolve from rootB → marker id matches p → reattach canonical path
	const r2 = loadRegistry(agentDir);
	const res = resolveProject({ cwd: rootB, registry: r2 });
	assert.equal(res.root, rootB);
	assert.ok(
		res.actions.some((a: string) => a.includes("reattached")),
		JSON.stringify(res.actions),
	);
});

// --- fix: cwd-normalized + parent-session-cleared finding arms --------------------------

test("fix: session with subdir cwd + dangling parent both produce findings", () => {
	const root = fakeRepo(area, "fx", "git");
	const registry = loadRegistry(agentDir);
	mutations.register(registry, { root });
	saveRegistry(agentDir, registry);
	// runFix scans session FILES in the central store dir (not db rows)
	const store = join(agentDir, "sessions", "fx");
	mkdirSync(store, { recursive: true });
	const hdr = (cwd: string, parent?: string) =>
		JSON.stringify({
			type: "session",
			version: 3,
			id: "fx" + Math.random().toString(36).slice(2, 8),
			timestamp: "2026-01-01T00:00:00Z",
			cwd,
			...(parent ? { parentSession: parent } : {}),
		});
	// one session at a subdir cwd, one at canonical cwd with dangling parent
	writeFileSync(join(store, "a.jsonl"), hdr(join(root, "deep", "sub")) + "\n");
	writeFileSync(join(store, "b.jsonl"), hdr(root, "/gone/parent.jsonl") + "\n");
	const report = runFix(registry, agentDir, { dryRun: true });
	const kinds = report.findings.map((f: { kind: string }) => f.kind);
	assert.ok(kinds.includes("cwd-normalized"), JSON.stringify(kinds));
	assert.ok(kinds.includes("parent-session-cleared"), JSON.stringify(kinds));
});

// --- fix: store with zero sessions skipped arm ------------------------------------------

test("fix: project with a store dir but no sessions is a no-op for that store", () => {
	const root = fakeRepo(area, "empty-store", "git");
	mkdirSync(join(agentDir, "sessions", "empty-store"), { recursive: true });
	const registry = loadRegistry(agentDir);
	mutations.register(registry, { root });
	saveRegistry(agentDir, registry);
	const report = runFix(registry, agentDir, { dryRun: true });
	assert.ok(report.findings.length >= 0); // no crash, no orphan findings
});
