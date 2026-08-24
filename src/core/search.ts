/**
 * Cross-session search over ingested history (§Search + §Data convergence).
 *
 * The design-note contract: search results must include 3–5 contextual
 * messages above and below each hit, with timestamps and contextually
 * relevant information (roles, todo tags, transitions). A bare snippet is
 * not reorientation; the neighborhood is.
 */
import type { DatabaseSync } from "node:sqlite";
import { ftsSearch, type SearchRow } from "./sync.ts";

export interface ContextMessage {
	seq: number;
	ts: string | null;
	role: string | null;
	text: string;
	isHit: boolean;
}

export interface SessionHit {
	sessionId: string;
	name: string | null;
	projectSlug: string | null;
	hitSeq: number;
	hitRole: string;
	messages: ContextMessage[]; // the neighborhood
}

function entrySummary(json: string): { ts: string | null; role: string | null; text: string } {
	try {
		const e = JSON.parse(json) as Record<string, unknown>;
		const ts = typeof e["timestamp"] === "string" ? e["timestamp"] : null;
		if (e["type"] === "session_info") {
			return { ts, role: "session_info", text: String(e["name"] ?? "") };
		}
		if (e["type"] !== "message") return { ts, role: null, text: "" };
		const m = e["message"] as Record<string, unknown> | undefined;
		if (!m) return { ts, role: null, text: "" };
		const role = typeof m["role"] === "string" ? m["role"] : null;
		const content = m["content"];
		let text = "";
		if (typeof content === "string") text = content;
		else if (Array.isArray(content)) {
			text = content
				.map((b) =>
					typeof b === "object" && b !== null && (b as Record<string, unknown>)["type"] === "text"
						? String((b as Record<string, unknown>)["text"] ?? "")
						: "",
				)
				.filter((s) => s !== "")
				.join("\n");
		}
		if (text.length > 400) text = `${text.slice(0, 399)}…`;
		return { ts, role, text };
	} catch {
		return { ts: null, role: null, text: "" };
	}
}

/**
 * Search ingested sessions with the context neighborhood. Hits are grouped
 * per session (max one neighborhood per session per query) to keep results
 * bounded while preserving the surrounding story.
 */
export function searchSessionsWithContext(
	db: DatabaseSync,
	query: string,
	opts: { contextBefore?: number; contextAfter?: number; limit?: number } = {},
): SessionHit[] {
	const before = opts.contextBefore ?? 3;
	const after = opts.contextAfter ?? 5; // 3-5 rule: prefer showing more after
	const limit = opts.limit ?? 20;

	const rows = ftsSearch(db, query, limit);
	const seenSessions = new Set<string>();
	const hits: SessionHit[] = [];

	const sessionMeta = db.prepare("SELECT s.id, s.name, p.slug FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?");
	const entriesFor = db.prepare(
		"SELECT seq, ts, json FROM session_entries WHERE session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq",
	);

	for (const row of rows) {
		if (seenSessions.has(row.session_id)) continue; // one neighborhood per session
		seenSessions.add(row.session_id);

		const meta = sessionMeta.get(row.session_id) as Record<string, unknown> | undefined;
		const entryRows = entriesFor.all(row.session_id, row.seq - before, row.seq + after) as Array<
			Record<string, unknown>
		>;
		if (entryRows.length === 0) continue;

		const messages: ContextMessage[] = entryRows.map((e) => {
			const s = entrySummary(String(e["json"]));
			return {
				seq: Number(e["seq"]),
				ts: s.ts,
				role: s.role,
				text: s.text,
				isHit: Number(e["seq"]) === row.seq,
			};
		});

		hits.push({
			sessionId: row.session_id,
			name: meta && meta["name"] !== null && meta["name"] !== undefined ? String(meta["name"]) : null,
			projectSlug: meta && meta["slug"] !== null && meta["slug"] !== undefined ? String(meta["slug"]) : null,
			hitSeq: row.seq,
			hitRole: row.role,
			messages,
		});
	}
	return hits;
}

function fmtTs(ts: string | null): string {
	if (ts === null) return "--:--";
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "--:--";
	return d.toISOString().slice(5, 16).replace("T", " ");
}

/** Render hits: session headers + timestamped neighborhood lines, hit marked. */
export function formatSessionHits(hits: SessionHit[]): string {
	if (hits.length === 0) return "no matches";
	const out: string[] = [];
	for (const h of hits) {
		const label = h.name ?? h.sessionId.slice(0, 8);
		const proj = h.projectSlug ? `${h.projectSlug}/` : "";
		out.push(`── ${proj}${label} ──`);
		for (const m of h.messages) {
			const marker = m.isHit ? "▶" : " ";
			const role = m.role ?? "·";
			const text = m.text.replace(/\s+/g, " ").trim();
			if (text === "" && !m.isHit) continue; // skip empty neighbors, keep hit line always
			out.push(`${marker} ${fmtTs(m.ts)} ${role.padEnd(8)} ${text.slice(0, 140)}`);
		}
	}
	const capped = out.join("\n");
	if (capped.length > 50_000) return `${capped.slice(0, 49_998)}\n…`;
	return capped;
}

// --- repo code search (files table + line-level FTS) -----------------------------

export interface CodeHit {
	path: string;
	line: number;
	text: string;
}

/** Index a file's lines into code_fts (replacing any prior rows for the path). */
export function indexFileLines(db: DatabaseSync, path: string, content: string): number {
	db.prepare("DELETE FROM code_fts WHERE path = ?").run(path);
	const insert = db.prepare("INSERT INTO code_fts (text, path, line) VALUES (?, ?, ?)");
	const lines = content.split("\n");
	let count = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trim() === "") continue;
		insert.run(line, path, i + 1);
		count++;
	}
	db.prepare(
		"INSERT INTO files (path, mtime_ms, size) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size",
	).run(path, Date.now(), content.length);
	return count;
}

export function searchCode(db: DatabaseSync, query: string, limit = 30): CodeHit[] {
	const safe = query.replace(/["'*:]/g, " ").trim();
	if (safe === "") return [];
	const rows = db
		.prepare(
			"SELECT path, line, text FROM code_fts WHERE code_fts MATCH ? ORDER BY bm25(code_fts) LIMIT ?",
		)
		.all(`"${safe}"`, limit) as Array<Record<string, unknown>>;
	return rows.map((r) => ({ path: String(r["path"]), line: Number(r["line"]), text: String(r["text"]) }));
}

export { ftsSearch, type SearchRow };
