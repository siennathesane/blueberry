/**
 * Test fixtures: temp agent dirs, fake repos (git/lore/worktree/plain),
 * and fake session JSONL files matching pi's on-disk format.
 */
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function tmpDir(prefix = "blueberry-test-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export function tmpAgentDir(): string {
	const dir = tmpDir("bb-agent-");
	mkdirSync(dir, { recursive: true });
	return dir;
}

export type RepoKind = "git" | "lore" | "worktree" | "plain";

/**
 * Create a fake project root of the given kind.
 * - git: .git directory; marker (if id) at .git/blueberry-id
 * - lore: .lore directory; marker at .lore/blueberry-id
 * - worktree: .git as a FILE (gitdir pointer); marker at .blueberry/id
 * - plain: no VCS; marker at .blueberry/id
 */
export function fakeRepo(parent: string, name: string, kind: RepoKind, markerId?: string): string {
	const root = join(parent, name);
	switch (kind) {
		case "git":
			mkdirSync(join(root, ".git"), { recursive: true });
			if (markerId) writeFileSync(join(root, ".git", "blueberry-id"), markerId + "\n");
			break;
		case "lore":
			mkdirSync(join(root, ".lore"), { recursive: true });
			if (markerId) writeFileSync(join(root, ".lore", "blueberry-id"), markerId + "\n");
			break;
		case "worktree":
			mkdirSync(root, { recursive: true });
			writeFileSync(join(root, ".git"), "gitdir: /elsewhere/main/.git/worktrees/wt\n");
			if (markerId) {
				mkdirSync(join(root, ".blueberry"), { recursive: true });
				writeFileSync(join(root, ".blueberry", "id"), markerId + "\n");
			}
			break;
		case "plain":
			mkdirSync(root, { recursive: true });
			if (markerId) {
				mkdirSync(join(root, ".blueberry"), { recursive: true });
				writeFileSync(join(root, ".blueberry", "id"), markerId + "\n");
			}
			break;
	}
	return root;
}

export interface SessionSpec {
	id?: string;
	cwd: string;
	timestamp?: string;
	parentSession?: string;
	name?: string; // appends a session_info entry
	firstUserText?: string; // appends a user message entry
	entries?: number; // extra dummy entries
}

function entryLine(id: string, parentId: string | null, type: string, extra: Record<string, unknown>): string {
	return JSON.stringify({ type, id, parentId, timestamp: new Date().toISOString(), ...extra });
}

/** Write a fake session JSONL matching pi's format. Returns its path. */
export function fakeSession(storeDir: string, spec: SessionSpec): string {
	mkdirSync(storeDir, { recursive: true });
	const id = spec.id ?? randomUUID();
	const ts = spec.timestamp ?? new Date().toISOString();
	const fileTs = ts.replace(/[:.]/g, "-");
	const path = join(storeDir, `${fileTs}_${id}.jsonl`);

	const lines: string[] = [];
	const header: Record<string, unknown> = { type: "session", version: 3, id, timestamp: ts, cwd: spec.cwd };
	if (spec.parentSession) header["parentSession"] = spec.parentSession;
	lines.push(JSON.stringify(header));

	let parentId: string | null = null;
	const pushEntry = (type: string, extra: Record<string, unknown>) => {
		const eid = randomUUID().slice(0, 8);
		lines.push(entryLine(eid, parentId, type, extra));
		parentId = eid;
	};
	if (spec.firstUserText !== undefined) pushEntry("message", { message: { role: "user", content: spec.firstUserText, timestamp: Date.now() } });
	if (spec.name !== undefined) pushEntry("session_info", { name: spec.name });
	for (let i = 0; i < (spec.entries ?? 0); i++) pushEntry("message", { message: { role: "assistant", content: [{ type: "text", text: `dummy ${i}` }], usage: null, stopReason: "stop", timestamp: Date.now() } });

	writeFileSync(path, lines.join("\n") + "\n");
	return path;
}

export function cleanup(...dirs: string[]): void {
	for (const d of dirs) {
		if (existsSync(d)) rmSync(d, { recursive: true, force: true });
	}
}
