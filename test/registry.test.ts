import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import {
	loadRegistry,
	saveRegistry,
	mutations,
	findBySlug,
	findByPath,
	findByGitRemote,
	uniqueSlug,
} from "../src/core/registry.ts";
import { getCentralStoreDir } from "../src/core/agent-dir.ts";
import { readJsonIfExists } from "../src/core/util.ts";
import { tmpAgentDir, fakeRepo, cleanup, fakeSession } from "./helpers.ts";

let agentDir: string;

beforeEach(() => {
	agentDir = tmpAgentDir();
});
afterEach(() => {
	cleanup(agentDir);
});

test("loadRegistry: missing file -> empty registry", () => {
	const r = loadRegistry(agentDir);
	assert.deepEqual(r, { version: 1, projects: [] });
});

test("loadRegistry: malformed file -> empty registry", () => {
	writeFileSync(`${agentDir}/registry.json`, "{not json");
	assert.deepEqual(loadRegistry(agentDir).projects, []);
});

test("registry round-trip: save then load", async () => {
	const r = loadRegistry(agentDir);
	mutations.register(r, { root: "/x/proj" });
	await saveRegistry(agentDir, r);
	const loaded = loadRegistry(agentDir);
	assert.equal(loaded.projects.length, 1);
	assert.equal(loaded.projects[0]?.slug, "proj");
	assert.equal(loaded.projects[0]?.canonicalPath, "/x/proj");
});

test("uniqueSlug: suffixes on collision", () => {
	const r = loadRegistry(agentDir);
	mutations.register(r, { root: "/a/proj" });
	mutations.register(r, { root: "/b/proj" });
	mutations.register(r, { root: "/c/proj" });
	assert.equal(r.projects[0]?.slug, "proj");
	assert.equal(r.projects[1]?.slug, "proj-2");
	assert.equal(r.projects[2]?.slug, "proj-3");
	assert.equal(uniqueSlug(r, "proj"), "proj-4");
});

test("findByPath: canonical and aliases", () => {
	const r = loadRegistry(agentDir);
	const p = mutations.register(r, { root: "/old/location" });
	mutations.reattach(r, p, "/new/location");
	assert.ok(findByPath(r, "/new/location"));
	assert.ok(findByPath(r, "/old/location"));
	assert.equal(findByPath(r, "/nowhere"), undefined);
});

test("reattach: no duplicate aliases on repeated moves", () => {
	const r = loadRegistry(agentDir);
	const p = mutations.register(r, { root: "/a" });
	mutations.reattach(r, p, "/b");
	mutations.reattach(r, p, "/c");
	mutations.reattach(r, p, "/c"); // same-path reattach is a no-op
	assert.deepEqual(p.aliases, ["/a", "/b"]);
	assert.equal(p.canonicalPath, "/c");
});

test("findByGitRemote: matches registered remote", () => {
	const r = loadRegistry(agentDir);
	mutations.register(r, {
		root: "/a/repo",
		gitRemote: "https://github.com/u/r",
	});
	assert.ok(findByGitRemote(r, "https://github.com/u/r"));
	assert.equal(findByGitRemote(r, "https://github.com/u/other"), undefined);
});

test("renameSlug: moves central store directory", () => {
	const r = loadRegistry(agentDir);
	mutations.register(r, { root: "/x/apples" });
	const store = getCentralStoreDir(agentDir, "apples");
	fakeSession(store, { cwd: "/x/apples", firstUserText: "hi" });

	const renamed = mutations.renameSlug(agentDir, r, "apples", "oranges");
	assert.equal(renamed.slug, "oranges");
	assert.ok(!existsSync(store), "old store gone");
	assert.ok(existsSync(getCentralStoreDir(agentDir, "oranges")));
	assert.equal(readdirSync(getCentralStoreDir(agentDir, "oranges")).length, 1);
});

test("renameSlug: rejects slug-form violations and clashes", () => {
	const r = loadRegistry(agentDir);
	mutations.register(r, { root: "/x/apples" });
	mutations.register(r, { root: "/y/oranges" });
	assert.throws(
		() => mutations.renameSlug(agentDir, r, "apples", "Not A Slug"),
		/slug-form/,
	);
	assert.throws(
		() => mutations.renameSlug(agentDir, r, "apples", "oranges"),
		/already in use/,
	);
	assert.throws(
		() => mutations.renameSlug(agentDir, r, "ghost", "x"),
		/no project/,
	);
});

test("merge: moves sessions, repoints nested children, absorbs identity", () => {
	const r = loadRegistry(agentDir);
	mutations.register(r, { root: "/x/a" });
	const b = mutations.register(r, { root: "/y/b" });
	const child = mutations.register(r, { root: "/z/child" });
	mutations.setNested(r, "child", "a");
	fakeSession(getCentralStoreDir(agentDir, "a"), {
		cwd: "/x/a",
		firstUserText: "a1",
	});

	const { survivor, moved } = mutations.merge(agentDir, r, "a", "b");
	assert.equal(survivor.id, b.id);
	assert.equal(moved, 1);
	assert.equal(readdirSync(getCentralStoreDir(agentDir, "b")).length, 1);
	assert.ok(!existsSync(getCentralStoreDir(agentDir, "a")));
	assert.equal(findBySlug(r, "a"), undefined);
	// child previously nested into a now points at b
	assert.equal(child.mergedInto, b.id);
	// aliases absorbed
	assert.ok(b.aliases.includes("/x/a"));
});

