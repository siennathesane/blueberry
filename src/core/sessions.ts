/**
 * Session file operations: the JSONL surgery layer.
 *
 * Verified against pi's session-manager source:
 * - Header (first line): {type:"session", version, id, timestamp, cwd, parentSession?}
 * - The active leaf is the LAST entry in file order (_buildIndex walks in order).
 * - Appends chain: {type, id: 8-hex-unique, parentId: <current leaf id|null>, timestamp, ...}
 * - session_info entries carry display names ({name}).
 *
 * Surgery rules (DESIGN.md §Sessions):
 * - Header rewrites touch the FIRST LINE ONLY; the rest is preserved byte-for-byte.
 * - Message/tool content is NEVER rewritten — old paths in history are inert.
 * - parentSession: rewritten when the parent moved in the same batch, cleared when dangling.
 * - Renames append pi-native session_info entries (survive /tree, no format crimes).
 * - File mtimes are preserved across moves so "most recent" stays truthful.
 */
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sanitizeSessionName, shortEntryId } from "./util.ts";

export interface SessionHeader {
	version?: number;
	id: string;
	timestamp?: string;
	cwd?: string;
	parentSession?: string;
	[key: string]: unknown;
}

export interface SessionInfo {
	file: string;
	id: string;
	cwd: string | undefined;
	name: string | null;
	firstUserText: string | null;
	messageCount: number;
	mtimeMs: number;
	sizeBytes: number;
}

/** Read and parse a session file's header line. Null when unreadable/invalid. */
export function readSessionHeader(file: string): SessionHeader | null {
	try {
		const fd = readFileSync(file, "utf8");
		const firstLine = fd.slice(0, fd.indexOf("\n"));
		const parsed = JSON.parse(firstLine) as SessionHeader;
		if (parsed?.type === "session" && typeof parsed.id === "string")
			return parsed;
		return null;
	} catch {
		return null;
	}
}

interface ParsedEntry {
	id?: string;
	type?: string;
	name?: string;
	message?: { role?: string; content?: unknown };
}

function firstUserTextFrom(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const first = content.find(
			(c): c is { type: "text"; text: string } =>
				typeof c === "object" &&
				c !== null &&
				(c as { type?: string }).type === "text",
		);
		return first ? first.text : null;
	}
	return null;
}

/** Scan a store directory for sessions, newest first. */
export function listSessions(storeDir: string): SessionInfo[] {
	if (!existsSync(storeDir)) return [];
	const out: SessionInfo[] = [];
	for (const f of readdirSync(storeDir)) {
		if (!f.endsWith(".jsonl")) continue;
		const file = join(storeDir, f);
		const header = readSessionHeader(file);
		if (!header) continue;

		let name: string | null = null;
		let firstUserText: string | null = null;
		let messageCount = 0;
		try {
			const raw = readFileSync(file, "utf8");
			for (const line of raw.split("\n")) {
				if (line.trim() === "") continue;
				let entry: ParsedEntry;
				try {
					entry = JSON.parse(line) as ParsedEntry;
				} catch {
					continue;
				}
				if (entry.type === "session_info" && typeof entry.name === "string")
					name = entry.name;
				if (entry.type === "message" && entry.message) {
					messageCount++;
					if (firstUserText === null && entry.message.role === "user") {
						firstUserText = firstUserTextFrom(entry.message.content);
					}
				}
			}
		} catch {
			// unreadable body: still list it with header info
		}
		const st = statSync(file);
		out.push({
			file,
			id: header.id,
			cwd: header.cwd,
			name,
			firstUserText,
			messageCount,
			mtimeMs: st.mtimeMs,
			sizeBytes: st.size,
		});
	}
	out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return out;
}

/** Rewrite a session header in place (first line only), preserving the rest. */
export function rewriteSessionHeader(
	file: string,
	mutate: (header: SessionHeader) => SessionHeader,
): void {
	const raw = readFileSync(file, "utf8");
	const nl = raw.indexOf("\n");
	const firstLine = nl === -1 ? raw : raw.slice(0, nl);
	const rest = nl === -1 ? "" : raw.slice(nl);
	let header: SessionHeader;
	try {
		header = JSON.parse(firstLine) as SessionHeader;
	} catch (err) {
		throw new Error(
			`session file has a malformed header line: ${file} (${(err as Error).message})`,
		);
	}
	const mutated = mutate(header);
	writeFileSync(file, JSON.stringify(mutated) + rest, "utf8");
}

