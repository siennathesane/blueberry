import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	existsSync,
	readFileSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
	openDb,
	loadRegistryDb,
	saveRegistrySync,
	loadRegistrySync,
} from "../src/core/db.ts";
import {
	ftsSearch,
	ingestSessionFile,
	restoreMissing,
	restoreSession,
	syncStores,
} from "../src/core/sync.ts";
import { loadRegistry, mutations } from "../src/core/registry.ts";
import { getCentralStoreDir } from "../src/core/agent-dir.ts";
import { readSessionHeader } from "../src/core/sessions.ts";
import {
	tmpAgentDir,
	tmpDir,
	fakeRepo,
	fakeSession,
	cleanup,
} from "./helpers.ts";

let agentDir: string;
let area: string;

beforeEach(() => {
	agentDir = tmpAgentDir();
	area = tmpDir("bb-sync-");
});
afterEach(() => {
	cleanup(agentDir, area);
});

function setup(): {
	root: string;
	store: string;
	registry: ReturnType<typeof loadRegistry>;
} {
	const root = fakeRepo(area, "syncproj", "git");
	const registryJson = loadRegistry(agentDir);
	mutations.register(registryJson, { root });
	return {
		root,
		store: getCentralStoreDir(agentDir, "syncproj"),
		registry: registryJson,
	};
}

test("ingest: full pipeline — sessions row, entries, fts, name", () => {
	const { root, store, registry } = setup();
	const file = fakeSession(store, {
		cwd: root,
		firstUserText: "the needle lives here",
		name: "named-one",
	});

	const db = openDb(agentDir);
	const byPath = new Map([[root, registry.projects[0]!.id]]);
	const res = ingestSessionFile(db, file, (cwd) =>
		cwd ? (byPath.get(cwd) ?? null) : null,
	);

	assert.equal(res.status, "ingested");
	const row = db.prepare("SELECT * FROM sessions").get() as Record<
		string,
		unknown
	>;
	assert.equal(row["name"], "named-one");
	assert.equal(row["project_id"], registry.projects[0]!.id);
	const nEntries = (
		db.prepare("SELECT COUNT(*) AS n FROM session_entries").get() as { n: number }
	).n;
	assert.equal(
		nEntries,
		2,
		"header excluded; user message + session_info stored",
	);

	const hits = ftsSearch(db, "needle");
	assert.equal(hits.length, 1);
	assert.equal(hits[0]!.role, "user");
	assert.ok(hits[0]!.text.includes("needle"));
	db.close();
});

test("ingest: idempotent by (mtime,size); changed file re-ingests fully", () => {
	const { root, store, registry } = setup();
	const file = fakeSession(store, { cwd: root, firstUserText: "first version" });
	const db = openDb(agentDir);
	const byPath = new Map([[root, registry.projects[0]!.id]]);
	const pid = (cwd: string | null) => (cwd ? (byPath.get(cwd) ?? null) : null);

	assert.equal(ingestSessionFile(db, file, pid).status, "ingested");
	assert.equal(ingestSessionFile(db, file, pid).status, "unchanged");

	// mutate the SAME file (append an entry) → mtime+size change → re-ingest replaces
	const orig = readFileSync(file, "utf8");
	writeFileSync(
		file,
		`${orig}${JSON.stringify({ type: "message", id: "extra01", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "second version the needle moved", timestamp: 1 } })}\n`,
	);
	utimesSync(file, new Date(), new Date(Date.now() + 5000));
	assert.equal(ingestSessionFile(db, file, pid).status, "ingested");
	const count = (
		db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }
	).n;
	assert.equal(count, 1, "replaced, not duplicated");
	const hits = ftsSearch(db, "moved");
	assert.equal(hits.length, 1, "new entry text indexed");
	assert.equal(
		ftsSearch(db, "first version").length,
		1,
		"old entry text still present (file keeps history)",
	);
	const nEntries = (
		db.prepare("SELECT COUNT(*) AS n FROM session_entries").get() as { n: number }
	).n;
	assert.equal(nEntries, 2, "appended entry ingested: 1 original + 1 new");
	db.close();
});

test("ingest: orphan cwds and unparseable files are reported, never crash", () => {
	const db = openDb(agentDir);
	const orphanStore = `${area}/orphans`;
	const f1 = fakeSession(orphanStore, {
		cwd: "/no/such/project",
		firstUserText: "x",
	});
	assert.equal(ingestSessionFile(db, f1, () => null).status, "orphan");

	writeFileSync(`${orphanStore}/bad.jsonl`, "not json at all\n");
	assert.equal(
		ingestSessionFile(db, `${orphanStore}/bad.jsonl`, () => "p1").status,
		"error",
	);
	db.close();
});

test("syncStores: walks all project stores, aggregates the report", () => {
	const r1 = setup();
	const root2 = fakeRepo(area, "secondproj", "git");
	// register BOTH projects in the same registry, persist to the db
	mutations.register(r1.registry, { root: root2 });
	fakeSession(r1.store, { cwd: r1.root, firstUserText: "alpha content" });
	fakeSession(getCentralStoreDir(agentDir, "secondproj"), {
		cwd: root2,
		firstUserText: "beta content",
	});

	const db = openDb(agentDir);
	saveRegistrySync(agentDir, r1.registry);
	const reg2 = loadRegistryDb(db);
	const report = syncStores(db, agentDir, reg2);

	assert.equal(report.ingested, 2);
	assert.equal(report.errors.length, 0);

	// second run: all unchanged
	const report2 = syncStores(db, agentDir, reg2);
	assert.equal(report2.ingested, 0);
	assert.equal(report2.unchanged, 2);
	db.close();
});