test("merge: rejects self-merge and nested source", () => {
	const r = loadRegistry(agentDir);
	mutations.register(r, { root: "/x/a" });
	mutations.register(r, { root: "/y/b" });
	mutations.setNested(r, "b", "a");
	assert.throws(() => mutations.merge(agentDir, r, "a", "a"), /into itself/);
	assert.throws(() => mutations.merge(agentDir, r, "b", "a"), /unnest first/);
});

test("forget: keeps store by default, purges with flag", () => {
	const r = loadRegistry(agentDir);
	mutations.register(r, { root: "/x/gone" });
	const store = getCentralStoreDir(agentDir, "gone");
	fakeSession(store, { cwd: "/x/gone" });

	const kept = mutations.forget(agentDir, r, "gone", { purge: false });
	assert.equal(kept.storeDir, store);
	assert.ok(existsSync(store), "store preserved");

	const r2 = loadRegistry(agentDir);
	mutations.register(r2, { root: "/x/gone" });
	const purged = mutations.forget(agentDir, r2, "gone", { purge: true });
	assert.equal(purged.storeDir, null);
	assert.ok(!existsSync(store), "store purged");
	assert.equal(r2.projects.length, 0);
});

test("forget: rejects when other projects nest into it", () => {
	const r = loadRegistry(agentDir);
	mutations.register(r, { root: "/x/parent" });
	mutations.register(r, { root: "/y/kid" });
	mutations.setNested(r, "kid", "parent");
	assert.throws(
		() => mutations.forget(agentDir, r, "parent", { purge: false }),
		/unnest/,
	);
});

test("setNested: set, clear, self, cycles", () => {
	const r = loadRegistry(agentDir);
	mutations.register(r, { root: "/x/a" });
	mutations.register(r, { root: "/y/b" });
	mutations.register(r, { root: "/z/c" });

	mutations.setNested(r, "b", "a");
	assert.equal(findBySlug(r, "b")?.mergedInto !== undefined, true);

	mutations.setNested(r, "c", "b"); // c -> b -> a chain
	assert.throws(() => mutations.setNested(r, "a", "c"), /cycle/);
	assert.throws(() => mutations.setNested(r, "a", "a"), /into itself/);

	mutations.setNested(r, "b", null);
	assert.equal(findBySlug(r, "b")?.mergedInto, null);
});

test("setStoreMode: migrates files between central and in-repo", () => {
	const root = `${agentDir}/proj-root`;
	mkdirSync(root, { recursive: true });
	const r = loadRegistry(agentDir);
	mutations.register(r, { root });

	const central = getCentralStoreDir(agentDir, "proj-root");
	fakeSession(central, { cwd: root });

	const p = mutations.setStoreMode(agentDir, r, "proj-root", "in-repo");
	assert.equal(p.sessionStore, "in-repo");
	assert.ok(!existsSync(central), "central store emptied");
	const inRepo = `${root}/.blueberry/sessions`;
	assert.ok(existsSync(inRepo));
	assert.equal(readdirSync(inRepo).length, 1);

	mutations.setStoreMode(agentDir, r, "proj-root", "central");
	assert.ok(existsSync(central));
	assert.equal(readdirSync(central).length, 1);
	assert.ok(!existsSync(inRepo));
});

test("saveRegistry: atomic write leaves valid JSON", async () => {
	const r = loadRegistry(agentDir);
	mutations.register(r, { root: "/x/ok" });
	await saveRegistry(agentDir, r);
	const parsed = readJsonIfExists<{ version: number }>(
		`${agentDir}/registry.json`,
	);
	assert.equal(parsed?.version, 1);
});

// --- mutations with absent stores / alternate modes ----------------------------

test("renameSlug: no store on disk still renames", () => {
	const r = loadRegistry(agentDir);
	mutations.register(r, { root: "/x/nostore" }); // no store dir created
	const p = mutations.renameSlug(agentDir, r, "nostore", "renamed-nostore");
	assert.equal(p.slug, "renamed-nostore");
});

test("merge: in-repo source skips the store move", () => {
	const r = loadRegistry(agentDir);
	const a = mutations.register(r, { root: "/x/inrepo-a" });
	const b = mutations.register(r, { root: "/y/inrepo-b" });
	a.sessionStore = "in-repo";
	const { survivor } = mutations.merge(agentDir, r, "inrepo-a", "inrepo-b");
	assert.equal(survivor.id, b.id);
});

test("forget: in-repo store leaves nothing to report", () => {
	const r = loadRegistry(agentDir);
	const p = mutations.register(r, { root: "/x/inrepo-f" });
	p.sessionStore = "in-repo";
	const { storeDir } = mutations.forget(agentDir, r, "inrepo-f", {
		purge: true,
	});
	assert.equal(storeDir, null);
});

test("setStoreMode: no source files just flips the mode", () => {
	const r = loadRegistry(agentDir);
	const root = fakeRepo(agentDir, "flip", "git");
	mutations.register(r, { root });
	const p = mutations.setStoreMode(agentDir, r, "flip", "in-repo"); // no central store exists
	assert.equal(p.sessionStore, "in-repo");
});