/** Append a session_info entry (pi-native rename mechanism). */
export function renameSession(file: string, name: string): void {
	const raw = readFileSync(file, "utf8");
	const lines = raw.split("\n").filter((l) => l.trim() !== "");
	const existingIds = new Set<string>();
	let parentId: string | null = null;
	for (const line of lines) {
		try {
			const entry = JSON.parse(line) as { type?: string; id?: string };
			if (entry.type === "session" || typeof entry.id !== "string") continue;
			existingIds.add(entry.id);
			parentId = entry.id; // last entry in file order is the leaf
		} catch {
			// ignore malformed lines: leaf tracking only needs parseable entries
		}
	}
	const entry = {
		type: "session_info",
		id: shortEntryId(existingIds),
		parentId,
		timestamp: new Date().toISOString(),
		name: sanitizeSessionName(name),
	};
	const prefix = raw.endsWith("\n") || raw === "" ? "" : "\n";
	writeFileSync(file, raw + prefix + JSON.stringify(entry) + "\n", "utf8");
}

export interface MoveOptions {
	newCwd: string;
	/** Map of original file path -> new file path for sessions moved in the same batch. */
	movedMap?: Map<string, string>;
	/** Leave the source file in place (copy instead of move). */
	copy?: boolean;
}

/** Move a session file to a target store, rewriting its header for the new project. */
export function moveSession(
	file: string,
	targetDir: string,
	opts: MoveOptions,
): string {
	const st = statSync(file);
	const target = join(targetDir, join(file).split("/").pop()!);
	mkdirSync(targetDir, { recursive: true });

	// Copy to a staging name, rewrite the header, then atomically place it.
	const staging = join(targetDir, `.${randomUUID().slice(0, 8)}.staging`);
	copyFileSync(file, staging);
	rewriteSessionHeader(staging, (h) => {
		h.cwd = opts.newCwd;
		if (typeof h.parentSession === "string") {
			const mapped = opts.movedMap?.get(h.parentSession);
			if (mapped) h.parentSession = mapped;
			else delete h.parentSession; // dangling: cleared per surgery rules
		}
		return h;
	});
	let finalPath = target;
	if (existsSync(target) && (target !== file || opts.copy)) {
		// collision: suffix with the session's short id. Copy mode never overwrites
		// an existing target — including the source itself (same-store fork).
		const suffix = (readSessionHeader(staging)?.id ?? randomUUID()).slice(0, 8);
		finalPath = target.replace(/\.jsonl$/, `-${suffix}.jsonl`);
	}
	renameSync(staging, finalPath);
	utimesSync(finalPath, st.atime, st.mtime); // preserve mtime for truthful recency
	if (finalPath !== file && !opts.copy) {
		// remove original only when we actually placed a copy elsewhere
		rmSync(file, { force: true });
	}
	return finalPath;
}

/** Move a session into the trash area (never destructive deletes). */
export function trashSession(file: string, trashRoot: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dir = join(trashRoot, stamp);
	mkdirSync(dir, { recursive: true });
	const target = join(dir, join(file).split("/").pop()!);
	renameSync(file, target);
	return target;
}

/**
 * Resolve a user selector against a store:
 * - UUID prefix (>= 4 chars)
 * - exact session name
 * - 1-based index into the newest-first listing
 */
export function selectSession(
	storeDir: string,
	selector: string,
): SessionInfo | null {
	const sessions = listSessions(storeDir);
	const trimmed = selector.trim();
	if (trimmed === "") return null;

	// exact index (1-based, newest first)
	if (/^\d+$/.test(trimmed)) {
		const idx = Number(trimmed) - 1;
		return sessions[idx] ?? null;
	}

	// uuid prefix
	if (trimmed.length >= 4) {
		const byId =
			sessions.find((s) => s.id === trimmed) ??
			sessions.find((s) => s.id.startsWith(trimmed));
		if (byId) return byId;
	}

	// exact name
	return sessions.find((s) => s.name === trimmed) ?? null;
}