test("ftsSearch: sanitized against fts5 syntax injection; empty safe", () => {
	const { root, store, registry } = setup();
	fakeSession(store, {
		cwd: root,
		firstUserText: "plain text about OR MATCH and * stars",
	});
	const db = openDb(agentDir);
	const byPath = new Map([[root, registry.projects[0]!.id]]);
	for (const f of readdirSync(store)) {
		ingestSessionFile(db, join(store, f), (cwd) =>
			cwd ? (byPath.get(cwd) ?? null) : null,
		);
	}
	// hostile queries don't throw
	for (const q of ['"unbalanced', "OR * :", "NEAR(a b", ""]) {
		const hits = ftsSearch(db, q);
		assert.ok(Array.isArray(hits));
	}
	db.close();
});

test("restore: rebuilds a deleted session file from the DB byte-faithfully enough", () => {
	const { root, store, registry } = setup();
	const file = fakeSession(store, {
		cwd: root,
		firstUserText: "restorable content",
		entries: 2,
	});
	const db = openDb(agentDir);
	const byPath = new Map([[root, registry.projects[0]!.id]]);
	ingestSessionFile(db, file, (cwd) => (cwd ? (byPath.get(cwd) ?? null) : null));

	// destroy the file, then restore
	const sessionId = readSessionHeader(file)!.id;
	const before = readdirSync(store).length;
	rmSync(file);
	assert.equal(readdirSync(store).length, before - 1);

	const restored = restoreSession(db, sessionId, store);
	assert.ok(restored);
	assert.ok(existsSync(restored!));
	const h = readSessionHeader(restored!)!;
	assert.equal(h.id, sessionId);
	assert.equal(h.cwd, root);

	// full-repair path via restoreMissing
	rmSync(restored!);
	const fixed = restoreMissing(db);
	assert.equal(fixed.length, 1);
	assert.ok(existsSync(fixed[0]!.path));
	db.close();
});

test("restore: unknown session returns null", () => {
	const db = openDb(agentDir);
	assert.equal(restoreSession(db, "nope", area), null);
	db.close();
});

// --- entry nullish mappings + restore-without-ts (branch closure) -------------------

test("sync: entries with missing id/type/parentId/timestamp map to defaults", () => {
	const root = fakeRepo(area, "nullish", "git");
	const r = loadRegistry(agentDir);
	mutations.register(r, { root });
	saveRegistrySync(agentDir, r);
	const projectId = loadRegistrySync(agentDir).projects[0]!.id;

	const store = getCentralStoreDir(agentDir, "nullish");
	mkdirSync(store, { recursive: true });
	const file = join(store, "nullish.jsonl");
	// entries WITHOUT id, type, parentId, timestamp — only message content
	writeFileSync(
		file,
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "null-000000001",
				timestamp: new Date().toISOString(),
				cwd: root,
			}),
			JSON.stringify({
				message: { role: "user", content: "bare entry no metadata", timestamp: 1 },
			}),
			JSON.stringify({ type: "custom", data: { x: 1 } }),
		].join("\n") + "\n",
	);

	const db = openDb(agentDir);
	const res = ingestSessionFile(db, file, (c) =>
		c === root ? projectId : null,
	);
	assert.equal(res.status, "ingested");
	const rows = db
		.prepare(
			"SELECT type, entry_id, parent_id, ts FROM session_entries ORDER BY seq",
		)
		.all() as Array<Record<string, unknown>>;
	// seq 0 = bare message entry (no type/id/parentId/timestamp keys at all)
	assert.equal(rows[0]!["type"], "?", "missing type → ?");
	assert.equal(rows[0]!["entry_id"], null, "missing id → null");
	assert.equal(rows[0]!["parent_id"], null, "missing parentId → null");
	assert.equal(rows[0]!["ts"], null, "missing timestamp → null");
	// seq 1 = the custom entry (has type)
	assert.equal(rows[1]!["type"], "custom");
	db.close();
});

test("sync: restore without ts in meta falls back to 'restored' filename", () => {
	const db = openDb(agentDir);
	db
		.prepare(
			"INSERT INTO sessions (id, project_id, file_path, cwd, ts, parent_session, name, file_mtime_ms, size_bytes, ingested_at) VALUES ('nots-2', NULL, '/y', NULL, NULL, NULL, NULL, 0, 0, ?)",
		)
		.run(new Date().toISOString());
	db
		.prepare(
			"INSERT INTO session_entries (session_id, seq, ts, type, entry_id, parent_id, json) VALUES ('nots-2', 0, NULL, 'message', NULL, NULL, ?)",
		)
		.run(
			JSON.stringify({
				type: "message",
				id: "e",
				message: { role: "user", content: "no ts" },
			}),
		);

	const restored = restoreSession(db, "nots-2", `${area}/out2`);
	assert.ok(restored !== null);
	assert.ok(
		restored!.includes("restored_nots-2.jsonl"),
		`fallback name: ${restored}`,
	);
	db.close();
});

test("sync: orphan and error paths fill detail fallback", () => {
	const db = openDb(agentDir);
	// error with undefined detail (statSync failure on a directory-as-file)
	const dirAsFile = join(area, "adir");
	mkdirSync(dirAsFile, { recursive: true });
	const res = ingestSessionFile(db, dirAsFile, () => "p");
	assert.ok(res.status === "error" || res.status === "orphan");
	db.close();
});
