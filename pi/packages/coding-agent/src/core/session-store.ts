/**
 * Session storage seam (FORK(blueberry)).
 *
 * Stock pi persists sessions as JSONL files under the agent dir. Blueberry
 * requires DB-only persistence: every session write lands in
 * ~/.blueberry/blueberry.db (sessions / session_entries / session_fts) and
 * JSONL becomes an export format, never a live write path.
 *
 * SessionManager is refactored to call this interface for ALL persistence.
 * The default (JsonlStore) is bit-for-bit stock behavior; blueberry's
 * launcher installs BlueberryDbStore via setSessionStore() before any
 * session code runs (BLUEBERRY_DB env → main.ts).
 *
 * "Key" is the opaque session identifier pi treats as a file path in stock
 * mode (`<dir>/<timestamp>_<id>.jsonl`); in DB mode it is a synthetic key.
 * Nothing outside the store may parse or resolve keys.
 */
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { FileEntry, SessionHeader } from "./session-manager.ts";
import { readSessionHeader } from "./session-manager.ts";

export interface SessionStore {
	/** Synthesize the opaque session key pi uses as its "file". */
	sessionKey(dir: string, fileTimestamp: string, sessionId: string): string;
	/** Create a brand-new session store entry; MUST throw if it already exists. */
	createNew(key: string, entries: FileEntry[]): void;
	/** Append one entry (ordered). */
	appendEntry(key: string, entry: FileEntry): void;
	/** Full rewrite (compaction / migration): create-or-truncate. */
	rewriteAll(key: string, entries: FileEntry[]): void;
	/** Existence check. */
	exists(key: string): boolean;
	/** Size in bytes (JSONL mode: file size; DB mode: total payload bytes). */
	sizeBytes(key: string): number;
	/** Modification time in ms, for recency sorting. */
	mtimeMs(key: string): number;
	/** All entries in order, or null when missing/unparseable. */
	readAll(key: string): FileEntry[] | null;
	/** Header-only read for discovery (cheap). */
	readHeader(key: string): SessionHeader | null;
	/** Discovery: session keys under a session dir (empty if none). */
	listKeys(dir: string): string[];
	/** Discovery: session keys under a sessions ROOT dir, recursively (empty if none). */
	listAllKeys(root: string): string[];
	/** Ensure the session dir exists before first write. */
	ensureDir(dir: string): void;
}

/** Stock behavior: JSONL files on disk. */
export class JsonlStore implements SessionStore {
	sessionKey(dir: string, fileTimestamp: string, sessionId: string): string {
		return join(dir, `${fileTimestamp}_${sessionId}.jsonl`);
	}

	createNew(key: string, entries: FileEntry[]): void {
		const fd = openSync(key, "wx");
		try {
			for (const entry of entries) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
		} finally {
			closeSync(fd);
		}
	}

	appendEntry(key: string, entry: FileEntry): void {
		appendFileSync(key, `${JSON.stringify(entry)}\n`);
	}

	rewriteAll(key: string, entries: FileEntry[]): void {
		const fd = openSync(key, "w");
		try {
			for (const entry of entries) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
		} finally {
			closeSync(fd);
		}
	}

	exists(key: string): boolean {
		return existsSync(key);
	}

	sizeBytes(key: string): number {
		return statSync(key).size;
	}

	mtimeMs(key: string): number {
		return statSync(key).mtimeMs;
	}

	readAll(key: string): FileEntry[] | null {
		try {
			const content = readFileSync(key, "utf8");
			return content
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => JSON.parse(line) as FileEntry);
		} catch {
			return null;
		}
	}

	readHeader(key: string): SessionHeader | null {
		// bounded first-line scan (avoids loading large files) — lives in
		// session-manager.ts; import cycle is call-time-only and safe in ESM
		return readSessionHeader(key);
	}

	listKeys(dir: string): string[] {
		try {
			return readdirSync(dir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => join(dir, f));
		} catch {
			return [];
		}
	}

	listAllKeys(root: string): string[] {
		const out: string[] = [];
		try {
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
				const dir = join(root, entry.name);
				try {
					for (const f of readdirSync(dir)) {
						if (f.endsWith(".jsonl")) out.push(join(dir, f));
					}
				} catch {
					// unreadable project dir: skip
				}
			}
		} catch {
			return [];
		}
		return out;
	}

	ensureDir(dir: string): void {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	}
}

let activeStore: SessionStore | undefined;

/** Install the process-wide store. Called before any session code runs. */
export function setSessionStore(store: SessionStore): void {
	activeStore = store;
}

/** The active store (defaults to stock JSONL). */
export function getSessionStore(): SessionStore {
	return activeStore ?? new JsonlStore();
}
