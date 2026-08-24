import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	dbPath,
	getConfigJson,
	ingestConfigFile,
	loadRegistryDb,
	openDb,
	saveRegistryDb,
	setConfigJson,
	syncConfigFile,
	SCHEMA_VERSION,
} from "../src/core/db.ts";
import { loadRegistry, mutations, saveRegistry } from "../src/core/registry.ts";
import { tmpAgentDir, cleanup } from "./helpers.ts";

let agentDir: string;

beforeEach(() => {
	agentDir = tmpAgentDir();
});
afterEach(() => {
	cleanup(agentDir);
});

test("openDb: creates schema, meta, WAL mode", () => {
	const db = openDb(agentDir);
	const meta = db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version") as {
		value: string;
	};
	assert.equal(Number(meta.value), SCHEMA_VERSION);

	const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
	assert.equal(mode.journal_mode.toLowerCase(), "wal");

	const tables = (
		db.prepare("SELECT name FROM sqlite_master WHERE type='table' OR type='view' ORDER BY name").all() as Array<{
			name: string;
		}>
	).map((r) => r.name);
	for (const t of [
		"projects",
		"aliases",
		"todos",
		"todo_deps",
		"todo_events",
		"sessions",
		"session_entries",
		"config",
		"meta",
	]) {
		assert.ok(tables.includes(t), `table ${t} exists`);
	}
	assert.ok(tables.includes("session_fts"), "fts5 virtual table exists");

	db.close();
	assert.ok(existsSync(dbPath(agentDir)));
});

test("openDb: idempotent — second open keeps data and meta", () => {
	const db1 = openDb(agentDir);
	db1.prepare("INSERT INTO config (key, json) VALUES ('k', '1')").run();
	db1.close();
	const db2 = openDb(agentDir);
	assert.equal(getConfigJson(db2, "k"), "1");
	db2.close();
});

test("registry bridge: save → load round-trips projects and aliases", () => {
	const db = openDb(agentDir);
	const r = loadRegistry(agentDir);
	mutations.register(r, { root: "/x/alpha" });
	mutations.register(r, { root: "/y/beta", gitRemote: "https://github.com/u/beta" });
	mutations.setNested(r, "beta", "alpha");
	mutations.setStoreMode(agentDir, r, "beta", "in-repo");

	saveRegistryDb(db, r);
	const loaded = loadRegistryDb(db);
	assert.equal(loaded.projects.length, 2);
	const alpha = loaded.projects.find((p) => p.slug === "alpha")!;
	const beta = loaded.projects.find((p) => p.slug === "beta")!;
	assert.equal(alpha.canonicalPath, "/x/alpha");
	assert.equal(beta.gitRemote, "https://github.com/u/beta");
	assert.equal(beta.sessionStore, "in-repo");
	assert.equal(beta.mergedInto, alpha.id);
	assert.deepEqual(beta.aliases, []);

	// deletion propagates on next save
	const r2 = { version: 1 as const, projects: loaded.projects.filter((p) => p.slug === "alpha") };
	saveRegistryDb(db, r2);
	assert.equal(loadRegistryDb(db).projects.length, 1);
	db.close();
});

test("openDb: one-time registry.json import with backup", async () => {
	// seed a registry.json BEFORE first db open
	const r = loadRegistry(agentDir);
	const p = mutations.register(r, { root: "/x/imported" });
	mutations.reattach(r, p, "/x/moved");
	await saveRegistry(agentDir, r);

	const db = openDb(agentDir);
	const loaded = loadRegistryDb(db);
	assert.equal(loaded.projects.length, 1);
	assert.equal(loaded.projects[0]!.canonicalPath, "/x/moved");
	assert.ok(loaded.projects[0]!.aliases.includes("/x/imported"));
	assert.ok(existsSync(join(agentDir, "registry.json.imported")), "backup written");
	db.close();
});

test("config: set/get round-trip; ingest picks up files; sync materializes", () => {
	const db = openDb(agentDir);
	setConfigJson(db, "settings", '{"theme":"blueberry"}');
	assert.equal(getConfigJson(db, "settings"), '{"theme":"blueberry"}');

	// absent file + stored value → materialized
	const res = syncConfigFile(db, agentDir, "settings", "settings.json");
	assert.equal(res, "materialized");
	assert.ok(existsSync(join(agentDir, "settings.json")));
	assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), '{"theme":"blueberry"}');

	// empty db key + existing valid file → ingested
	writeFileSync(join(agentDir, "auth.json"), '{"zai":{"key":"k"}}');
	const res2 = syncConfigFile(db, agentDir, "auth", "auth.json");
	assert.equal(res2, "ingested");
	assert.equal(getConfigJson(db, "auth"), '{"zai":{"key":"k"}}');

	// pi mutates the file mid-session → file wins on next sync
	writeFileSync(join(agentDir, "auth.json"), '{"zai":{"key":"k2"}}');
	const res3 = syncConfigFile(db, agentDir, "auth", "auth.json");
	assert.equal(res3, "ingested");
	assert.equal(getConfigJson(db, "auth"), '{"zai":{"key":"k2"}}');

	// db newer (bb wrote config), file stale → materialized
	setConfigJson(db, "auth", '{"zai":{"key":"k3"}}');
	const res4 = syncConfigFile(db, agentDir, "auth", "auth.json");
	assert.equal(res4, "materialized");
	assert.equal(readFileSync(join(agentDir, "auth.json"), "utf8"), '{"zai":{"key":"k3"}}');

	// absent both → absent
	const res5 = syncConfigFile(db, agentDir, "nothing", "nope.json");
	assert.equal(res5, "absent");

	// corrupt file with no stored value → absent, file untouched
	writeFileSync(join(agentDir, "broken.json"), "not json");
	const res6 = syncConfigFile(db, agentDir, "broken", "broken.json");
	assert.equal(res6, "absent");
	db.close();
});

test("ingestConfigFile: skips absent, skips when already stored, validates JSON", () => {
	const db = openDb(agentDir);
	assert.equal(ingestConfigFile(db, agentDir, "a", "a.json"), false);
	writeFileSync(join(agentDir, "a.json"), '{"x":1}');
	assert.equal(ingestConfigFile(db, agentDir, "a", "a.json"), true);
	assert.equal(ingestConfigFile(db, agentDir, "a", "a.json"), false); // already stored
	writeFileSync(join(agentDir, "bad.json"), "{oops");
	assert.equal(ingestConfigFile(db, agentDir, "bad", "bad.json"), false);
	db.close();
});
