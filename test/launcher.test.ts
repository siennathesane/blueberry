import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
	prepareLaunch,
	rewriteArgsForCwd,
	defaultRunPi,
	setPiMainLoader,
} from "../src/core/launcher.ts";
import { findBySlug } from "../src/core/registry.ts";
import { loadRegistrySync } from "../src/core/db.ts";
import { getCentralStoreDir } from "../src/core/agent-dir.ts";
import { readTrust } from "../src/core/trust.ts";
import { tmpAgentDir, tmpDir, fakeRepo, cleanup } from "./helpers.ts";

let agentDir: string;
let area: string;

beforeEach(() => {
	agentDir = tmpAgentDir();
	area = tmpDir("bb-launch-");
});
afterEach(() => {
	cleanup(agentDir, area);
});

test("rewriteArgsForCwd: @refs and path flags absolutized; bare tokens untouched", () => {
	const out = rewriteArgsForCwd(
		[
			"@./notes.md",
			"--session",
			"abc123",
			"-e",
			"./ext.ts",
			"--theme",
			"../themes/t.json",
			"plain prompt",
			"@/abs/file.txt",
		],
		"/work/proj",
	);
	assert.deepEqual(out, [
		"@/work/proj/notes.md",
		"--session",
		"abc123", // uuid-ish bare token: untouched
		"-e",
		"/work/proj/ext.ts",
		"--theme",
		"/work/themes/t.json",
		"plain prompt", // prompt text: untouched
		"@/abs/file.txt",
	]);
});

test("rewriteArgsForCwd: --flag=value form", () => {
	const out = rewriteArgsForCwd(
		["--session=./s.jsonl", "--thinking=high"],
		"/w/p",
	);
	assert.deepEqual(out, ["--session=/w/p/s.jsonl", "--thinking=high"]);
});

test("prepareLaunch: canonicalizes to project root, sets env, creates store", async () => {
	const root = fakeRepo(area, "canon", "git");
	mkdirSync(root + "/deep/sub", { recursive: true });

	const plan = await prepareLaunch({
		cwd: root + "/deep/sub",
		argv: ["hello"],
		agentDir,
		registry: loadRegistrySync(agentDir),
		persist: false,
		gitRemoteReader: () => null,
	});

	assert.equal(plan.root, root, "cwd canonicalized to project root");
	assert.equal(plan.sessionDir, getCentralStoreDir(agentDir, "canon"));
	assert.ok(existsSync(plan.sessionDir), "store dir created");
	assert.equal(plan.env["PI_CODING_AGENT_DIR"], agentDir);
	assert.equal(plan.env["PI_CODING_AGENT_SESSION_DIR"], plan.sessionDir);
});

test("prepareLaunch: registry persisted and trust written when persist enabled", async () => {
	const root = fakeRepo(area, "persisted", "git");
	await prepareLaunch({
		cwd: root,
		argv: [],
		agentDir,
		gitRemoteReader: () => null,
	});

	const r = loadRegistrySync(agentDir);
	assert.ok(findBySlug(r, "persisted"));
	assert.equal(
		readTrust(agentDir)[root],
		true,
		"trust.json written for project root",
	);
});

test("prepareLaunch: --here keeps cwd but still uses project store", async () => {
	const root = fakeRepo(area, "hereproj", "git");
	const sub = root + "/sub";
	mkdirSync(sub, { recursive: true });

	const plan = await prepareLaunch({
		cwd: sub,
		argv: [],
		agentDir,
		here: true,
		persist: false,
		gitRemoteReader: () => null,
	});

	assert.equal(plan.root, sub, "--here: cwd NOT canonicalized");
	assert.equal(plan.sessionDir, getCentralStoreDir(agentDir, "hereproj"));
	assert.ok(plan.actions.some((a) => a.includes("--here")));
});

