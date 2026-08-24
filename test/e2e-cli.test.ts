/**
 * Full-UX CLI tests: the real bin/blueberry as a subprocess.
 * Covers the whole binary chain (bash → node → entry → main) and the
 * read/inspect commands against real on-disk state.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	cleanupSessions,
	destroyWorld,
	makeWorld,
	runCli,
	type UxWorld,
} from "./harness.ts";
import { saveRegistrySync } from "../src/core/db.ts";
import { loadRegistry, mutations } from "../src/core/registry.ts";
import { getCentralStoreDir } from "../src/core/agent-dir.ts";
import { fakeSession } from "./helpers.ts";
import { getVersion } from "../src/core/version.ts";

let world: UxWorld;

beforeEach(() => {
	world = makeWorld("cli");
});
afterEach(() => {
	destroyWorld(world);
	cleanupSessions();
});

test("ux cli: --version through the real binary", async () => {
	const r = await runCli(["--version"], world);
	assert.equal(r.code, 0);
	assert.equal(r.stdout.trim(), `blueberry ${getVersion()}`);
});

test("ux cli: empty-state commands are clean, not crashes", async () => {
	const doctor = await runCli(["doctor"], world);
	assert.equal(doctor.code, 0);
	assert.ok(doctor.stdout.includes("all clear"));

	const projects = await runCli(["projects", "list"], world);
	assert.equal(projects.code, 0);
	assert.ok(projects.stdout.includes("no projects registered"));

	const search = await runCli(["search", "anything"], world);
	assert.equal(search.code, 0);
	assert.ok(search.stdout.includes("no matches"));

	const sync = await runCli(["sync"], world);
	assert.equal(sync.code, 0);
	assert.ok(sync.stdout.includes("0 ingested"));

	const restore = await runCli(["restore"], world);
	assert.equal(restore.code, 0);
	assert.ok(restore.stdout.includes("nothing missing"));
});

test("ux cli: sessions list / sync / search / restore over real state", async () => {
	// arrange a real project + session store (state via modules, UX via binary)
	const root = world.projectDir;
	mkdirSync(join(root, ".git"), { recursive: true });
	const r = loadRegistry(world.agentDir);
	mutations.register(r, { root });
	saveRegistrySync(world.agentDir, r);
	const store = getCentralStoreDir(world.agentDir, root.split("/").pop()!);
	fakeSession(store, { cwd: root, firstUserText: "the e2e needle lives here", name: "e2e-session" });

	const list = await runCli(["sessions", "list"], world);
	assert.equal(list.code, 0);
	assert.ok(list.stdout.includes("e2e-session"), "named session listed");

	const sync = await runCli(["sync"], world);
	assert.equal(sync.code, 0);
	assert.ok(sync.stdout.includes("1 ingested"));

	const search = await runCli(["search", "e2e needle"], world);
	assert.equal(search.code, 0);
	assert.ok(search.stdout.includes("▶"), "hit marked");
	assert.ok(search.stdout.includes("the e2e needle lives here"));
	assert.ok(/\d{2}-\d{2} \d{2}:\d{2}/.test(search.stdout), "timestamps in neighborhood");

	// delete the file; restore rebuilds from the DB
	const file = readdirSync(store).find((f) => f.endsWith(".jsonl"))!;
	rmSync(join(store, file));
	const restore = await runCli(["restore"], world);
	assert.equal(restore.code, 0);
	assert.ok(restore.stdout.includes("restored"));
	assert.equal(readdirSync(store).length, 1);
});

test("ux cli: usage errors exit 2 through the binary", async () => {
	const r = await runCli(["projects", "rename"], world);
	assert.equal(r.code, 2);
	assert.ok(r.stderr.includes("usage:"));
});

test("ux cli: unknown subcommand is treated as pi launch (spawned)", async () => {
	// launch mode spawns pi; with pi absent from PATH the error path still exits cleanly
	const r = await runCli(["--project", "ghost"], world);
	assert.equal(r.code, 1);
	assert.ok(r.stderr.includes("no project 'ghost'"));
});
