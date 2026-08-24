import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { resolveProject, storeDirFor } from "../src/core/resolution.ts";
import { loadRegistry, mutations, findBySlug } from "../src/core/registry.ts";
import { getCentralStoreDir, getInRepoStoreDir } from "../src/core/agent-dir.ts";
import { readMarkerId, findProjectBoundary } from "../src/core/markers.ts";
import { tmpAgentDir, tmpDir, fakeRepo, cleanup } from "./helpers.ts";

let agentDir: string;
let area: string;

beforeEach(() => {
	agentDir = tmpAgentDir();
	area = tmpDir("bb-resolve-");
});
afterEach(() => {
	cleanup(agentDir, area);
});

test("resolution: mints a new project and writes its marker", () => {
	const r = loadRegistry(agentDir);
	const root = fakeRepo(area, "fresh", "git");
	const res = resolveProject({ cwd: root, registry: r });

	assert.equal(res.status, "new");
	assert.equal(res.project.slug, "fresh");
	assert.equal(res.root, root);
	assert.ok(res.registryMutated);
	// marker written and readable
	assert.equal(readMarkerId(findProjectBoundary(root)!), res.project.id);
	assert.ok(existsSync(`${root}/.git/blueberry-id`));
});

test("resolution: marker fast path hits registry by id", () => {
	const r = loadRegistry(agentDir);
	const root = fakeRepo(area, "marked", "git");
	const res1 = resolveProject({ cwd: root, registry: r });
	const res2 = resolveProject({ cwd: root, registry: r });
	assert.equal(res2.status, "marker");
	assert.equal(res2.project.id, res1.project.id);
	assert.ok(!res2.registryMutated);
});

test("resolution: git remote match auto-reattaches a moved clone", () => {
	const r = loadRegistry(agentDir);
	const original = fakeRepo(area, "moved", "git");
	const res1 = resolveProject({ cwd: original, registry: r, gitRemoteReader: () => null });
	// simulate remote discovered after first registration
	mutations.touch(r, findBySlug(r, "moved")!);
	findBySlug(r, "moved")!.gitRemote = "https://github.com/u/moved";

	// clone at a new path with the same remote and no marker
	const clone = fakeRepo(area, "moved-clone", "git");
	const res2 = resolveProject({ cwd: clone, registry: r, gitRemoteReader: () => "https://github.com/u/moved" });

	assert.equal(res2.status, "remote");
	assert.equal(res2.project.id, res1.project.id);
	assert.equal(res2.project.canonicalPath, clone);
	assert.ok(res2.project.aliases.includes(original));
	// marker written into the clone for next time
	assert.equal(readMarkerId(findProjectBoundary(clone)!), res1.project.id);
});

test("resolution: alias match reattaches when repo returns to an old path", () => {
	const r = loadRegistry(agentDir);
	const a = fakeRepo(area, "shuttle", "git");
	const res1 = resolveProject({ cwd: a, registry: r, gitRemoteReader: () => null });

	// repo moves away: project reattached to B, A becomes an alias
	const area2 = tmpDir("bb-resolve2-");
	const b = fakeRepo(area2, "shuttle", "git");
	mutations.reattach(r, res1.project, b);

	// repo moves back to A: B is gone, marker at A was lost in the shuffle
	rmSync(`${a}/.git/blueberry-id`);
	cleanup(area2);

	const res2 = resolveProject({ cwd: a, registry: r, gitRemoteReader: () => null });
	assert.equal(res2.status, "path");
	assert.equal(res2.project.id, res1.project.id);
	assert.equal(res2.project.canonicalPath, a);
	// marker rewritten so next launch takes the fast path
	assert.equal(readMarkerId(findProjectBoundary(a)!), res1.project.id);
});

test("resolution: alias match refuses to steal while canonical path still exists", () => {
	const r = loadRegistry(agentDir);
	const a = fakeRepo(area, "twin-a", "git");
	const res1 = resolveProject({ cwd: a, registry: r, gitRemoteReader: () => null });

	// project now lives at B (both checkouts present: a copy, no marker, no remote)
	const b = fakeRepo(area, "twin-b", "git");
	mutations.reattach(r, res1.project, b);
	rmSync(`${a}/.git/blueberry-id`);

	const res2 = resolveProject({ cwd: a, registry: r, gitRemoteReader: () => null });
	// canonical B exists -> path-match guard blocks reattach -> split (mint) is the safe outcome
	assert.equal(res2.status, "new");
	assert.notEqual(res2.project.id, res1.project.id);
});