test("prepareLaunch: --project forces a registered project from anywhere", async () => {
	const rootA = fakeRepo(area, "target", "git");
	// register target first
	await prepareLaunch({
		cwd: rootA,
		argv: [],
		agentDir,
		gitRemoteReader: () => null,
	});
	const elsewhere = tmpDir("bb-elsewhere-");

	const plan = await prepareLaunch({
		cwd: elsewhere,
		argv: [],
		agentDir,
		projectSlug: "target",
		persist: false,
		gitRemoteReader: () => null,
	});

	assert.equal(plan.root, rootA);
	cleanup(elsewhere);
});

test("prepareLaunch: --project with unknown slug errors with known list", async () => {
	const root = fakeRepo(area, "known", "git");
	await prepareLaunch({
		cwd: root,
		argv: [],
		agentDir,
		gitRemoteReader: () => null,
	});

	await assert.rejects(
		prepareLaunch({
			cwd: root,
			argv: [],
			agentDir,
			projectSlug: "ghost",
			persist: false,
		}),
		/known: known/,
	);
});

test("prepareLaunch: bare-dir launch mints a plain project at cwd", async () => {
	const solo = tmpDir("bb-solo-");
	const plan = await prepareLaunch({
		cwd: solo,
		argv: [],
		agentDir,
		registry: loadRegistrySync(agentDir),
		persist: false,
		gitRemoteReader: () => null,
	});

	assert.equal(plan.root, solo);
	assert.ok(existsSync(solo + "/.blueberry/id"), "plain marker minted at root");
	cleanup(solo);
});

test("prepareLaunch: nested project follows merge to parent root and store", async () => {
	const outer = fakeRepo(area, "ship", "git");
	const inner = fakeRepo(outer, "cabin", "git");

	// register both (persist: false, single registry)
	const registry = loadRegistrySync(agentDir);
	await prepareLaunch({
		cwd: outer,
		argv: [],
		agentDir,
		registry,
		persist: false,
		gitRemoteReader: () => null,
	});
	await prepareLaunch({
		cwd: inner,
		argv: [],
		agentDir,
		registry,
		persist: false,
		gitRemoteReader: () => null,
	});

	// nest cabin into ship using the same registry object
	const { mutations } = await import("../src/core/registry.ts");
	mutations.setNested(registry, "cabin", "ship");

	const plan = await prepareLaunch({
		cwd: inner,
		argv: [],
		agentDir,
		registry,
		persist: false,
		gitRemoteReader: () => null,
	});

	assert.equal(
		plan.root,
		outer,
		"launch from nested project canonicalizes to parent",
	);
	assert.equal(plan.sessionDir, getCentralStoreDir(agentDir, "ship"));
});

test("defaultRunPi: calls the fork main in-process with plan cwd/env, propagates exit code, restores state", async () => {
	// single-binary reality: the fork main is a library call, verified via the
	// test loader seam — no subprocess anywhere
	const seen: { cwd?: string; argv?: string[]; db?: string; agentDir?: string } = {};
	const root = fakeRepo(area, "runpi", "git");
	const prevCwd = Deno.cwd();
	setPiMainLoader(async () => async (argv: string[]) => {
		seen.cwd = Deno.cwd();
		seen.argv = argv;
		seen.db = process.env["BLUEBERRY_DB"];
		seen.agentDir = process.env["PI_CODING_AGENT_DIR"];
		process.exitCode = 42;
	});
	try {
		const plan = {
			root,
			sessionDir: `${agentDir}/sessions/runpi`,
			argv: ["--print", "x"],
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			actions: [],
		};
		const code = await defaultRunPi(plan);
		assert.equal(code, 42, "propagates the fork exit code");
		// realPath both sides: macOS tmpdirs are /var → /private/var symlinks
		assert.equal(
			seen.cwd,
			Deno.realPathSync(root),
			"cwd handed over to plan root",
		);
		assert.deepEqual(seen.argv, ["--print", "x"], "argv passed through");
		assert.ok(seen.db?.endsWith("blueberry.db"), "BLUEBERRY_DB set from agent dir");
		assert.equal(seen.agentDir, agentDir, "agent dir handed over");
		assert.equal(Deno.cwd(), prevCwd, "cwd restored after the run");
		assert.equal(process.env["BLUEBERRY_DB"], undefined, "handover env restored");
	} finally {
		setPiMainLoader(null);
	}
});
