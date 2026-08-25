/**
 * BlueberryDbStore (FORK(blueberry)): DB-only session persistence.
 *
 * All session writes land in ~/.blueberry/blueberry.db. JSONL becomes an
 * export format (blueberry's `bb restore`/`bb export`), never a live path.
 *
 * SCHEMA CONTRACT: the DDL below is byte-identical to blueberry's
 * src/core/db.ts (sessions / session_entries / session_fts). Blueberry owns
 * migrations; if these tables change there, this file must follow. Both
 * sides use CREATE TABLE IF NOT EXISTS, so creation order is irrelevant.
 *
 * Concurrency: WAL + busy_timeout so `bb` CLI reads never block live pi
 * writes (and vice versa).
 *
 * Key semantics: keys are path-shaped synthetic identifiers
 * (<dir>/<timestamp>_<sessionId>, no .jsonl extension). "dir" is the
 * session dir pi computed; sessions of one project share a dir prefix,
 * which is what discovery (listKeys) filters on.
 */
import { DatabaseSync } from "node:sqlite";
import { join, resolve as resolvePath, sep } from "node:path";
import type { FileEntry, SessionEntry, SessionHeader } from "./session-manager.ts";
import type { SessionStore } from "./session-store.ts";

const DDL = [
	// projects/aliases: the store maps header cwd → project_id; on a fresh
	// DB (fork binary first, `bb` never ran) these wouldn't exist — schema is
	// byte-identical to blueberry's db.ts, IF NOT EXISTS makes order moot.
	`CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  canonical_path TEXT NOT NULL,
  git_remote TEXT,
  session_store TEXT NOT NULL DEFAULT 'central',
  merged_into TEXT,
  trusted INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS aliases (
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (project_id, path)
)`,
	`CREATE TABLE IF NOT EXISTS sessions (
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
)`,
	`CREATE TABLE IF NOT EXISTS session_entries (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT,
  type TEXT NOT NULL,
  entry_id TEXT,
  parent_id TEXT,
  json TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
)`,
	`CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
  text, session_id UNINDEXED, seq UNINDEXED, role UNINDEXED
)`,
];

/** Extract searchable text + role from an entry (parity: blueberry sync.ts entryText). */
function entryText(entry: FileEntry): { role: string; text: string } | null {
	// SAFETY: FileEntry is SessionHeader | SessionEntry, both object-literal
	// unions; string-key probing reads missing keys as undefined, never throws.
	const e = entry as unknown as Record<string, unknown>;
	if (e["type"] === "session_info") {
		const name = e["name"];
		return typeof name === "string" && name !== "" ? { role: "session_info", text: name } : null;
	}
	if (e["type"] !== "message") return null;
	const message = e["message"] as Record<string, unknown> | undefined;
	if (!message || typeof message["role"] !== "string") return null;
	const role = message["role"];
	const content = message["content"];
	let text = "";
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			if (typeof block !== "object" || block === null) continue;
			const b = block as Record<string, unknown>;
			if (b["type"] === "text" && typeof b["text"] === "string") parts.push(b["text"]);
		}
		text = parts.join("\n");
	}
	if (text.trim() === "") return null;
	return { role, text };
}

/** Normalize a path for cwd→project comparison (parity: blueberry resolution.ts). */
function normalizeForCompare(p: string): string {
	const resolved = resolvePath(p);
	const noSep = resolved.endsWith(sep) && resolved !== sep ? resolved.slice(0, -1) : resolved;
	return process.platform === "darwin" ? noSep.toLowerCase() : noSep;
}

interface SessionRow {
	id: string;
	cwd: string | null;
	ts: string | null;
	parent_session: string | null;
	ingested_at: string | null;
}

export class BlueberryDbStore implements SessionStore {
	private db: DatabaseSync;

	constructor(dbPath: string) {
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode=WAL");
		this.db.exec("PRAGMA busy_timeout=5000");
		for (const stmt of DDL) this.db.exec(stmt);
	}

	private sessionIdFor(key: string): string {
		// key = <dir>/<timestamp>_<sessionId> → last path segment after final '_'
		const base = key.slice(key.lastIndexOf("/") + 1);
		return base.slice(base.lastIndexOf("_") + 1);
	}

