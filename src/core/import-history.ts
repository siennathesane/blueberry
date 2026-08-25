/**
 * History import — Claude Code + Kimi-code → blueberry.db (#45).
 *
 * Two source formats, one destination: sessions land as pi-format JSONL
 * (header + entries) and ride the existing ingestSessionFile path, so FTS,
 * search, and library views work on day one.
 *
 * Claude Code (~/.claude/projects/<dash-encoded-path>/<session>.jsonl):
 *   records keyed by type; user/assistant carry .message {role, content[]},
 *   parentUuid chains form the tree, isSidechain marks subagent branches,
 *   cwd + sessionId + timestamp + aiTitle map to the header and name.
 *   Noise (attachments, snapshots, queue-ops, permissions, system, isMeta)
 *   is skipped. ~1,571 sessions.
 *
 * Kimi-code (~/.kimi-code/sessions/wd_…/ses_…/agents/main/wire.jsonl):
 *   context.append_message records carry {role, content[]} (near-pi shape),
 *   epoch-ms time; session_index.jsonl maps sessionId → workDir for cwd.
 *   Noise (config.update with full system prompts, llm.request, usage,
 *   tools.*, mcp.*) skipped. ~1,339 sessions.
 *
 * Idempotent: sessions already present (by id) are skipped; re-runs cheap.
 * Dry-run by default — pass apply to write.
 */
import { randomUUID } from "node:crypto";
import {
	readFileSync,
	readdirSync,
	existsSync,
	writeFileSync,
	mkdirSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ingestSessionFile } from "./sync.ts";

// --- shared ---------------------------------------------------------------------------

export interface ImportedSession {
	source: "claude" | "kimi";
	sessionId: string;
	cwd: string | null;
	title: string | null;
	startedAt: string; // ISO
	messages: number; // entries written
}

export interface ImportReport {
	scanned: number;
	imported: ImportedSession[];
	skipped: number; // already present
	errors: Array<{ sessionId: string; detail: string }>;
}

function nowIso(): string {
	return new Date().toISOString();
}

function epochMsToIso(ms: number | undefined): string | null {
	return typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null;
}

function isoToIso(s: string | undefined): string | null {
	return typeof s === "string" && s !== "" ? s : null;
}

/** content blocks kept as-is (text); images dropped to a placeholder. */
export function normalizeContent(
	content: unknown,
): string | Array<Record<string, unknown>> {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const out: Array<Record<string, unknown>> = [];
		for (const block of content) {
			if (typeof block !== "object" || block === null) continue;
			const b = block as Record<string, unknown>;
			if (b["type"] === "text" && typeof b["text"] === "string") {
				out.push({ type: "text", text: b["text"] });
			} else if (b["type"] === "image") {
				out.push({ type: "text", text: "[image omitted during import]" });
			}
			// tool_use/tool_result blocks: skipped (session-noise for search)
		}
		return out;
	}
	return "";
}

// --- claude ---------------------------------------------------------------------------

interface ClaudeRecord {
	type?: string;
	uuid?: string;
	parentUuid?: string | null;
	isSidechain?: boolean;
	isMeta?: boolean;
	sessionId?: string;
	cwd?: string;
	timestamp?: string;
	message?: { role?: string; content?: unknown };
	aiTitle?: string;
}

const CLAUDE_NOISE = new Set([
	"attachment",
	"file-history-snapshot",
	"queue-operation",
	"permission-mode",
	"last-prompt",
	"system",
]);

export function convertClaudeSession(
	lines: string[],
	sessionId: string,
): {
	header: Record<string, unknown>;
	entries: Array<Record<string, unknown>>;
	cwd: string | null;
	title: string | null;
} {
	let cwd: string | null = null;
	let title: string | null = null;
	let startedAt: string | null = null;
	const records: ClaudeRecord[] = [];
	for (const line of lines) {
		try {
			records.push(JSON.parse(line) as ClaudeRecord);
		} catch {
			// torn tail lines: skip
		}
	}
	const valid = records.filter(
		(r) =>
			r.sessionId === sessionId ||
			r.type === undefined ||
			r.type === "user" ||
			r.type === "assistant",
	);
	for (const r of valid) {
		cwd = r.cwd ?? cwd;
		title = r.aiTitle ? String(r.aiTitle) : title;
		startedAt = startedAt ?? isoToIso(r.timestamp);
	}

	const entries: Array<Record<string, unknown>> = [];
	let parent: string | null = null;
	const uuidMap = new Map<string, string>(); // claude uuid → new entry id
	for (const r of valid) {
		if (r.type !== "user" && r.type !== "assistant") continue;
		if (r.isMeta) continue;
		if (CLAUDE_NOISE.has(r.type ?? "")) continue;
		const msg = r.message;
		if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
		const content = normalizeContent(msg.content);
		if (content === "") continue;
		// sidechain branches attach to the last mainline entry, not their
		// claude-parent (which may be in another branch we flattened)
		const newId = randomUUID();
		uuidMap.set(r.uuid ?? newId, newId);
		const parentId = r.isSidechain
			? null
			: r.parentUuid
				? (uuidMap.get(r.parentUuid) ?? parent)
				: parent;
		entries.push({
			type: "message",
			id: newId,
			parentId: r.isSidechain
				? (entries[entries.length - 1]?.id ?? null)
				: parentId,
			timestamp: isoToIso(r.timestamp) ?? nowIso(),
			message: { role: msg.role, content },
		});
		if (!r.isSidechain) parent = newId;
	}
	const header = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: startedAt ?? nowIso(),
		cwd: cwd ?? undefined,
	};
	return { header, entries, cwd, title };
}

// --- kimi -----------------------------------------------------------------------------

interface KimiRecord {
	type?: string;
	message?: { role?: string; content?: unknown };
	time?: number;
}

