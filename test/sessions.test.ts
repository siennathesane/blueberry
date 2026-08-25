import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import platform from "node:os";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
	utimesSync,
	copyFileSync,
} from "node:fs";
import {
	readSessionHeader,
	listSessions,
	rewriteSessionHeader,
	renameSession,
	moveSession,
	trashSession,
	selectSession,
} from "../src/core/sessions.ts";
import { tmpAgentDir, fakeSession, cleanup } from "./helpers.ts";
import { getCentralStoreDir } from "../src/core/agent-dir.ts";

let agentDir: string;
let store: string;

beforeEach(() => {
	agentDir = tmpAgentDir();
	store = `${agentDir}/sessions/proj`;
});
afterEach(() => {
	cleanup(agentDir);
});

test("readSessionHeader: parses pi format, null on garbage", () => {
	const f = fakeSession(store, { cwd: "/x/p", firstUserText: "hi" });
	const h = readSessionHeader(f)!;
	assert.equal(h.type, "session");
	assert.equal(h.cwd, "/x/p");
	assert.equal(typeof h.id, "string");

	writeFileSync(`${store}/bad.jsonl`, "not json at all\n");
	assert.equal(readSessionHeader(`${store}/bad.jsonl`), null);
});

test("listSessions: newest first, name + first user text + counts", async () => {
	fakeSession(store, { cwd: "/x/p", firstUserText: "older question" });
	// ensure distinct mtimes
	await new Promise((r) => setTimeout(r, 15));
	const f2 = fakeSession(store, {
		cwd: "/x/p",
		firstUserText: "newer question",
		name: "my-session",
	});
	await new Promise((r) => setTimeout(r, 15));
	utimesSync(f2, new Date(), new Date(Date.now() + 60_000)); // push f2 clearly newer

	const list = listSessions(store);
	assert.equal(list.length, 2);
	assert.equal(list[0]?.name, "my-session");
	assert.equal(list[0]?.firstUserText, "newer question");
	assert.equal(list[1]?.firstUserText, "older question");
	assert.ok(list[0]!.mtimeMs >= list[1]!.mtimeMs);
	assert.ok(list[0]!.messageCount >= 1);
});

test("listSessions: empty and missing stores", () => {
	assert.deepEqual(listSessions(`${agentDir}/sessions/none`), []);
});

test("rewriteSessionHeader: first line only, rest byte-identical", () => {
	const f = fakeSession(store, {
		cwd: "/x/p",
		firstUserText: "hello",
		entries: 3,
	});
	const before = readFileSync(f, "utf8");
	const beforeLines = before.split("\n").slice(1).join("\n");

	rewriteSessionHeader(f, (h) => {
		h.cwd = "/y/q";
		return h;
	});

	const after = readFileSync(f, "utf8");
	assert.equal(readSessionHeader(f)?.cwd, "/y/q");
	assert.equal(after.split("\n").slice(1).join("\n"), beforeLines);
});

test("renameSession: appends pi-native session_info at the leaf", () => {
	const f = fakeSession(store, {
		cwd: "/x/p",
		firstUserText: "q",
		name: "before",
	});
	renameSession(f, "after name");

	const lines = readFileSync(f, "utf8").trim().split("\n");
	const last = JSON.parse(lines[lines.length - 1]!);
	assert.equal(last.type, "session_info");
	assert.equal(last.name, "after name");
	// parentId chains to the previous last entry
	const prev = JSON.parse(lines[lines.length - 2]!);
	assert.equal(last.parentId, prev.type === "session" ? null : prev.id);
	// listing reflects the rename
	assert.equal(listSessions(store)[0]?.name, "after name");
});