	private projectIdFor(cwd: string | null): string | null {
		if (cwd === null) return null;
		const target = normalizeForCompare(cwd);
		try {
			const projects = this.db.prepare("SELECT id, canonical_path FROM projects").all() as Array<{
				id: string;
				canonical_path: string;
			}>;
			for (const p of projects) {
				if (normalizeForCompare(p.canonical_path) === target) return p.id;
			}
			const aliases = this.db.prepare("SELECT project_id, path FROM aliases").all() as Array<{
				project_id: string;
				path: string;
			}>;
			for (const a of aliases) {
				if (normalizeForCompare(a.path) === target) return a.project_id;
			}
		} catch {
			// unreadable registry tables degrade to an unattributed session
			// (sessions.project_id is nullable) — persistence must not die here
		}
		return null;
	}

	private sessionRow(key: string): SessionRow | undefined {
		return this.db
			.prepare("SELECT id, cwd, ts, parent_session, ingested_at FROM sessions WHERE file_path = ?")
			.get(key) as SessionRow | undefined;
	}

	/** Write the header row (upsert) from entries[0] when it is the session header. */
	private upsertHeader(sessionId: string, key: string, header: SessionHeader): void {
		const existing = this.db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId) as
			| { id: string }
			| undefined;
		const projectId = this.projectIdFor(typeof header.cwd === "string" && header.cwd !== "" ? header.cwd : null);
		if (existing) {
			this.db
				.prepare("UPDATE sessions SET cwd = ?, ts = ?, parent_session = ?, ingested_at = ? WHERE id = ?")
				.run(
					header.cwd ?? null,
					header.timestamp ?? null,
					header.parentSession ?? null,
					new Date().toISOString(),
					sessionId,
				);
		} else {
			this.db
				.prepare(
					`INSERT INTO sessions (id, project_id, file_path, cwd, ts, parent_session, name, file_mtime_ms, size_bytes, ingested_at)
					VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
				)
				.run(
					sessionId,
					projectId,
					key,
					header.cwd ?? null,
					header.timestamp ?? null,
					header.parentSession ?? null,
					new Date().toISOString(),
				);
		}
	}

	private insertEntry(sessionId: string, seq: number, entry: SessionEntry): void {
		// SAFETY: SessionEntry is a tagged-union of object literals; probing by
		// string keys is safe on every variant (missing keys read as undefined).
		const e = entry as unknown as Record<string, unknown>;
		this.db
			.prepare(
				"INSERT INTO session_entries (session_id, seq, ts, type, entry_id, parent_id, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				sessionId,
				seq,
				typeof e["timestamp"] === "string" ? e["timestamp"] : null,
				typeof e["type"] === "string" ? e["type"] : "?",
				typeof e["id"] === "string" ? e["id"] : null,
				typeof e["parentId"] === "string" ? e["parentId"] : null,
				JSON.stringify(entry),
			);
		const extracted = entryText(entry);
		if (extracted) {
			this.db
				.prepare("INSERT INTO session_fts (text, session_id, seq, role) VALUES (?, ?, ?, ?)")
				.run(extracted.text, sessionId, seq, extracted.role);
			if (extracted.role === "session_info") {
				this.db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(extracted.text, sessionId);
			}
		}
	}

	private wipeEntries(sessionId: string): void {
		this.db.prepare("DELETE FROM session_entries WHERE session_id = ?").run(sessionId);
		this.db.prepare("DELETE FROM session_fts WHERE session_id = ?").run(sessionId);
	}

	private headerFrom(entries: FileEntry[]): { header: SessionHeader; rest: FileEntry[] } | null {
		if (entries.length === 0) return null;
		// SAFETY: duck-typing the union's discriminator before narrowing; a
		// non-object entry would read type as undefined, not throw.
		const first = entries[0] as unknown as Record<string, unknown>;
		if (first["type"] !== "session") return null;
		return { header: entries[0] as SessionHeader, rest: entries.slice(1) };
	}

	sessionKey(dir: string, fileTimestamp: string, sessionId: string): string {
		return join(dir, `${fileTimestamp}_${sessionId}`);
	}

	createNew(key: string, entries: FileEntry[]): void {
		const parsed = this.headerFrom(entries);
		if (!parsed) throw new Error(`session store: createNew without session header: ${key}`);
		const sessionId = this.sessionIdFor(key);
		if (
			this.sessionRow(key) !== undefined ||
			this.db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId)
		) {
			throw new Error(`session store: already exists: ${key}`);
		}
		this.db.prepare("BEGIN").run();
		try {
			this.upsertHeader(sessionId, key, parsed.header);
			let seq = 0;
			for (const entry of parsed.rest) {
				this.insertEntry(sessionId, seq, entry as SessionEntry);
				seq++;
			}
			this.db.prepare("COMMIT").run();
		} catch (err) {
			this.db.prepare("ROLLBACK").run();
			throw err;
		}
	}

	appendEntry(key: string, entry: FileEntry): void {
		const sessionId = this.sessionIdFor(key);
		const row = this.sessionRow(key);
		if (row === undefined) throw new Error(`session store: append to unknown session: ${key}`);
		// SAFETY: FileEntry is SessionHeader | SessionEntry — both object
		// literals; string-key probing is safe on every variant.
		const e = entry as unknown as Record<string, unknown>;
		if (e["type"] === "session") {
			// header re-append (path retarget): treat as no-op — header already stored
			return;
		}
		const seq = (
			this.db
				.prepare("SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM session_entries WHERE session_id = ?")
				.get(sessionId) as { next: number }
		).next;
		this.insertEntry(sessionId, seq, entry as SessionEntry);
		this.db.prepare("UPDATE sessions SET ingested_at = ? WHERE id = ?").run(new Date().toISOString(), sessionId);
	}

	rewriteAll(key: string, entries: FileEntry[]): void {
		const parsed = this.headerFrom(entries);
		if (!parsed) throw new Error(`session store: rewriteAll without session header: ${key}`);
		const sessionId = this.sessionIdFor(key);
		this.db.prepare("BEGIN").run();
		try {
			this.wipeEntries(sessionId);
			this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
			this.upsertHeader(sessionId, key, parsed.header);
			let seq = 0;
			for (const entry of parsed.rest) {
				this.insertEntry(sessionId, seq, entry as SessionEntry);
				seq++;
			}
			this.db.prepare("COMMIT").run();
		} catch (err) {
			this.db.prepare("ROLLBACK").run();
			throw err;
		}
	}

	exists(key: string): boolean {
		return this.sessionRow(key) !== undefined;
	}

	sizeBytes(key: string): number {
		const sessionId = this.sessionIdFor(key);
		const row = this.db
			.prepare("SELECT COALESCE(SUM(LENGTH(json) + 1), 0) AS size FROM session_entries WHERE session_id = ?")
			.get(sessionId) as { size: number };
		return row.size;
	}

	mtimeMs(key: string): number {
		const row = this.sessionRow(key);
		if (row?.ingested_at) {
			const ms = Date.parse(row.ingested_at);
			if (!Number.isNaN(ms)) return ms;
		}
		return 0;
	}

	readAll(key: string): FileEntry[] | null {
		const row = this.sessionRow(key);
		if (row === undefined) return null;
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: row.id,
			timestamp: row.ts ?? new Date().toISOString(),
			cwd: row.cwd ?? "",
			parentSession: row.parent_session ?? undefined,
		};
		const entries = this.db
			.prepare("SELECT json FROM session_entries WHERE session_id = ? ORDER BY seq")
			.all(row.id) as Array<{ json: string }>;
		const out: FileEntry[] = [header];
		try {
			for (const e of entries) out.push(JSON.parse(e.json) as FileEntry);
		} catch {
			// corrupt row = unreadable session (parity with JsonlStore.readAll)
			return null;
		}
		return out;
	}

	readHeader(key: string): SessionHeader | null {
		const row = this.sessionRow(key);
		if (row === undefined) return null;
		return {
			type: "session",
			version: 3,
			id: row.id,
			timestamp: row.ts ?? new Date().toISOString(),
			cwd: row.cwd ?? "",
			parentSession: row.parent_session ?? undefined,
		};
	}

	listKeys(dir: string): string[] {
		// keys embed the session dir pi computed; LIKE prefix matches them.
		const prefix = `${dir}/`;
		const rows = this.db
			.prepare("SELECT file_path FROM sessions WHERE file_path LIKE ? ORDER BY ingested_at DESC")
			.all(`${prefix}%`) as Array<{ file_path: string }>;
		return rows.map((r) => r.file_path);
	}

	listAllKeys(root: string): string[] {
		const prefix = `${root}/`;
		const rows = this.db
			.prepare("SELECT file_path FROM sessions WHERE file_path LIKE ? ORDER BY ingested_at DESC")
			.all(`${prefix}%`) as Array<{ file_path: string }>;
		return rows.map((r) => r.file_path);
	}

	ensureDir(_dir: string): void {
		// no filesystem layout in DB mode
	}
}
