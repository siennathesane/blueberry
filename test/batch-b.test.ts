/**
 * Coverage closure batch B — store/manager error arms (real signatures).
 * fix.ts: clean-world run. sync.ts: error/unchanged/orphan/restore arms.
 * registry.ts: uniqueSlug suffixing. resolution.ts: mint arm.
 * todo-store.ts: self-dep/missing-dep refusal. lsp-manager: no-op safety.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, loadRegistrySync } from "../src/core/db.ts";
import { runFix } from "../src/core/fix.ts";
import { ingestSessionFile, restoreSession } from "../src/core/sync.ts";
import { uniqueSlug } from "../src/core/registry.ts";
import { resolveProject } from "../src/core/resolution.ts";
import { addDep, createTodo, hex6Of } from "../src/core/todo-store.ts";
import { tmpAgentDir, tmpDir, cleanup } from "./helpers.ts";

let agentDir: string;
let area: string;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
	agentDir = tmpAgentDir();
	area = tmpDir("bb-batchb-");
	db = openDb(agentDir);
});

afterEach(() => {
	db.close();
	cleanup(area);
});

// --- fix.ts ---------------------------------------------------------------------------

test("fix: runFix on a fresh registry is safe", () => {
	const registry = loadRegistrySync(agentDir);
	const report = runFix(registry, agentDir);
	assert.ok(report !== undefined);
});

test("fix: runFix dry-run arm", () => {
	const registry = loadRegistrySync(agentDir);
	const report = runFix(registry, agentDir, { dryRun: true });
	assert.ok(report !== undefined);
});

// --- sync.ts --------------------------------------------------------------------------

test("sync: ingest of a nonexistent file reports error", () => {
	const r1 = ingestSessionFile(db, join(area, "gone.jsonl"), () => null);
	assert.equal(r1.status, "error");
});

test("sync: mtime-identical re-ingest is unchanged; orphan refused without flag", () => {
	const file = join(area, "s.jsonl");
	mkdirSync(area, { recursive: true });
	writeFileSync(
		file,
		'{"type":"session","version":3,"id":"syn1","timestamp":"2026-01-01T00:00:00Z","cwd":"' + area + '"}\n' +
			'{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"hello"}}\n',
	);
	db.prepare(
		"INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES ('pj', 'pj', ?, ?, ?)",
	).run(area, new Date().toISOString(), new Date().toISOString());
	const byCwd = (cwd: string | null) => (cwd === area ? "pj" : null);
	assert.equal(ingestSessionFile(db, file, byCwd).status, "ingested");
	assert.equal(ingestSessionFile(db, file, byCwd).status, "unchanged");

	const orph = join(area, "orph.jsonl");
	writeFileSync(
		orph,
		'{"type":"session","version":3,"id":"orph1","timestamp":"2026-01-01T00:00:00Z","cwd":"/nowhere"}\n' +
			'{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"x"}}\n',
	);
	assert.equal(ingestSessionFile(db, orph, () => null).status, "orphan");
});

test("sync: restoreSession rebuilds JSONL from ingested rows", () => {
	const file = join(area, "rest.jsonl");
	writeFileSync(
		file,
		'{"type":"session","version":3,"id":"rest1","timestamp":"2026-01-01T00:00:00Z","cwd":"' + area + '"}\n' +
			'{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"restore me"}}\n',
	);
	db.prepare(
		"INSERT INTO projects (id, slug, canonical_path, session_store, created_at, updated_at) VALUES ('pj2', 'pj2', ?, 'repo', ?, ?)",
	).run(area, new Date().toISOString(), new Date().toISOString());
	ingestSessionFile(db, file, () => "pj2");
	rmSync(file);
	// restoreSession takes a target DIRECTORY and returns the written path
	const dir = join(area, "restored");
	const written = restoreSession(db, "rest1", dir);
	assert.ok(written, "returns the written file path");
	const rebuilt = readFileSync(written!, "utf8");
	assert.ok(rebuilt.includes("restore me"));
	// header rebuilt from the sessions row
	assert.ok(rebuilt.includes('"id":"rest1"'));
});

// --- registry.ts ----------------------------------------------------------------------

test("registry: uniqueSlug suffixes on collision (base, base-2 → base-3)", () => {
	const registry = {
		version: 1,
		projects: [
			{ slug: "base", id: "a" },
			{ slug: "base-2", id: "b" },
		],
	} as unknown as Parameters<typeof uniqueSlug>[0];
	assert.equal(uniqueSlug(registry, "base"), "base-3");
});

// --- resolution.ts --------------------------------------------------------------------

test("resolution: unknown cwd mints a fresh project", () => {
	const registry = loadRegistrySync(agentDir);
	const res = resolveProject({ cwd: area, registry });
	assert.ok(res.project);
});

// --- todo-store.ts --------------------------------------------------------------------

test("todo-store: self-dep and missing-dep refused", () => {
	db.prepare(
		"INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES ('tp', 'tp', ?, ?, ?)",
	).run(area, new Date().toISOString(), new Date().toISOString());
	const t1 = createTodo(db, "tp", "one");
	assert.ok(t1.ok && t1.todo, "todo created");
	const hex1 = hex6Of(t1.todo!.id);
	// self-dep: refused via MutationResult, not a throw
	const self = addDep(db, "tp", hex1, hex1);
	assert.ok(!self.ok);
	assert.match(self.reason ?? "", /itself/);
	// missing dep: refused
	const ghost = addDep(db, "tp", hex1, "zzzzzz");
	assert.ok(!ghost.ok);
	assert.match(ghost.reason ?? "", /no todo/);
});

// --- lsp-manager ----------------------------------------------------------------------

test("lsp-manager: changeFile/dispose without servers are safe no-ops", async () => {
	const { LspManager } = await import("../src/core/lsp-manager.ts");
	const mgr = new LspManager(area, { maxServers: 0 });
	await mgr.changeFile(join(area, "x.rs"));
	mgr.dispose();
});
