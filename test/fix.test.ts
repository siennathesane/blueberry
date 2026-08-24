import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { runFix, runDoctor } from "../src/core/fix.ts";
import { loadRegistry, mutations, findBySlug } from "../src/core/registry.ts";
import { getCentralStoreDir } from "../src/core/agent-dir.ts";
import { readSessionHeader } from "../src/core/sessions.ts";
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
	area = tmpDir("bb-fix-");
});
afterEach(() => {
	cleanup(agentDir, area);
});

test("fix: registers orphan stores by majority header cwd", () => {
	const root = fakeRepo(area, "orphan", "git");
	// store dir exists with sessions but no registry project
	const orphanStore = getCentralStoreDir(agentDir, "orphan");
	fakeSession(orphanStore, { cwd: root, firstUserText: "a" });
	fakeSession(orphanStore, { cwd: root, firstUserText: "b" });

	const r = loadRegistry(agentDir);
	const report = runFix(r, agentDir);

	assert.ok(
		report.findings.some(
			(f) => f.kind === "orphan-store-registered" && f.detail.includes("'orphan'"),
		),
	);
	const p = findBySlug(r, "orphan");
	assert.ok(p, "project registered");
	assert.equal(p!.canonicalPath, root);
});

test("fix: dry-run reports without mutating", () => {
	const root = fakeRepo(area, "dry", "git");
	const orphanStore = getCentralStoreDir(agentDir, "dry");
	fakeSession(orphanStore, { cwd: root });

	const r = loadRegistry(agentDir);
	const report = runFix(r, agentDir, { dryRun: true });

	assert.equal(report.dryRun, true);
	assert.ok(
		report.findings.some(
			(f) => f.kind === "orphan-store-registered" && f.detail.startsWith("would"),
		),
	);
	assert.equal(r.projects.length, 0, "registry untouched in dry-run");
});

test("fix: unresolvable orphan store reported without cwd", () => {
	const orphanStore = getCentralStoreDir(agentDir, "mystery");
	fakeSession(orphanStore, { cwd: "" });

	const r = loadRegistry(agentDir);
	const report = runFix(r, agentDir, { dryRun: true });

	assert.ok(
		report.findings.some(
			(f) =>
				f.kind === "orphan-store-unresolvable" && f.detail.includes("'mystery'"),
		),
	);
});

test("fix: normalizes session cwds to project canonical path", () => {
	const root = fakeRepo(area, "norm", "git");
	const r = loadRegistry(agentDir);
	mutations.register(r, { root });
	const store = getCentralStoreDir(agentDir, "norm");
	// session with a stale cwd (old machine layout, e.g. subdirectory launch)
	fakeSession(store, { cwd: `${root}/subdir`, firstUserText: "x" });

	const report = runFix(r, agentDir);

	assert.ok(report.findings.some((f) => f.kind === "cwd-normalized"));
	for (const f of readdirSync(store)) {
		assert.equal(readSessionHeader(`${store}/${f}`)?.cwd, root);
	}
});

test("fix: clears dangling parentSession references", () => {
	const root = fakeRepo(area, "dang", "git");
	const r = loadRegistry(agentDir);
	mutations.register(r, { root });
	const store = getCentralStoreDir(agentDir, "dang");
	fakeSession(store, { cwd: root, parentSession: "/gone/parent.jsonl" });

	const report = runFix(r, agentDir);

	assert.ok(report.findings.some((f) => f.kind === "parent-session-cleared"));
	for (const f of readdirSync(store)) {
		assert.equal(readSessionHeader(`${store}/${f}`)?.parentSession, undefined);
	}
});

test("fix: reports stale projects whose paths are all gone", () => {
	const root = `${area}/vanished`;
	const r = loadRegistry(agentDir);
	mutations.register(r, { root }); // root never created on disk

	const report = runFix(r, agentDir, { dryRun: true });

	assert.ok(
		report.findings.some(
			(f) => f.kind === "stale-project" && f.detail.includes("'vanished'"),
		),
	);
});

test("fix: flags duplicate projects sharing a git remote", () => {
	const r = loadRegistry(agentDir);
	const a = mutations.register(r, {
		root: "/x/one",
		gitRemote: "https://github.com/u/dup",
	});
	const b = mutations.register(r, {
		root: "/y/two",
		gitRemote: "https://github.com/u/dup",
	});
	assert.ok(a && b);

	const report = runFix(r, agentDir, { dryRun: true });

	assert.ok(
		report.findings.some(
			(f) =>
				f.kind === "duplicate-project" && f.detail.includes("bb projects merge"),
		),
	);
});

test("fix: in-repo project reports missing store harmlessly", () => {
	const root = fakeRepo(area, "inrepo", "git");
	const r = loadRegistry(agentDir);
	mutations.register(r, { root });
	mutations.setStoreMode(agentDir, r, "inrepo", "in-repo");

	const report = runFix(r, agentDir, { dryRun: true });

	assert.ok(
		report.findings.some(
			(f) => f.kind === "in-repo-store-missing" && f.detail.includes("'inrepo'"),
		),
	);
});

test("doctor: is fix --dry-run", () => {
	const root = fakeRepo(area, "doc", "git");
	const orphanStore = getCentralStoreDir(agentDir, "doc");
	fakeSession(orphanStore, { cwd: root });

	const r = loadRegistry(agentDir);
	const doctor = runDoctor(r, agentDir);
	assert.equal(doctor.dryRun, true);
	assert.equal(r.projects.length, 0);

	const fixed = runFix(r, agentDir);
	assert.equal(r.projects.length, 1);
	assert.ok(fixed.findings.length >= doctor.findings.length - 1);
});
