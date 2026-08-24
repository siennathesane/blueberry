/**
 * Session ingest/restore between pi's JSONL stores and blueberry.db (§Data).
 *
 * JSONL stays pi's live write-path; the DB is the portable archive.
 * Ingest is idempotent by (mtime, size); changed files are fully re-ingested
 * (entries + FTS rows for that session are wiped and rewritten).
 */
import type { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSessionFile } from "./library.ts";
import type { Registry } from "./registry.ts";
import { storeDirFor } from "./resolution.ts";

export interface IngestResult {
	status: "ingested" | "unchanged" | "error" | "orphan";
	sessionId: string;
	file: string;
	detail?: string;
}

/** Extract FTS text + role from a parsed entry. Returns null for non-text entries. */
function entryText(entry: Record<string, unknown>): { role: string; text: string } | null {
	if (entry["type"] === "session_info") {
		const name = entry["name"];
		return typeof name === "string" && name !== "" ? { role: "session_info", text: name } : null;
	}
	if (entry["type"] !== "message") return null;
	const message = entry["message"] as Record<string, unknown> | undefined;
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

/**
 * Ingest one session JSONL file. `projectIdFor` maps header cwd → project id
 * (null = unknown). Unchanged files (mtime+size match) are skipped.
 */
export function ingestSessionFile(
	db: DatabaseSync,
	file: string,
	projectIdFor: (cwd: string | null) => string | null,
): IngestResult {
	let mtimeMs: number;
	let size: number;
	try {
		const st = statSync(file);
		mtimeMs = Math.round(st.mtimeMs);
		size = st.size;
	} catch (err) {
		return { status: "error", sessionId: "", file, detail: (err as Error).message };
	}

	const parsed = parseSessionFile(file);
	if (!parsed) return { status: "error", sessionId: "", file, detail: "unparseable header" };
	const header = parsed.header as Record<string, unknown>;
	const sessionId = typeof header["id"] === "string" ? header["id"] : "";
	if (sessionId === "") return { status: "error", sessionId: "", file, detail: "missing session id" };

	const existing = db.prepare("SELECT file_mtime_ms, size_bytes FROM sessions WHERE id = ?").get(sessionId) as
		| { file_mtime_ms: number; size_bytes: number }
		| undefined;
	if (existing && existing.file_mtime_ms === mtimeMs && existing.size_bytes === size) {
		return { status: "unchanged", sessionId, file };
	}

	const cwd = typeof header["cwd"] === "string" && header["cwd"] !== "" ? header["cwd"] : null;
	const projectId = projectIdFor(cwd);
	if (!projectId) return { status: "orphan", sessionId, file, detail: `no project for cwd ${cwd ?? "(none)"}` };

	const now = new Date().toISOString();
	const tx = db.prepare("BEGIN");
	const rollback = db.prepare("ROLLBACK");
	const commit = db.prepare("COMMIT");
	tx.run();
	try {
		// full wipe of any prior ingest for this session
		db.prepare("DELETE FROM session_entries WHERE session_id = ?").run(sessionId);
		db.prepare("DELETE FROM session_fts WHERE session_id = ?").run(sessionId);
		db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);

		db.prepare(
			`INSERT INTO sessions (id, project_id, file_path, cwd, ts, parent_session, name, file_mtime_ms, size_bytes, ingested_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			sessionId,
			projectId,
			file,
			cwd,
			typeof header["timestamp"] === "string" ? header["timestamp"] : null,
			typeof header["parentSession"] === "string" ? header["parentSession"] : null,
			null,
			mtimeMs,
			size,
			now,
		);

		const insertEntry = db.prepare(
			"INSERT INTO session_entries (session_id, seq, ts, type, entry_id, parent_id, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		const insertFts = db.prepare("INSERT INTO session_fts (text, session_id, seq, role) VALUES (?, ?, ?, ?)");
		const updateName = db.prepare("UPDATE sessions SET name = ? WHERE id = ?");

		let seq = 0;
		let lastName: string | null = null;
		for (const entry of parsed.entries) {
			const json = JSON.stringify(entry);
			insertEntry.run(
				sessionId,
				seq,
				typeof entry["timestamp"] === "string" ? entry["timestamp"] : null,
				typeof entry["type"] === "string" ? entry["type"] : "?",
				typeof entry["id"] === "string" ? entry["id"] : null,
				typeof entry["parentId"] === "string" ? entry["parentId"] : null,
				json,
			);
			const extracted = entryText(entry as Record<string, unknown>);
			if (extracted) {
				insertFts.run(extracted.text, sessionId, seq, extracted.role);
				if (extracted.role === "session_info") lastName = extracted.text;
			}
			seq++;
		}
		if (lastName !== null) updateName.run(lastName, sessionId);
		commit.run();
	} catch (err) {
		rollback.run();
		return { status: "error", sessionId, file, detail: (err as Error).message };
	}
	return { status: "ingested", sessionId, file };
}

export interface SyncReport {
	ingested: number;
	unchanged: number;
	orphans: Array<{ file: string; detail: string }>;
	errors: Array<{ file: string; detail: string }>;
}

/** Ingest every session file in every project store. */
export function syncStores(db: DatabaseSync, agentDir: string, registry: Registry): SyncReport {
	const report: SyncReport = { ingested: 0, unchanged: 0, orphans: [], errors: [] };
	const byPath = new Map<string, string>();
	for (const p of registry.projects) {
		byPath.set(p.canonicalPath, p.id);
		for (const a of p.aliases) byPath.set(a, p.id);
	}
	const projectIdFor = (cwd: string | null): string | null =>
		cwd === null ? null : (byPath.get(cwd) ?? null);

	for (const project of registry.projects) {
		const store = storeDirFor(agentDir, project);
		if (!existsSync(store)) continue;
		for (const f of readdirSync(store)) {
			if (!f.endsWith(".jsonl")) continue;
			const res = ingestSessionFile(db, join(store, f), projectIdFor);
			if (res.status === "ingested") report.ingested++;
			else if (res.status === "unchanged") report.unchanged++;
			else if (res.status === "orphan") report.orphans.push({ file: res.file, detail: res.detail ?? "" });
			else report.errors.push({ file: res.file, detail: res.detail ?? "" });
		}
	}
	return report;
}

/** FTS query across ingested history; returns (session_id, seq, role, snippet). */
export interface SearchRow {
	session_id: string;
	seq: number;
	role: string;
	text: string;
}

export function ftsSearch(db: DatabaseSync, query: string, limit = 50): SearchRow[] {
	// fts5 match syntax is user input; quote defensively to avoid parse errors
	const safe = query.replace(/["'*:]/g, " ").trim();
	if (safe === "") return [];
	const rows = db
		.prepare(
			`SELECT session_id, seq, role, text FROM session_fts WHERE session_fts MATCH ?
			  ORDER BY bm25(session_fts) LIMIT ?`,
		)
		.all(`"${safe}"`, limit) as Array<Record<string, unknown>>;
	return rows.map((r) => ({
		session_id: String(r["session_id"]),
		seq: Number(r["seq"]),
		role: String(r["role"]),
		text: String(r["text"]),
	}));
}

/**
 * Materialize a session JSONL back out of the DB (bb restore).
 * Writes entries as raw JSON lines; returns the restored path or null.
 */
export function restoreSession(db: DatabaseSync, sessionId: string, targetDir: string): string | null {
	const row = db.prepare("SELECT file_path FROM sessions WHERE id = ?").get(sessionId) as
		| { file_path: string }
		| undefined;
	if (!row) return null;
	mkdirSync(targetDir, { recursive: true });
	const entries = db
		.prepare("SELECT json FROM session_entries WHERE session_id = ? ORDER BY seq")
		.all(sessionId) as Array<Record<string, unknown>>;
	if (entries.length === 0) return null;

	// rebuild header from the sessions row
	const meta = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as Record<string, unknown>;
	const header: Record<string, unknown> = { type: "session", version: 3, id: sessionId };
	if (meta["cwd"]) header["cwd"] = meta["cwd"];
	if (meta["ts"]) header["timestamp"] = meta["ts"];
	if (meta["parent_session"]) header["parentSession"] = meta["parent_session"];

	const lines = [JSON.stringify(header), ...entries.map((e) => String(e["json"]))];
	const target = join(targetDir, `${String(meta["ts"] ?? "restored").replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
	writeFileSync(target, lines.join("\n") + "\n");
	return target;
}

/** Restore every ingested session whose file_path no longer exists. */
export function restoreMissing(db: DatabaseSync): Array<{ id: string; path: string }> {
	const rows = db.prepare("SELECT id, file_path FROM sessions").all() as Array<Record<string, unknown>>;
	const restored: Array<{ id: string; path: string }> = [];
	for (const r of rows) {
		const id = String(r["id"]);
		const filePath = String(r["file_path"]);
		if (existsSync(filePath)) continue;
		const dir = filePath.split("/").slice(0, -1).join("/");
		const target = restoreSession(db, id, dir === "" ? "." : dir);
		if (target) restored.push({ id, path: target });
	}
	return restored;
}
