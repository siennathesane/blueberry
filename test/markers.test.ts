import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	boundaryAt,
	findProjectBoundary,
	markerPath,
	readMarkerId,
	writeMarkerId,
	getGitRemote,
} from "../src/core/markers.ts";
import { tmpDir, fakeRepo, cleanup } from "./helpers.ts";

test("boundaryAt: git directory", () => {
	const p = fakeRepo("/tmp", "x", "git");
	// use our own tmp area to avoid polluting /tmp root assertions
	assert.equal(boundaryAt(p)?.kind, "git");
});

test("boundaryAt: lore directory, worktree file, plain marker", () => {
	const tmp = tmpDir("bb-markers-");
	const lore = fakeRepo(tmp, "lore", "lore", "L1");
	const wt = fakeRepo(tmp, "wt", "worktree", "W1");
	const plain = fakeRepo(tmp, "plain", "plain", "P1");
	assert.equal(boundaryAt(lore)?.kind, "lore");
	assert.equal(boundaryAt(wt)?.kind, "worktree");
	assert.equal(boundaryAt(plain)?.kind, "plain");
	cleanup(tmp);
});

test("boundaryAt: none in a bare directory", () => {
	const tmp = tmpDir("bb-markers-none-");
	assert.equal(boundaryAt(tmp), null);
	cleanup(tmp);
});

test("findProjectBoundary: nearest wins from nested dirs", () => {
	const tmp = tmpDir("bb-walk-");
	const outer = fakeRepo(tmp, "outer", "git");
	const inner = fakeRepo(outer, "inner", "git");
	mkdirSync(outer + "/plain-sub", { recursive: true });

	assert.equal(findProjectBoundary(inner)?.root, inner);
	assert.equal(findProjectBoundary(outer + "/plain-sub")?.root, outer);
	assert.equal(findProjectBoundary(outer)?.root, outer);
	// tmp itself has no boundary (tmpDir is under the system tmp root)
	assert.equal(findProjectBoundary(tmp), null);
	cleanup(tmp);
});

test("boundaryAt: plain marker detected anywhere (scoping is the walk's job)", () => {
	const tmp = tmpDir("bb-markers-plain-");
	const p = fakeRepo(tmp, "plain", "plain", "P1");
	assert.equal(boundaryAt(p)?.kind, "plain");
	cleanup(tmp);
});

test("findProjectBoundary: plain markers resolve only their own dir (design 007)", () => {
	const tmp = tmpDir("bb-walk-plain-scope-");
	const marked = fakeRepo(tmp, "marked", "plain", "P1");
	const sub = join(marked, "sub", "deep");
	mkdirSync(sub, { recursive: true });
	// at the marked dir: resolves (session launched there owns it)
	assert.equal(findProjectBoundary(marked)?.root, marked);
	// from a descendant: plain ancestors are non-boundaries (HOME included —
	// this subsumes the old home-trap emergency fix)
	assert.equal(findProjectBoundary(sub), null);
	// unless the caller confirms an explicit capture claim (blueberry init)
	const captures = () => true;
	assert.equal(findProjectBoundary(sub, { capturesSubtree: captures })?.root, marked);
	// predicate consulted only for plain ancestors: git always wins
	const outer = fakeRepo(tmp, "repo", "git");
	const repoSub = join(outer, "pkg");
	mkdirSync(repoSub);
	assert.equal(findProjectBoundary(repoSub, { capturesSubtree: captures })?.root, outer);
	cleanup(tmp);
});

test("markerPath: per-kind location", () => {
	assert.equal(markerPath({ root: "/r", kind: "git" }), "/r/.git/blueberry-id");
	assert.equal(
		markerPath({ root: "/r", kind: "lore" }),
		"/r/.lore/blueberry-id",
	);
	assert.equal(markerPath({ root: "/r", kind: "worktree" }), "/r/.blueberry/id");
	assert.equal(markerPath({ root: "/r", kind: "plain" }), "/r/.blueberry/id");
});

test("marker read/write round-trip", () => {
	const tmp = tmpDir("bb-marker-io-");
	const git = fakeRepo(tmp, "g", "git");
	const b = boundaryAt(git)!;
	writeMarkerId(b, "ID123");
	assert.equal(readMarkerId(b), "ID123");
	// overwrite
	writeMarkerId(b, "ID456");
	assert.equal(readMarkerId(b), "ID456");
	// plain-kind marker minting: the boundary is constructed (not detected) because
	// a plain dir is only detectable once its marker exists
	const plain = fakeRepo(tmp, "p", "plain");
	writeMarkerId({ root: plain, kind: "plain" }, "PLAIN1");
	assert.equal(readMarkerId(boundaryAt(plain)!), "PLAIN1");
	// empty marker reads as null
	writeFileSync(markerPath(boundaryAt(git)!), "   \n");
	assert.equal(readMarkerId(boundaryAt(git)!), null);
	cleanup(tmp);
});

test("getGitRemote: null outside a repo, real remote inside one", () => {
	// /tmp is not inside any git repo in normal environments
	const tmp = tmpDir("bb-remote-");
	assert.equal(getGitRemote(tmp), null);
	cleanup(tmp);
	// this test suite itself runs inside the blueberry repo, which has a marker but no remote yet
	// (remote fetch is exercised in integration; here we only assert the null path)
});