test("moveSession: rewrites cwd, preserves mtime and body, removes original", () => {
	const src = fakeSession(store, { cwd: "/x/p", firstUserText: "body line" });
	const st = statSync(src);
	const targetDir = `${agentDir}/sessions/other`;
	mkdirSync(targetDir, { recursive: true });

	const moved = moveSession(src, targetDir, { newCwd: "/y/q" });

	assert.ok(!existsSync(src), "original removed");
	const h = readSessionHeader(moved)!;
	assert.equal(h.cwd, "/y/q");
	const stAfter = statSync(moved);
	assert.equal(
		Math.round(stAfter.mtimeMs),
		Math.round(st.mtimeMs),
		"mtime preserved",
	);
	assert.ok(readFileSync(moved, "utf8").includes("body line"), "body intact");
});

test("moveSession: rewrites parentSession when parent moved in same batch, clears when dangling", () => {
	const parent = fakeSession(store, { cwd: "/x/p" });
	const child = fakeSession(store, { cwd: "/x/p", parentSession: parent });
	const targetDir = `${agentDir}/sessions/other`;
	mkdirSync(targetDir, { recursive: true });

	const movedMap = new Map<string, string>();
	const newParent = moveSession(parent, targetDir, { newCwd: "/y/q", movedMap });
	movedMap.set(parent, newParent);
	const newChild = moveSession(child, targetDir, { newCwd: "/y/q", movedMap });

	assert.equal(readSessionHeader(newChild)?.parentSession, newParent);

	// dangling case: child references a parent that was NOT moved
	const orphan = fakeSession(store, { cwd: "/x/p", parentSession: parent });
	const movedOrphan = moveSession(orphan, targetDir, { newCwd: "/y/q" });
	assert.equal(readSessionHeader(movedOrphan)?.parentSession, undefined);
});

test("moveSession: collision suffixes instead of clobbering", () => {
	const a = fakeSession(store, { cwd: "/x/p", firstUserText: "A" });
	const targetDir = `${agentDir}/sessions/other`;
	mkdirSync(targetDir, { recursive: true });
	const first = moveSession(a, targetDir, { newCwd: "/y/q" });

	// same filename can't happen with uuid names; force one by copying the same file back and moving again
	const b = `${store}/${first.split("/").pop()}`;
	copyFileSync(first, b);
	const second = moveSession(b, targetDir, { newCwd: "/y/q" });

	assert.notEqual(second, first);
	assert.ok(existsSync(first), "first preserved");
	assert.ok(existsSync(second), "second placed with suffix");
	assert.equal(readdirSync(targetDir).length, 2);
});

test("trashSession: moves to timestamped trash dir, never deletes", () => {
	const f = fakeSession(store, { cwd: "/x/p" });
	const trashRoot = `${agentDir}/trash`;
	const trashed = trashSession(f, trashRoot);

	assert.ok(!existsSync(f));
	assert.ok(existsSync(trashed));
	assert.ok(trashed.startsWith(`${trashRoot}/`), "nested under timestamped dir");
});

test("selectSession: index, uuid prefix, exact name", () => {
	// deterministic ids: prefixes must not be all-digits (those parse as list indexes)
	const id1 = "aaaaaaaa-1111-4111-8111-111111111111";
	const id2 = "bbbbbbbb-2222-4222-8222-222222222222";
	fakeSession(store, { cwd: "/x/p", firstUserText: "one", id: id1 });
	const f2 = fakeSession(store, {
		cwd: "/x/p",
		firstUserText: "two",
		name: "named-one",
		id: id2,
	});
	// make f2 newest
	utimesSync(f2, new Date(), new Date(Date.now() + 60_000));

	// index: 1 = newest
	assert.equal(selectSession(store, "1")?.id, id2);
	assert.equal(selectSession(store, "2")?.id, id1);
	assert.equal(selectSession(store, "99"), null);

	// uuid prefix (>= 4 chars)
	assert.equal(selectSession(store, id1.slice(0, 8))?.id, id1);
	assert.equal(selectSession(store, id2.slice(0, 4))?.id, id2);

	// exact name
	assert.equal(selectSession(store, "named-one")?.id, id2);
	assert.equal(selectSession(store, "no-such"), null);

	// empty selector
	assert.equal(selectSession(store, ""), null);
	// short non-numeric selector (below prefix length): falls through to name match
	assert.equal(selectSession(store, "abc"), null);
});

