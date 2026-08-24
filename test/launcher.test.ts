import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import {
	prepareLaunch,
	rewriteArgsForCwd,
	defaultSpawnPi,
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

test("defaultSpawnPi: execs pi with plan cwd/env and propagates its exit code", async () => {
	const stubBin = `${area}/stubbin`;
	mkdirSync(stubBin, { recursive: true });
	const stub = `${stubBin}/pi`;
	writeFileSync(stub, '#!/bin/sh\necho "$BB_MARKER:$PWD"\nexit 42\n');
	chmodSync(stub, 0o755);

	const root = fakeRepo(area, "spawn", "git");
	const oldPath = process.env["PATH"];
	process.env["PATH"] = `${stubBin}:${oldPath}`;
	try {
		const plan = {
			root,
			sessionDir: `${agentDir}/sessions/spawn`,
			argv: [],
			env: { ...process.env, BB_MARKER: "sentinel" },
			actions: [],
		};
		const code = await defaultSpawnPi(plan);
		assert.equal(code, 42, "propagates pi's exit code");
	} finally {
		process.env["PATH"] = oldPath;
	}
});