test("resolution: nearest boundary wins for nested repos", () => {
	const r = loadRegistry(agentDir);
	const outer = fakeRepo(area, "outer", "git");
	const inner = fakeRepo(outer, "inner", "git");

	const resOuter = resolveProject({ cwd: outer, registry: r, gitRemoteReader: () => null });
	const resInner = resolveProject({ cwd: inner, registry: r, gitRemoteReader: () => null });
	assert.notEqual(resOuter.project.id, resInner.project.id);
	assert.equal(resInner.root, inner);

	// subdir of outer belongs to outer
	mkdirSync(outer + "/docs", { recursive: true });
	const resSub = resolveProject({ cwd: outer + "/docs", registry: r, gitRemoteReader: () => null });
	assert.equal(resSub.project.id, resOuter.project.id);
});

test("resolution: nested-session merge follows to parent project", () => {
	const r = loadRegistry(agentDir);
	const outer = fakeRepo(area, "parent", "git");
	const inner = fakeRepo(outer, "kid", "git");
	resolveProject({ cwd: outer, registry: r, gitRemoteReader: () => null });
	resolveProject({ cwd: inner, registry: r, gitRemoteReader: () => null });
	mutations.setNested(r, "kid", "parent");

	const res = resolveProject({ cwd: inner, registry: r, gitRemoteReader: () => null });
	assert.ok(res.nested);
	assert.equal(res.project.slug, "parent");
	assert.equal(res.boundaryProject.slug, "kid");
	// store comes from the effective project
	assert.equal(storeDirFor(agentDir, res.project), getCentralStoreDir(agentDir, "parent"));
});

test("resolution: broken mergedInto chain falls back to boundary project", () => {
	const r = loadRegistry(agentDir);
	const solo = fakeRepo(area, "solo", "git");
	resolveProject({ cwd: solo, registry: r, gitRemoteReader: () => null });
	const p = findBySlug(r, "solo")!;
	p.mergedInto = "0J0000000000000000000000000"; // missing target
	const res = resolveProject({ cwd: solo, registry: r, gitRemoteReader: () => null });
	assert.equal(res.project.slug, "solo");
	assert.ok(res.actions.some((a) => a.startsWith("warning:")));
});

test("resolution: storeDirFor central vs in-repo", () => {
	const r = loadRegistry(agentDir);
	const root = fakeRepo(area, "st", "git");
	const res = resolveProject({ cwd: root, registry: r, gitRemoteReader: () => null });
	assert.equal(storeDirFor(agentDir, res.project), getCentralStoreDir(agentDir, "st"));
	mutations.setStoreMode(agentDir, r, "st", "in-repo");
	assert.equal(storeDirFor(agentDir, res.project), getInRepoStoreDir(root));
});

test("resolution: marker id unknown to registry adopts identity", () => {
	const r = loadRegistry(agentDir);
	const root = fakeRepo(area, "adopted", "git", "UNKNOWNID1");
	const res = resolveProject({ cwd: root, registry: r });
	assert.equal(res.status, "new");
	assert.equal(res.project.id, "UNKNOWNID1");
	assert.equal(res.project.slug, "adopted");
});

test("resolution: path-match with no reattach needed (canonical already root, marker lost)", () => {
	const r = loadRegistry(agentDir);
	const root = fakeRepo(area, "stable", "git");
	resolveProject({ cwd: root, registry: r, gitRemoteReader: () => null });
	const p = findBySlug(r, "stable")!;
	p.aliases.push("/gone");
	// delete the marker so resolution must fall back to path match
	rmSync(`${root}/.git/blueberry-id`);

	const res = resolveProject({ cwd: root, registry: r, gitRemoteReader: () => null });
	assert.equal(res.status, "path");
	assert.equal(res.project.canonicalPath, root, "already canonical: no reattach");
});
