/**
 * The last six branch points: store-less projects, zero-ready checkpoints,
 * valid --context, merge without store, pre-set PI_OFFLINE, empty-name info.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { main, type CliDeps } from "../src/cli/main.ts";
import { openDb, saveRegistrySync, loadRegistryDb } from "../src/core/db.ts";
import { entryText, syncStores } from "../src/core/sync.ts";
import { checkpointDigest } from "../src/core/todo-store.ts";
import { mutations, loadRegistry } from "../src/core/registry.ts";
import { getCentralStoreDir } from "../src/core/agent-dir.ts";
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
	area = tmpDir("bb-six-");
});
afterEach(() => {
	cleanup(agentDir, area);
});

test("syncStores: project with no store dir is skipped silently", () => {
	const rootA = fakeRepo(area, "hasstore", "git");
	const rootB = fakeRepo(area, "nostore", "git"); // registered, no sessions ever
	const r = loadRegistry(agentDir);
	mutations.register(r, { root: rootA });
	mutations.register(r, { root: rootB });
	saveRegistrySync(agentDir, r);
	fakeSession(getCentralStoreDir(agentDir, "hasstore"), {
		cwd: rootA,
		firstUserText: "only one",
	});

	const db = openDb(agentDir);
	const report = syncStores(db, agentDir, loadRegistryDb(db));
	assert.equal(report.ingested, 1);
	assert.equal(report.errors.length, 0);
	db.close();
});

test("checkpointDigest: board with zero ready tasks omits NEXT", () => {
	const db = openDb(agentDir);
	const pid = "six";
	db
		.prepare(
			"INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES (?, 's', '/s', ?, ?)",
		)
		.run(pid, new Date().toISOString(), new Date().toISOString());
	// every todo blocked by the first
	const { createTodo, addDep } = require_todo();
	const gate = createTodo(db, pid, "gate", { sessionId: "sx" });
	const blocked = createTodo(db, pid, "blocked", { sessionId: "sx" });
	addDep(db, pid, blocked.todo!.hex6, gate.todo!.hex6, { sessionId: "sx" });

	const digest = checkpointDigest(db, pid, "s", "sx");
	assert.ok(digest.includes("NEXT"), "gate is ready → NEXT lists it");
	assert.ok(!digest.includes("NOW"), "nothing doing yet");
	// gate DONE + blocked picked up → no ready tasks at all
	const { setStage } = require_todo();
	setStage(db, pid, gate.todo!.hex6, "done", { sessionId: "sx" });
	setStage(db, pid, blocked.todo!.hex6, "doing", { sessionId: "sx" });
	const digest2 = checkpointDigest(db, pid, "s", "sx");
	assert.ok(!digest2.includes("NEXT"), "no ready tasks → no NEXT line");
	assert.ok(digest2.includes("NOW"), "blocked now doing → NOW lists it");
	db.close();
});

function require_todo() {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return todo_mod;
}
import * as todo_mod from "../src/core/todo-store.ts";

test("cli: search --context 2 applies a tight window", async () => {
	const root = fakeRepo(area, "ctxwin", "git");
	const deps: CliDeps = {
		cwd: root,
		agentDir,
		// deno-lint-ignore require-await
		runPi: async () => 0,
		out: () => {},
		err: () => {},
		gitRemoteReader: () => null,
	};
	await main([], deps);
	fakeSession(getCentralStoreDir(agentDir, "ctxwin"), {
		cwd: root,
		firstUserText: "windowed needle hit",
		entries: 6,
	});
	await main(["sync"], deps);
	const out2: string[] = [];
	const deps2: CliDeps = { ...deps, out: (l) => out2.push(l) };
	assert.equal(
		await main(["search", "windowed needle", "--context", "2"], deps2),
		0,
	);
	// with context 2 the neighborhood is small; hit marker present
	assert.ok(out2.some((l) => l.includes("▶")));
});

test("registry: merge with source store absent reports zero moved", () => {
	const r = loadRegistry(agentDir);
	mutations.register(r, { root: "/six/a6" });
	mutations.register(r, { root: "/six/b6" }); // no store dirs on disk
	const { survivor, moved } = mutations.merge(agentDir, r, "a6", "b6");
	assert.equal(survivor.slug, "b6");
	assert.equal(moved, 0);
});

test("launcher: pre-set PI_OFFLINE is preserved, not forced to 1", async () => {
	const { prepareLaunch } = await import("../src/core/launcher.ts");
	const root = fakeRepo(area, "offline", "git");
	const prev = process.env["PI_OFFLINE"];
	process.env["PI_OFFLINE"] = "0";
	try {
		const plan = await prepareLaunch({
			cwd: root,
			argv: [],
			agentDir,
			registry: loadRegistry(agentDir),
			persist: false,
			gitRemoteReader: () => null,
		});
		assert.equal(plan.env["PI_OFFLINE"], "0", "user override respected");
	} finally {
		if (prev === undefined) delete process.env["PI_OFFLINE"];
		else process.env["PI_OFFLINE"] = prev;
	}
});

test("sync: entryText with empty-name session_info returns null", () => {
	assert.equal(entryText({ type: "session_info", name: "" }), null);
});
