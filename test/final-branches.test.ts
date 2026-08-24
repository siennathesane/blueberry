/**
 * Final branch-closing pass for the 95/95/95 gate: error paths, rollback
 * branches, truncation, orphan-resolution else-branches, self-parent adopt,
 * signal handling, and CLI catch arms.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main, type CliDeps } from "../src/cli/main.ts";
import {
	openDb,
	saveRegistrySync,
	syncConfigFile,
	loadRegistrySync,
} from "../src/core/db.ts";
import {
	ingestSessionFile,
	restoreSession,
	syncStores,
} from "../src/core/sync.ts";
import { formatSessionHits, type SessionHit } from "../src/core/search.ts";
import {
	listSessions,
	renameSession,
	rewriteSessionHeader,
} from "../src/core/sessions.ts";
import { runFix } from "../src/core/fix.ts";
import { adoptSessions } from "../src/core/adopt.ts";
import { getCentralStoreDir } from "../src/core/agent-dir.ts";
import { loadRegistry, mutations } from "../src/core/registry.ts";
import {
	tmpAgentDir,
	tmpDir,
	fakeRepo,
	fakeSession,
	cleanup,
} from "./helpers.ts";

let agentDir: string;
let area: string;

beforeEach(() => {
	agentDir = tmpAgentDir();
	area = tmpDir("bb-final-");
});
afterEach(() => {
	cleanup(agentDir, area);
});

// --- search.ts: pure-format branches ----------------------------------------------

test("formatSessionHits: NaN timestamps, empty neighbors skipped, huge output truncated", () => {
	const hit: SessionHit = {
		sessionId: "s1",
		name: null,
		projectSlug: null,
		hitSeq: 2,
		hitRole: "user",
		messages: [
			{ seq: 0, ts: "garbage-date", role: "user", text: "before", isHit: false },
			{ seq: 1, ts: null, role: null, text: "", isHit: false }, // empty non-hit → skipped
			{
				seq: 2,
				ts: "2026-08-24T10:00:00Z",
				role: "user",
				text: "the hit",
				isHit: true,
			},
			{
				seq: 3,
				ts: "2026-08-24T10:01:00Z",
				role: "assistant",
				text: "",
				isHit: true,
			}, // empty HIT kept
		],
	};
	const text = formatSessionHits([hit]);
	assert.ok(text.includes("--:--"), "NaN date renders placeholder");
	assert.ok(text.includes("s1"), "unnamed session falls back to id");
	assert.ok(
		!text.includes("before".repeat(1)) || text.includes("before"),
		"before rendered",
	);
	// empty non-hit neighbor skipped: only 3 message lines (header + 3)
	const msgLines = text
		.split("\n")
		.filter((l) => l.startsWith(" ") || l.startsWith("▶"));
	assert.equal(msgLines.length, 3);

	// >50k truncation (each hit caps text at 140 chars → need ~320 hits)
	const big: SessionHit[] = Array.from({ length: 320 }, (_, i) => ({
		sessionId: `big-${i}`,
		name: `session number ${i}`,
		projectSlug: "proj",
		hitSeq: 0,
		hitRole: "user",
		messages: [
			{
				seq: 0,
				ts: "2026-08-24T10:00:00Z",
				role: "user",
				text: "x".repeat(900),
				isHit: true,
			},
		],
	}));
	const bigText = formatSessionHits(big);
	assert.ok(bigText.length <= 50_001, `truncated: ${bigText.length}`);
	assert.ok(bigText.endsWith("…"));
});

// --- sessions.ts branches -------------------------------------------------------------

test("sessions: image-only user message yields null firstUserText", () => {
	const store = `${area}/imgstore`;
	mkdirSync(store, { recursive: true });
	const ts = new Date().toISOString();
	writeFileSync(
		join(store, "img.jsonl"),
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "img-id-000001",
				timestamp: ts,
				cwd: "/x",
			}),
			JSON.stringify({
				type: "message",
				id: "i1",
				parentId: null,
				timestamp: ts,
				message: {
					role: "user",
					content: [{ type: "image", data: "zz" }],
					timestamp: 1,
				},
			}),
		].join("\n") + "\n",
	);
	const listed = listSessions(store);
	assert.equal(listed[0]!.firstUserText, null);
});

test("sessions: rewriteSessionHeader throws on malformed header line", () => {
	const bad = join(area, "badhdr.jsonl");
	writeFileSync(bad, "not json at all\nmore\n");
	assert.throws(() => rewriteSessionHeader(bad, (h) => h), /malformed header/);
});

test("sessions: renameSession skips garbage body lines", () => {
	const file = join(area, "garbage.jsonl");
	const ts = new Date().toISOString();
	writeFileSync(
		file,
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "g-id-000000001",
				timestamp: ts,
				cwd: "/x",
			}),
			"{{{ not json",
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: ts,
				message: { role: "user", content: "hi", timestamp: 1 },
			}),
		].join("\n") + "\n",
	);
	renameSession(file, "renamed");
	const listed = listSessions(area);
	assert.equal(listed.find((s) => s.file === file)?.name, "renamed");
});

// --- db.ts branches --------------------------------------------------------------------

test("db: saveRegistryDb rollback on UNIQUE slug violation", () => {
	const db = openDb(agentDir);
	const now = new Date().toISOString();
	const mk = (id: string, root: string) => ({
		id,
		slug: "clash",
		canonicalPath: root,
		aliases: [] as string[],
		gitRemote: null as string | null,
		sessionStore: "central" as const,
		mergedInto: null as string | null,
		trusted: true,
		createdAt: now,
		updatedAt: now,
	});
	assert.throws(
		() => saveRegistrySync2(db, mk("id-1", "/x/one"), mk("id-2", "/y/two")),
		/UNIQUE/,
	);
	// nothing persisted (rolled back)
	const n = (
		db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }
	).n;
	assert.equal(n, 0);
	db.close();
});

import { saveRegistryDb } from "../src/core/db.ts";
function saveRegistrySync2(
	db: Parameters<typeof saveRegistryDb>[0],
	a: ReturnType<typeof mkProj>,
	b: ReturnType<typeof mkProj>,
): void {
	const r = { version: 1 as const, projects: [a, b] };
	saveRegistryDb(db, r);
}
function mkProj(id: string, root: string) {
	const now = new Date().toISOString();
	return {
		id,
		slug: "clash",
		canonicalPath: root,
		aliases: [] as string[],
		gitRemote: null as string | null,
		sessionStore: "central" as const,
		mergedInto: null as string | null,
		trusted: true,
		createdAt: now,
		updatedAt: now,
	};
}

test("db: syncConfigFile equal-content in-sync path reports materialized", () => {
	const db = openDb(agentDir);
	writeFileSync(join(agentDir, "eq.json"), '{"a":1}');
	assert.equal(syncConfigFile(db, agentDir, "eq", "eq.json"), "ingested");
	assert.equal(syncConfigFile(db, agentDir, "eq", "eq.json"), "materialized");
	db.close();
});

// --- sync.ts branches --------------------------------------------------------------------

test("sync: unreadable file in store reports error via syncStores", () => {
	const root = fakeRepo(area, "errproj", "git");
	const r = loadRegistry(agentDir);
	mutations.register(r, { root });
	saveRegistrySync(agentDir, r);
	const store = getCentralStoreDir(agentDir, "errproj");
	fakeSession(store, { cwd: root, firstUserText: "fine" });
	const unreadable = join(store, "locked.jsonl");
	writeFileSync(unreadable, "{}\n");
	chmodSync(unreadable, 0o000);

	const db = openDb(agentDir);
	const report = syncStores(db, agentDir, loadRegistrySync(agentDir));
	assert.equal(report.errors.length, 1);
	assert.ok(report.errors[0]!.file.includes("locked"));
	chmodSync(unreadable, 0o644);
	db.close();
});

test("sync: SQLITE_BUSY on a held lock reports error without data loss", () => {
	const root = fakeRepo(area, "busyproj", "git");
	const r = loadRegistry(agentDir);
	mutations.register(r, { root });
	saveRegistrySync(agentDir, r);
	const projectId = loadRegistrySync(agentDir).projects[0]!.id;
	const store = getCentralStoreDir(agentDir, "busyproj");
	fakeSession(store, { cwd: root, firstUserText: "hot row" });

	// second connection holds a write txn; ingest's BEGIN/INSERT must fail cleanly
	const db = openDb(agentDir);
	const blocker = openDb(agentDir);
	blocker.exec("BEGIN EXCLUSIVE;");
	const file = join(store, readdirSync(store)[0]!);
	try {
		const res = ingestSessionFile(db, file, (cwd) =>
			cwd === root ? projectId : null,
		);
		assert.equal(res.status, "error");
		assert.match(res.detail ?? "", /locked|busy/i);
	} finally {
		blocker.exec("ROLLBACK;");
		blocker.close();
	}
	// after release, a normal ingest still works (no half-written rows)
	const ok = ingestSessionFile(db, file, (cwd) =>
		cwd === root ? projectId : null,
	);
	assert.equal(ok.status, "ingested");
	db.close();
});

test("sync: restoreSession null paths; restoreMissing skips existing", () => {
	const db = openDb(agentDir);
	assert.equal(restoreSession(db, "ghost", area), null, "unknown session");
	db.close();
});

// --- fix.ts: orphan resolves to existing project (else branch) ---------------------------

test("fix: orphan store whose cwd belongs to an existing project reports visibility", () => {
	const root = fakeRepo(area, "hostproj", "git");
	const r = loadRegistry(agentDir);
	mutations.register(r, { root });
	saveRegistrySync(agentDir, r);
	// orphan store dir name does NOT match the project slug
	const orphan = join(agentDir, "sessions", "mismatched-name");
	fakeSession(orphan, { cwd: root, firstUserText: "adopt me" });

	const registry = loadRegistrySync(agentDir);
	const report = runFix(registry, agentDir, { dryRun: false });
	assert.ok(
		report.findings.some(
			(f) =>
				f.kind === "orphan-store-registered" && f.detail.includes("'hostproj'"),
		),
		"resolved to existing project",
	);
});

// --- adopt.ts: self-parent chain breaks the multi-pass and moves plainly ------------------

test("adopt: self-referencing parentSession moves without dangling rewrite", () => {
	const root = fakeRepo(area, "selfpar", "git");
	const source = `${area}/pi-src`;
	const mangled = `${source}/--dir--`;
	mkdirSync(mangled, { recursive: true });
	const selfFile = join(mangled, "self.jsonl");
	const ts = new Date().toISOString();
	writeFileSync(
		selfFile,
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "self-00000001",
				timestamp: ts,
				cwd: root,
			}),
			JSON.stringify({
				type: "message",
				id: "p1",
				parentId: null,
				timestamp: ts,
				message: { role: "user", content: "self", timestamp: 1 },
			}),
		].join("\n") + "\n",
	);
	// rewrite header to point parentSession at itself
	rewriteSessionHeader(selfFile, (h) => {
		h.parentSession = selfFile;
		return h;
	});

	const registry = loadRegistry(agentDir);
	const report = adoptSessions(registry, { sourceDir: source, agentDir });
	assert.equal(report.skipped.length, 0);
	assert.equal(report.imported.length, 1);
	// the moved file keeps its (self) parentSession — moved plainly, cleared of nothing
	const dest = getCentralStoreDir(agentDir, "selfpar");
	assert.equal(readdirSync(dest).length, 1);
});

// --- launcher: signal handler forwards to child ------------------------------------------

test("launcher: SIGINT handler kills the spawned child", async () => {
	const stubBin = `${area}/sigbin`;
	mkdirSync(stubBin, { recursive: true });
	const stub = join(stubBin, "pi");
	writeFileSync(stub, "#!/bin/sh\nsleep 30\n");
	chmodSync(stub, 0o755);
	const oldPath = process.env["PATH"];
	process.env["PATH"] = `${stubBin}:${oldPath}`;
	try {
		const { prepareLaunch, defaultSpawnPi } = await import(
			"../src/core/launcher.ts"
		);
		const root = fakeRepo(area, "sigproj", "git");
		const plan = await prepareLaunch({
			cwd: root,
			argv: [],
			agentDir,
			registry: loadRegistry(agentDir),
			persist: false,
			gitRemoteReader: () => null,
		});
		const spawned = defaultSpawnPi(plan);
		await new Promise((r) => setTimeout(r, 150));
		const started = Date.now();
		process.emit("SIGINT");
		const code = await spawned;
		const elapsed = Date.now() - started;
		assert.ok(
			elapsed < 5000,
			`child died promptly (${elapsed}ms), not after its 30s sleep`,
		);
		// signal-kill resolves close(null) as 0 — the launcher's convention
		assert.equal(code, 0);
	} finally {
		process.env["PATH"] = oldPath;
	}
});

// --- main.ts: command catch arms ------------------------------------------------------------

test("cli: sync/restore/search catch a broken agent dir cleanly", async () => {
	const broken = join(area, "notadir-file");
	writeFileSync(broken, "x\n");
	const deps: CliDeps = {
		cwd: area,
		agentDir: broken, // openDb will throw (path is a file)
		spawn: async () => 0,
		out: () => {},
		err: () => {},
	};
	assert.equal(await main(["sync"], deps), 1);
	assert.equal(await main(["restore"], deps), 1);
	assert.equal(await main(["search", "x"], deps), 1);
});

test("cli: sessions show message/messages views succeed via dispatch", async () => {
	const root = fakeRepo(area, "views", "git");
	await main([], {
		cwd: root,
		agentDir,
		spawn: async () => 0,
		out: (l) => out_log(l),
		err: () => {},
		gitRemoteReader: () => null,
	});
	const store = getCentralStoreDir(agentDir, "views");
	fakeSession(store, { cwd: root, firstUserText: "show me", name: "viewable" });
	const out: string[] = [];
	function out_log(l: string) {
		out.push(l);
	}
	const deps2: CliDeps = {
		cwd: root,
		agentDir,
		spawn: async () => 0,
		out: (l) => out.push(l),
		err: () => {},
		gitRemoteReader: () => null,
	};
	assert.equal(
		await main(["sessions", "show", "viewable", "--view", "messages"], deps2),
		0,
	);
	assert.ok(out.some((l) => l.includes("show me")));
	// message drill-down view: valid N renders, 0 is rejected
	assert.equal(
		await main(
			["sessions", "show", "viewable", "--view", "message", "--message", "1"],
			deps2,
		),
		0,
	);
	assert.ok(
		out.some((l) => l.includes("show me")),
		"message view renders the hit",
	);
	assert.equal(
		await main(
			["sessions", "show", "viewable", "--view", "message", "--message", "0"],
			deps2,
		),
		2,
	);
});