// --- malformed input and edge-case files --------------------------------------

test("readSessionHeader: unreadable and wrong-type files return null", () => {
	const edge = getCentralStoreDir(agentDir, "edge-hdr");
	mkdirSync(edge, { recursive: true });
	const unreadable = `${edge}/a.jsonl`;
	writeFileSync(unreadable, "{}\n");
	if (platform !== "win32") {
		// #32: chmod semantics differ on Windows; unix-only behavior tested
		chmodSync(unreadable, 0o000);
		assert.equal(readSessionHeader(unreadable), null);
		chmodSync(unreadable, 0o644);
	}

	const wrongType = `${edge}/b.jsonl`;
	writeFileSync(wrongType, `${JSON.stringify({ type: "message", id: "x" })}\n`);
	assert.equal(readSessionHeader(wrongType), null);
});

test("listSessions: survives malformed lines, counts array-form messages, skips unreadable", () => {
	const edge = getCentralStoreDir(agentDir, "edge-body");
	mkdirSync(edge, { recursive: true });
	const f1 = `${edge}/arr.jsonl`;
	const ts = new Date().toISOString();
	writeFileSync(
		f1,
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "id-arr",
				timestamp: ts,
				cwd: "/x",
			}),
			JSON.stringify({
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: ts,
				message: {
					role: "user",
					content: [{ type: "text", text: "array hello" }],
					timestamp: 1,
				},
			}),
			JSON.stringify({
				type: "message",
				id: "e2",
				parentId: "e1",
				timestamp: ts,
				message: {
					role: "user",
					content: [{ type: "image", data: "..." }],
					timestamp: 2,
				},
			}),
			"{ malformed line",
			"",
		].join("\n"),
	);

	const sessions = listSessions(edge);
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0]?.firstUserText, "array hello");
	assert.equal(sessions[0]?.messageCount, 2);

	// a file whose header cannot even be read is skipped by the listing
	const f2 = `${edge}/noperm.jsonl`;
	writeFileSync(
		f2,
		`${JSON.stringify({ type: "session", version: 3, id: "id-np", timestamp: ts, cwd: "/x" })}\n`,
	);
	if (platform !== "win32") {
		// #32: chmod semantics differ on Windows; unix-only behavior tested
		chmodSync(f2, 0o000);
		assert.equal(listSessions(edge).length, 1);
		chmodSync(f2, 0o644);
	} else {
		// On Windows, skip the unreadable-file test as chmod does not enforce
		assert.equal(listSessions(edge).length, 1);
	}
});

test("renameSession: file without trailing newline still chains to the leaf", () => {
	const edge = getCentralStoreDir(agentDir, "edge-ren");
	mkdirSync(edge, { recursive: true });
	const f = `${edge}/nonl.jsonl`;
	const ts = new Date().toISOString();
	writeFileSync(
		f,
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "id-nl",
				timestamp: ts,
				cwd: "/x",
			}),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: ts,
				message: { role: "user", content: "hi" },
			}),
		].join("\n"),
	); // no trailing newline

	renameSession(f, "renamed");
	const lines = readFileSync(f, "utf8").trim().split("\n");
	const last = JSON.parse(lines[lines.length - 1]!);
	assert.equal(last.name, "renamed");
	assert.equal(last.parentId, "m1");
});

test("selectSession: empty/missing store returns null", () => {
	assert.equal(
		selectSession(getCentralStoreDir(agentDir, "nothing"), "1"),
		null,
	);
});

test("moveSession: same source and target dir rewrites in place", () => {
	const edge = getCentralStoreDir(agentDir, "edge-self");
	const f = fakeSession(edge, { cwd: "/old", firstUserText: "self" });
	const result = moveSession(f, edge, { newCwd: "/new" });
	assert.equal(result, f);
	assert.equal(readSessionHeader(f)?.cwd, "/new");
});
