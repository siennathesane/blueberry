/**
 * blueberry.db — the single state file (DESIGN.md §Data).
 *
 * SQLite (WAL, 0600) holding projects, todos, todo events, ingested session
 * history + FTS, and pi configs (settings/auth). Everything else on disk is
 * a materialized cache or a marker file.
 *
 * node:sqlite (stable in Node 24) is synchronous — fine for CLI and jiti.
 */
import { DatabaseSync } from "node:sqlite";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Project, Registry } from "./registry.ts";
import { getRegistryPath } from "./agent-dir.ts";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  canonical_path TEXT NOT NULL,
  git_remote TEXT,
  session_store TEXT NOT NULL DEFAULT 'central',
  merged_into TEXT,
  trusted INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS aliases (
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (project_id, path)
);
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  track TEXT,
  stage TEXT NOT NULL DEFAULT 'todo',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT
);
CREATE TABLE IF NOT EXISTS todo_deps (
  todo_id TEXT NOT NULL,
  dep_id TEXT NOT NULL,
  PRIMARY KEY (todo_id, dep_id)
);
CREATE TABLE IF NOT EXISTS todo_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ts TEXT NOT NULL,
  session_id TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_id, stage);
CREATE INDEX IF NOT EXISTS idx_events_todo ON todo_events(todo_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_session ON todo_events(session_id);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  file_path TEXT NOT NULL,
  cwd TEXT,
  ts TEXT,
  parent_session TEXT,
  name TEXT,
  file_mtime_ms INTEGER,
  size_bytes INTEGER,
  ingested_at TEXT
);
CREATE TABLE IF NOT EXISTS session_entries (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT,
  type TEXT NOT NULL,
  entry_id TEXT,
  parent_id TEXT,
  json TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
  text, session_id UNINDEXED, seq UNINDEXED, role UNINDEXED
);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(
  text, path UNINDEXED, line UNINDEXED
);
CREATE TABLE IF NOT EXISTS designs (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  slug TEXT,
  path TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  supersedes TEXT,
  superseded_by TEXT,
  file_mtime_ms INTEGER,
  ingested_at TEXT
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  design_id TEXT,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  rev INTEGER NOT NULL DEFAULT 1,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  seeded_at TEXT,
  seeded_count INTEGER
);
CREATE TABLE IF NOT EXISTS cmd_graphs (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  name TEXT,
  origin TEXT NOT NULL DEFAULT 'adhoc',
  status TEXT NOT NULL DEFAULT 'defined',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cmd_nodes (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT,
  env TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  pid INTEGER,
  started_at TEXT,
  ended_at TEXT,
  exit_code INTEGER
);
CREATE TABLE IF NOT EXISTS cmd_edges (
  node_id TEXT NOT NULL,
  dep_id TEXT NOT NULL,
  PRIMARY KEY (node_id, dep_id)
);
CREATE TABLE IF NOT EXISTS cmd_output (
  node_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  stream TEXT NOT NULL,
  text TEXT NOT NULL,
  ts TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (node_id, seq)
);
CREATE TABLE IF NOT EXISTS cmd_templates (
  name TEXT PRIMARY KEY,
  params TEXT NOT NULL DEFAULT '[]',
  nodes TEXT NOT NULL,
  edges TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
  text, source UNINDEXED, uri UNINDEXED
);
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS config_state (
  key TEXT PRIMARY KEY,
  last_synced TEXT
);
`;

export function dbPath(agentDir: string): string {
	return join(agentDir, "blueberry.db");
}

/** Convenience: load the registry straight from the state DB (opens + closes). */
export function loadRegistrySync(agentDir: string): Registry {
	const db = openDb(agentDir);
	try {
		return loadRegistryDb(db);
	} finally {
		db.close();
	}
}

/** Convenience: save the registry into the state DB (opens + closes). */
export function saveRegistrySync(agentDir: string, registry: Registry): void {
	const db = openDb(agentDir);
	try {
		saveRegistryDb(db, registry);
	} finally {
		db.close();
	}
}

/**
 * Materialize pi's config files from the DB at launch time (settings.json,
 * auth.json). First encounter ingests existing files; later syncs follow the
 * last_synced rules in syncConfigFile.
 */
export function syncConfigsAtLaunch(agentDir: string): Array<[string, string]> {
	const db = openDb(agentDir);
	try {
		const out: Array<[string, string]> = [];
		for (const [key, file] of [
			["settings", "settings.json"],
			["auth", "auth.json"],
		] as const) {
			out.push([file, syncConfigFile(db, agentDir, key, file)]);
		}
		return out;
	} finally {
		db.close();
	}
}

/**
 * Open (and migrate if needed) the state DB. Creates the agent dir, applies
 * WAL + 0600, runs migrations up to SCHEMA_VERSION, and performs the one-time
 * registry.json → projects import (keeping a .imported backup).
 */
export function openDb(agentDir: string): DatabaseSync {
	mkdirSync(agentDir, { recursive: true });
	const path = dbPath(agentDir);
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec(SCHEMA);

	const existed = db
		.prepare("SELECT value FROM meta WHERE key = 'schema_version'")
		.get() as { value: string } | undefined;
	if (!existed) {
		db
			.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)")
			.run(String(SCHEMA_VERSION));
	} else if (Number(existed.value) !== SCHEMA_VERSION) {
		// v1 is the only version today; future versions migrate here
		db
			.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
			.run(String(SCHEMA_VERSION));
	}

	// one-time registry.json import
	const count = db.prepare("SELECT COUNT(*) AS n FROM projects").get() as {
		n: number;
	};
	if (count.n === 0) {
		const jsonPath = getRegistryPath(agentDir);
		if (existsSync(jsonPath)) {
			importRegistryJson(db, jsonPath);
			copyFileSync(jsonPath, `${jsonPath}.imported`);
		}
	}

	chmodSync(path, 0o600);
	return db;
}

function importRegistryJson(db: DatabaseSync, jsonPath: string): void {
	try {
		const data = JSON.parse(readFileSync(jsonPath, "utf8")) as Registry;
		if (!Array.isArray(data.projects)) return;
		const insertProject = db.prepare(
			`INSERT OR REPLACE INTO projects
			 (id, slug, canonical_path, git_remote, session_store, merged_into, trusted, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const insertAlias = db.prepare(
			"INSERT OR IGNORE INTO aliases (project_id, path) VALUES (?, ?)",
		);
		for (const p of data.projects) {
			if (typeof p.id !== "string") continue;
			insertProject.run(
				p.id,
				p.slug,
				p.canonicalPath,
				p.gitRemote ?? null,
				p.sessionStore ?? "central",
				p.mergedInto ?? null,
				p.trusted === false ? 0 : 1,
				p.createdAt ?? new Date().toISOString(),
				p.updatedAt ?? new Date().toISOString(),
			);
			for (const a of p.aliases ?? []) insertAlias.run(p.id, a);
		}
	} catch {
		// unreadable registry.json: start fresh; bb fix can reconcile from markers
	}
}

