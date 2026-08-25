/**
 * Zero-dependency utilities for blueberry.
 *
 * Constraint: everything here must be erasable-syntax TypeScript (no enums,
 * no namespaces, no parameter properties) so the same source runs under both
 * Node's native type stripping (CLI/tests) and jiti (pi extensions).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as os from "node:os";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Monotonic-ish ULID: 10-char timestamp + 16-char randomness. */
export function ulid(now: number = Date.now()): string {
	let time = now;
	let timePart = "";
	for (let i = 0; i < 10; i++) {
		timePart = CROCKFORD[time % 32] + timePart;
		time = Math.floor(time / 32);
	}
	let randPart = "";
	for (const byte of randomBytes(16)) {
		randPart += CROCKFORD[byte % 32]!;
	}
	return timePart + randPart;
}

/** Slugify a name into a directory-safe token. */
export function slugify(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || "project";
}

/** Expand a leading ~ to the user home directory. */
export function expandTilde(p: string, home: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/")) return join(home, p.slice(2));
	return p;
}

/** Read and parse a JSON file, returning null when missing or malformed. */
export function readJsonIfExists<T>(path: string): T | null {
	try {
		const raw = readFileSync(path, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/** Atomically write a file (temp file in same dir, then rename). */
export async function atomicWrite(
	path: string,
	content: string,
): Promise<void> {
	const dir = dirname(path);
	const tmp = join(dir, `.blueberry-tmp-${randomUUID().slice(0, 8)}`);
	await writeFile(tmp, content, "utf8");
	await rename(tmp, path);
}

/** Atomically write JSON with a trailing newline. */
export async function atomicWriteJson(
	path: string,
	data: unknown,
): Promise<void> {
	await atomicWrite(path, JSON.stringify(data, null, 2) + "\n");
}

/** Create a unique temp directory (for tests and staging). */

/**
 * pi's exact session-dir mangling: cwd -> `--<dashed>--`.
 * (We only need to *read* pi's layout during adopt, but keep it symmetric.)
 */
export function encodeCwdToDirName(cwd: string): string {
	const stripped = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	return `--${stripped}--`;
}

/**
 * Reverse of encodeCwdToDirName, best effort. Ambiguous (dashes inside path
 * components are indistinguishable from separators), so callers should verify
 * candidates against the filesystem or registry.
 */
export function decodeDirNameToPathCandidates(
	dirName: string,
	exists: (p: string) => boolean,
): string[] {
	const match = /^--(.*)--$/.exec(dirName);
	if (!match) return [];
	const segments = match[1]!.split("-");
	if (segments.length === 0 || segments.length > 12) return [];

	// All 2^(n-1) join variants, filtered by existence.
	const results: string[] = [];
	const n = segments.length;
	const total = 1 << (n - 1);
	for (let mask = 0; mask < total; mask++) {
		const parts: string[] = [segments[0]!];
		for (let i = 1; i < n; i++) {
			if (mask & (1 << (i - 1))) {
				parts[parts.length - 1] = parts[parts.length - 1] + "-" + segments[i];
			} else {
				parts.push(segments[i]!);
			}
		}
		const candidate = "/" + parts.join("/");
		// #32: on Windows, normalize the candidate to a valid path before checking existence
		const normalized =
			os.platform() === "win32"
				? resolve(segments[0]!, ...parts.slice(1))
				: candidate;
		if (exists(normalized) && !results.includes(candidate))
			results.push(candidate);
	}
	return results;
}

/** Canonical form for path comparison: realpath when it exists (resolves
 * symlinks — critical on macOS where /tmp and /var are symlinks and
 * process.cwd() returns /private/... forms), resolve() otherwise. */
export function normalizePathForCompare(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

/** Path equality that survives symlinks and trailing-slash/trivial diffs. */
export function samePath(a: string, b: string): boolean {
	return normalizePathForCompare(a) === normalizePathForCompare(b);
}

/** Sanitize a session display name the way pi does (single line, trimmed). */
export function sanitizeSessionName(name: string): string {
	return name.replace(/[\r\n]+/g, " ").trim();
}

/** 8-hex-char entry id, avoiding collisions with existing ids (pi convention). */
export function shortEntryId(existingIds: Set<string>): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!existingIds.has(id)) return id;
	}
	return randomUUID();
}

export { resolve };