export function convertKimiSession(
	lines: string[],
	sessionId: string,
	workDir: string | null,
): {
	header: Record<string, unknown>;
	entries: Array<Record<string, unknown>>;
	cwd: string | null;
	title: null;
} {
	const entries: Array<Record<string, unknown>> = [];
	let startedAt: string | null = null;
	let parent: string | null = null;
	for (const line of lines) {
		let r: KimiRecord;
		try {
			r = JSON.parse(line) as KimiRecord;
		} catch {
			continue;
		}
		if (r.type !== "context.append_message") continue;
		const msg = r.message;
		if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
		const content = normalizeContent(msg.content);
		if (content === "") continue;
		const ts = epochMsToIso(r.time) ?? nowIso();
		startedAt = startedAt ?? ts;
		const newId = randomUUID();
		entries.push({
			type: "message",
			id: newId,
			parentId: parent,
			timestamp: ts,
			message: { role: msg.role, content },
		});
		parent = newId;
	}
	const header = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: startedAt ?? nowIso(),
		cwd: workDir ?? undefined,
	};
	return { header, entries, cwd: workDir, title: null };
}

/** session_index.jsonl → Map<sessionId, workDir> */
export function kimiWorkDirMap(sessionsDir: string): Map<string, string> {
	const out = new Map<string, string>();
	const index = join(sessionsDir, "session_index.jsonl");
	if (!existsSync(index)) return out;
	for (const line of readFileSync(index, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		try {
			const r = JSON.parse(line) as { sessionId?: string; workDir?: string };
			if (r.sessionId && r.workDir) out.set(r.sessionId, r.workDir);
		} catch {
			// skip torn lines
		}
	}
	return out;
}

// --- driver ---------------------------------------------------------------------------

export interface ImportOptions {
	source: "claude" | "kimi" | "all";
	apply: boolean; // false = dry-run (default)
	limit?: number;
}

export function importHistory(
	db: DatabaseSync,
	projectsByCwd: (cwd: string | null) => string | null,
	workDirs: { claude: string; kimi: string },
	opts: ImportOptions,
	tmpDir: string,
): ImportReport {
	const report: ImportReport = {
		scanned: 0,
		imported: [],
		skipped: 0,
		errors: [],
	};
	const present = new Set(
		(db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>).map(
			(r) => r.id,
		),
	);
	mkdirSync(tmpDir, { recursive: true });

	const doImport = (
		sessionId: string,
		cwd: string | null,
		title: string | null,
		header: Record<string, unknown>,
		entries: Array<Record<string, unknown>>,
		source: "claude" | "kimi",
	): void => {
		report.scanned++;
		if (present.has(sessionId)) {
			report.skipped++;
			return;
		}
		if (entries.length === 0) {
			report.skipped++;
			return;
		}
		if (!opts.apply) {
			report.imported.push({
				source,
				sessionId,
				cwd,
				title,
				startedAt: String(header["timestamp"]),
				messages: entries.length,
			});
			return;
		}
		// materialize pi-format JSONL and ride the standard ingest path —
		// FTS, project attribution, search all come free
		const path = join(tmpDir, `${sessionId}.jsonl`);
		const body =
			[JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))].join(
				"\n",
			) + "\n";
		writeFileSync(path, body);
		const res = ingestSessionFile(db, path, projectsByCwd, { allowOrphan: true });
		if (res.status === "ingested") {
			if (title !== null) {
				db
					.prepare("UPDATE sessions SET name = ? WHERE id = ?")
					.run(title, sessionId);
			}
			report.imported.push({
				source,
				sessionId,
				cwd,
				title,
				startedAt: String(header["timestamp"]),
				messages: entries.length,
			});
		} else if (res.status === "orphan" || res.status === "error") {
			report.errors.push({ sessionId, detail: res.detail ?? res.status });
		} else {
			report.skipped++;
		}
	};

	if (opts.source === "claude" || opts.source === "all") {
		const projectsDir = workDirs.claude;
		if (existsSync(projectsDir)) {
			for (const dir of readdirSync(projectsDir)) {
				const pdir = join(projectsDir, dir);
				for (const file of readdirSync(pdir)) {
					if (!file.endsWith(".jsonl")) continue;
					if (opts.limit !== undefined && report.scanned >= opts.limit) break;
					const sessionId = file.replace(".jsonl", "");
					const lines = readFileSync(join(pdir, file), "utf8").split("\n");
					const { header, entries, cwd, title } = convertClaudeSession(
						lines,
						sessionId,
					);
					doImport(sessionId, cwd, title, header, entries, "claude");
				}
			}
		}
	}

	if (opts.source === "kimi" || opts.source === "all") {
		const sessionsDir = workDirs.kimi;
		if (existsSync(sessionsDir)) {
			const workDirMap = kimiWorkDirMap(sessionsDir);
			for (const wd of readdirSync(sessionsDir)) {
				if (!wd.startsWith("wd_")) continue;
				const wdDir = join(sessionsDir, wd);
				for (const ses of readdirSync(wdDir)) {
					// session dirs use both prefixes across kimi versions
					if (!ses.startsWith("ses_") && !ses.startsWith("session_")) continue;
					const wire = join(wdDir, ses, "agents", "main", "wire.jsonl");
					if (!existsSync(wire)) continue;
					if (opts.limit !== undefined && report.scanned >= opts.limit) break;
					const sessionId = ses.replace(/^(ses|session)_/, "");
					const lines = readFileSync(wire, "utf8").split("\n");
					const { header, entries, cwd } = convertKimiSession(
						lines,
						sessionId,
						workDirMap.get(ses) ?? null,
					);
					doImport(sessionId, cwd, null, header, entries, "kimi");
				}
			}
		}
	}

	return report;
}