// --- registry bridge ------------------------------------------------------------

export function loadRegistryDb(db: DatabaseSync): Registry {
	const rows = db
		.prepare("SELECT * FROM projects ORDER BY created_at, slug")
		.all() as Array<Record<string, unknown>>;
	const aliasRows = db.prepare("SELECT * FROM aliases").all() as Array<
		Record<string, unknown>
	>;
	const aliasesByProject = new Map<string, string[]>();
	for (const a of aliasRows) {
		const pid = String(a["project_id"]);
		const list = aliasesByProject.get(pid) ?? [];
		list.push(String(a["path"]));
		aliasesByProject.set(pid, list);
	}
	const projects: Project[] = rows.map((r) => ({
		id: String(r["id"]),
		slug: String(r["slug"]),
		canonicalPath: String(r["canonical_path"]),
		gitRemote: (r["git_remote"] as string | null) ?? null,
		sessionStore:
			(r["session_store"] as string) === "in-repo" ? "in-repo" : "central",
		mergedInto: (r["merged_into"] as string | null) ?? null,
		trusted: r["trusted"] === 0 ? false : true,
		createdAt: String(r["created_at"]),
		updatedAt: String(r["updated_at"]),
		aliases: aliasesByProject.get(String(r["id"])) ?? [],
	}));
	return { version: 1, projects };
}

