/**
 * Design-doc + plan indexing: docs/design/*.md → designs table + doc_fts;
 * plans (DB-native) → doc_fts. One unified index, source-discriminated (§Design).
 *
 * The file is content truth for designs; the DB row is metadata + pointer.
 * Ingest joins on frontmatter id — renames never orphan needles. BM25 only.
 */
import type { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// --- frontmatter -------------------------------------------------------------------

export interface DesignFrontmatter {
	id: string;
	title: string;
	status: string;
	date: string;
	supersedes?: string;
	"superseded-by"?: string;
	[key: string]: string | undefined;
}

/** Parse YAML-ish frontmatter (flat key: value pairs; no nesting needed). */
export function parseFrontmatter(raw: string): { fm: DesignFrontmatter; body: string } | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
	if (!match) return null;
	const fm: Record<string, string> = {};
	for (const line of match[1]!.split("\n")) {
		const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line.trim());
		if (kv) fm[kv[1]!] = kv[2]!.trim();
	}
	if (typeof fm["id"] !== "string" || fm["id"] === "") return null;
	// SAFETY: fm is a flat Record<string, string> built line-by-line above; the
	// index signature on DesignFrontmatter is exactly Record<string,string|undefined>,
	// so this cast only widens the value type — no shape change.
	return {
		fm: fm as unknown as DesignFrontmatter,
		body: match[2] ?? "",
	};
}

export function designUri(slug: string, hex6: string): string {
	return `blueberry://design/${slug}/${hex6}`;
}

export function planUri(slug: string, hex6: string): string {
	return `blueberry://plan/${slug}/${hex6}`;
}

// --- design-doc ingest ---------------------------------------------------------------

export interface DocIngestResult {
	ingested: number;
	unchanged: number;
	errors: Array<{ file: string; detail: string }>;
}

/**
 * Walk docs/design/ under projectRoot and (re)index into designs + doc_fts.
 * Re-links path by frontmatter id on rename. Body indexed into doc_fts with
 * source='design'; prior rows for the same id are replaced.
 */
export function ingestDesignDocs(
	db: DatabaseSync,
	projectRoot: string,
	projectId: string,
): DocIngestResult {
	const result: DocIngestResult = { ingested: 0, unchanged: 0, errors: [] };
	const dir = join(projectRoot, "docs", "design");
	if (!existsSync(dir)) return result;

	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".md")) continue;
		const file = join(dir, f);
		try {
			const raw = readFileSync(file, "utf8");
			const parsed = parseFrontmatter(raw);
			if (!parsed) {
				result.errors.push({ file, detail: "missing or invalid frontmatter (id required)" });
				continue;
			}
			const st = statSync(file);
			const mtime = Math.round(st.mtimeMs);

			const existing = db
				.prepare("SELECT path, file_mtime_ms FROM designs WHERE id = ?")
				.get(parsed.fm.id) as { path: string; file_mtime_ms: number } | undefined;
			if (existing && existing.file_mtime_ms === mtime && existing.path === file) {
				result.unchanged++;
				continue;
			}

			const slug = f.replace(/\.md$/, "");
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO designs (id, project_id, slug, path, title, status, supersedes, superseded_by, file_mtime_ms, ingested_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   project_id = excluded.project_id,
				   slug = excluded.slug,
				   path = excluded.path,
				   title = excluded.title,
				   status = excluded.status,
				   supersedes = excluded.supersedes,
				   superseded_by = excluded.superseded_by,
				   file_mtime_ms = excluded.file_mtime_ms,
				   ingested_at = excluded.ingested_at`,
			).run(
				parsed.fm.id,
				projectId,
				slug,
				file,
				parsed.fm.title ?? slug,
				parsed.fm.status ?? "open",
				parsed.fm.supersedes ?? null,
				parsed.fm["superseded-by"] ?? null,
				mtime,
				now,
			);

			// re-index body: wipe prior rows for this design id, then chunk sections
			db.prepare("DELETE FROM doc_fts WHERE uri = ?").run(designUri(slug, parsed.fm.id));
			const insert = db.prepare("INSERT INTO doc_fts (text, source, uri) VALUES (?, 'design', ?)");
			const uri = designUri(slug, parsed.fm.id);
			// index by section so hits carry section context
			for (const section of splitSections(parsed.body)) {
				if (section.trim() !== "") insert.run(section, uri);
			}
			result.ingested++;
		} catch (err) {
			result.errors.push({ file, detail: (err as Error).message });
		}
	}
	return result;
}

/** Split markdown into h2-delimited section chunks (each indexed separately). */
export function splitSections(body: string): string[] {
	const lines = body.split("\n");
	const sections: string[] = [];
	let current: string[] = [];
	for (const line of lines) {
		if (/^##\s/.test(line) && current.length > 0) {
			sections.push(current.join("\n"));
			current = [line];
		} else {
			current.push(line);
		}
	}
	if (current.length > 0) sections.push(current.join("\n"));
	return sections;
}

// --- plan indexing --------------------------------------------------------------------

/** Index a plan's body into doc_fts (replaces prior rows for the plan id). */
export function indexPlanDoc(db: DatabaseSync, slug: string, hex6: string, body: string): void {
	const uri = planUri(slug, hex6);
	db.prepare("DELETE FROM doc_fts WHERE uri = ?").run(uri);
	const insert = db.prepare("INSERT INTO doc_fts (text, source, uri) VALUES (?, 'plan', ?)");
	for (const section of splitSections(body)) {
		if (section.trim() !== "") insert.run(section, uri);
	}
}

// --- unified doc search ------------------------------------------------------------------

export interface DocHit {
	text: string;
	source: string;
	uri: string;
}

export function searchDocs(db: DatabaseSync, query: string, opts: { source?: string; limit?: number } = {}): DocHit[] {
	const safe = query.replace(/["'*:]/g, " ").trim();
	if (safe === "") return [];
	const limit = opts.limit ?? 20;
	let rows: Array<Record<string, unknown>>;
	if (opts.source === undefined) {
		rows = db
			.prepare("SELECT text, source, uri FROM doc_fts WHERE doc_fts MATCH ? ORDER BY bm25(doc_fts) LIMIT ?")
			.all(`"${safe}"`, limit) as Array<Record<string, unknown>>;
	} else {
		rows = db
			.prepare("SELECT text, source, uri FROM doc_fts WHERE doc_fts MATCH ? AND source = ? ORDER BY bm25(doc_fts) LIMIT ?")
			.all(`"${safe}"`, opts.source, limit) as Array<Record<string, unknown>>;
	}
	return rows.map((r) => ({ text: String(r["text"]), source: String(r["source"]), uri: String(r["uri"]) }));
}

export function formatDocHits(hits: DocHit[]): string {
	if (hits.length === 0) return "no matches";
	const out: string[] = [];
	for (const h of hits) {
		const first = h.text.split("\n").find((l) => l.trim() !== "") ?? "";
		const kind = h.source === "design" ? "◈" : "⬡";
		out.push(`${kind} ${h.uri.replace("blueberry://", "")} — ${first.trim().slice(0, 100)}`);
	}
	return out.join("\n");
}