export function saveRegistryDb(db: DatabaseSync, registry: Registry): void {
	const tx = db.prepare("BEGIN");
	const commit = db.prepare("COMMIT");
	const rollback = db.prepare("ROLLBACK");
	tx.run();
	try {
		db.prepare("DELETE FROM aliases").run();
		const existing = db.prepare("SELECT id FROM projects").all() as Array<
			Record<string, unknown>
		>;
		const existingIds = new Set(existing.map((r) => String(r["id"])));
		const keptIds = new Set(registry.projects.map((p) => p.id));
		const del = db.prepare("DELETE FROM projects WHERE id = ?");
		for (const id of existingIds) if (!keptIds.has(id)) del.run(id);

		const up = db.prepare(
			`INSERT INTO projects (id, slug, canonical_path, git_remote, session_store, merged_into, trusted, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   slug = excluded.slug,
			   canonical_path = excluded.canonical_path,
			   git_remote = excluded.git_remote,
			   session_store = excluded.session_store,
			   merged_into = excluded.merged_into,
			   trusted = excluded.trusted,
			   updated_at = excluded.updated_at`,
		);
		const insertAlias = db.prepare(
			"INSERT OR IGNORE INTO aliases (project_id, path) VALUES (?, ?)",
		);
		for (const p of registry.projects) {
			up.run(
				p.id,
				p.slug,
				p.canonicalPath,
				p.gitRemote ?? null,
				p.sessionStore,
				p.mergedInto ?? null,
				p.trusted === false ? 0 : 1,
				p.createdAt,
				p.updatedAt,
			);
			for (const a of p.aliases) insertAlias.run(p.id, a);
		}
		commit.run();
	} catch (err) {
		rollback.run();
		throw err;
	}
}

// --- config (settings / auth) ----------------------------------------------------

export function getConfigJson(db: DatabaseSync, key: string): string | null {
	const row = db.prepare("SELECT json FROM config WHERE key = ?").get(key) as
		| { json: string }
		| undefined;
	return row?.json ?? null;
}

export function setConfigJson(
	db: DatabaseSync,
	key: string,
	json: string,
): void {
	db
		.prepare(
			"INSERT INTO config (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json",
		)
		.run(key, json);
}

/** Ingest an on-disk config file into the config table (no-op if absent or already stored). */
export function ingestConfigFile(
	db: DatabaseSync,
	agentDir: string,
	key: string,
	fileName: string,
): boolean {
	const file = join(agentDir, fileName);
	if (!existsSync(file)) return false;
	const existing = getConfigJson(db, key);
	if (existing !== null) return false; // db wins until materialization changes
	try {
		const raw = readFileSync(file, "utf8");
		JSON.parse(raw); // validate
		setConfigJson(db, key, raw);
		return true;
	} catch {
		return false;
	}
}

/**
 * Materialize a config file from the DB. File mtime newer than last ingest →
 * re-ingest instead (pi mutated it mid-session); otherwise write DB → disk.
 * Returns "materialized" | "ingested" | "absent".
 */
export function syncConfigFile(
	db: DatabaseSync,
	agentDir: string,
	key: string,
	fileName: string,
): "materialized" | "ingested" | "absent" {
	const file = join(agentDir, fileName);
	const stored = getConfigJson(db, key);
	const stateRow = db
		.prepare("SELECT last_synced FROM config_state WHERE key = ?")
		.get(key) as { last_synced: string | null } | undefined;
	const lastSynced = stateRow?.last_synced ?? null;
	const setState = (v: string | null) =>
		db
			.prepare(
				"INSERT INTO config_state (key, last_synced) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET last_synced = excluded.last_synced",
			)
			.run(key, v);

	if (!existsSync(file)) {
		if (stored === null) return "absent";
		writeFileSync(file, stored, { mode: 0o600 });
		setState(stored);
		return "materialized";
	}

	let fileRaw: string;
	try {
		fileRaw = readFileSync(file, "utf8");
		JSON.parse(fileRaw);
	} catch {
		// corrupt file: if we have a stored value, repair it; else leave alone
		if (stored !== null) {
			writeFileSync(file, stored, { mode: 0o600 });
			setState(stored);
			return "materialized";
		}
		return "absent";
	}

	if (stored === null) {
		setConfigJson(db, key, fileRaw);
		setState(fileRaw);
		return "ingested";
	}

	if (fileRaw === stored) {
		setState(stored);
		return "materialized"; // in sync
	}

	// both present, differing: whichever matches last_synced is the stale one
	if (fileRaw === lastSynced) {
		// file unchanged since last sync -> the DB is newer -> materialize
		writeFileSync(file, stored, { mode: 0o600 });
		setState(stored);
		return "materialized";
	}
	// file changed since last sync -> pi wins -> ingest
	setConfigJson(db, key, fileRaw);
	setState(fileRaw);
	return "ingested";
}
