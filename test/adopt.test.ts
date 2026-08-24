import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { adoptSessions } from "../src/core/adopt.ts";
import { loadRegistry, findBySlug } from "../src/core/registry.ts";
import { getCentralStoreDir } from "../src/core/agent-dir.ts";
import { readSessionHeader } from "../src/core/sessions.ts";
import { encodeCwdToDirName } from "../src/core/util.ts";
import {
	tmpAgentDir,
	tmpDir,
	fakeRepo,
	fakeSession,
	cleanup,
} from "./helpers.ts";

let agentDir: string;
let area: string;
let source: string;

beforeEach(() => {
	agentDir = tmpAgentDir();
	area = tmpDir("bb-adopt-");
	source = `${area}/pi-sessions`;
	mkdirSync(source, { recursive: true });
});
afterEach(() => {
	cleanup(agentDir, area);
});

function piStore(cwd: string): string {
	const dir = `${source}/${encodeCwdToDirName(cwd)}`;
	mkdirSync(dir, { recursive: true });
	return dir;
}

test("adopt: groups by header cwd into project stores", () => {
	const rootA = fakeRepo(area, "alpha", "git");
	const rootB = fakeRepo(area, "beta", "git");
	fakeSession(piStore(rootA), { cwd: rootA, firstUserText: "a1" });
	fakeSession(piStore(rootA), { cwd: rootA, firstUserText: "a2" });
	fakeSession(piStore(rootB), { cwd: rootB, firstUserText: "b1" });

	const r = loadRegistry(agentDir);
	const report = adoptSessions(r, { sourceDir: source, agentDir });

	assert.equal(report.imported.length, 2);
	assert.equal(report.skipped.length, 0);
	const storeA = getCentralStoreDir(agentDir, "alpha");
	assert.equal(readdirSync(storeA).length, 2);
	const storeB = getCentralStoreDir(agentDir, "beta");
	assert.equal(readdirSync(storeB).length, 1);
	// headers rewritten to canonical paths
	for (const f of readdirSync(storeA)) {
		assert.equal(readSessionHeader(`${storeA}/${f}`)?.cwd, rootA);
	}
	// registry has both projects
	assert.ok(findBySlug(r, "alpha"));
	assert.ok(findBySlug(r, "beta"));
});

test("adopt: empty-cwd sessions get dir-decoded cwd stamped", () => {
	const root = fakeRepo(area, "gamma", "git");
	const store = piStore(root);
	fakeSession(store, { cwd: "" }); // empty header cwd — decoder path engages
	// (blank cwd means header decoding falls back to the mangled dir name)
	const r = loadRegistry(agentDir);
	const report = adoptSessions(r, {
		sourceDir: source,
		agentDir,
		pathExists: (p) => existsSync(p),
	});

	assert.equal(report.stamped, 1);
	assert.equal(report.imported[0]?.sessions, 1);
	const store2 = getCentralStoreDir(agentDir, "gamma");
	const moved = readdirSync(store2).map((n) => `${store2}/${n}`)[0]!;
	assert.equal(readSessionHeader(moved)?.cwd, root);
});

test("adopt: unresolvable empty-cwd is skipped with guidance", () => {
	const dir = `${source}/--nowhere--known--path--`;
	mkdirSync(dir, { recursive: true });
	fakeSession(dir, { cwd: "" });

	const r = loadRegistry(agentDir);
	const report = adoptSessions(r, {
		sourceDir: source,
		agentDir,
		pathExists: () => false,
	});

	assert.equal(report.imported.length, 0);
	assert.equal(report.skipped.length, 1);
	assert.match(report.skipped[0]!.reason, /--map/);
});

test("adopt: --map overrides dir decoding", () => {
	const root = fakeRepo(area, "mapped", "git");
	const dirName = "--completely--opaque--name--";
	const dir = `${source}/${dirName}`;
	mkdirSync(dir, { recursive: true });
	fakeSession(dir, { cwd: "" });

	const r = loadRegistry(agentDir);
	const report = adoptSessions(r, {
		sourceDir: source,
		agentDir,
		pathExists: () => false,
		map: { [dirName]: root },
	});

	assert.equal(report.skipped.length, 0);
	assert.equal(report.imported[0]?.project, "mapped");
	const store = getCentralStoreDir(agentDir, "mapped");
	const moved = readdirSync(store).map((n) => `${store}/${n}`)[0]!;
	assert.equal(readSessionHeader(moved)?.cwd, root);
});

test("adopt: parentSession chains rewrite within the batch (order-independent)", () => {
	const root = fakeRepo(area, "chain", "git");
	const store = piStore(root);
	// identical timestamps: filenames tie-break on random uuids, so directory
	// order is arbitrary — a naive single-pass move would race parent vs child
	const ts = "2026-01-01T00:00:00.000Z";
	const parent = fakeSession(store, { cwd: root, timestamp: ts });
	const parentId = readSessionHeader(parent)!.id;
	fakeSession(store, { cwd: root, timestamp: ts, parentSession: parent });

	const r = loadRegistry(agentDir);
	adoptSessions(r, { sourceDir: source, agentDir });

	const dest = getCentralStoreDir(agentDir, "chain");
	const files = readdirSync(dest).map((n) => `${dest}/${n}`);
	const newParent = files.find((f) => readSessionHeader(f)!.id === parentId)!;
	const child = files
		.map((f) => readSessionHeader(f)!)
		.find((h) => h.parentSession);
	assert.ok(child, "child session retains its parentSession");
	assert.equal(
		child!.parentSession,
		newParent,
		"link rewritten to the parent's new path",
	);
});

test("adopt: existing registry project absorbs its sessions without duplication", () => {
	const root = fakeRepo(area, "known", "git");
	// pre-register via path
	const r = loadRegistry(agentDir);
	const report1 = adoptSessions(r, {
		sourceDir: `${area}/empty-nowhere`,
		agentDir,
	});
	assert.equal(report1.imported.length, 0);

	fakeSession(piStore(root), { cwd: root });
	const report2 = adoptSessions(r, { sourceDir: source, agentDir });
	assert.equal(report2.imported.length, 1);
	assert.equal(r.projects.length, 1, "no duplicate project minted");
});

test("adopt: garbage files are skipped, valid ones proceed", () => {
	const root = fakeRepo(area, "mixed", "git");
	fakeSession(piStore(root), { cwd: root });
	writeFileSync(`${source}/loose.jsonl`, "garbage\n");

	const r = loadRegistry(agentDir);
	const report = adoptSessions(r, { sourceDir: source, agentDir });

	assert.equal(report.skipped.length, 1);
	assert.equal(report.skipped[0]?.reason, "unreadable or invalid header");
	assert.equal(report.imported.length, 1);
});

test("adopt: --copy leaves source intact and re-runs are idempotent", () => {
	const root = fakeRepo(area, "copied", "git");
	const srcStore = piStore(root);
	fakeSession(srcStore, { cwd: root, firstUserText: "original" });

	const r = loadRegistry(agentDir);
	const report1 = adoptSessions(r, { sourceDir: source, agentDir, copy: true });

	assert.equal(report1.imported[0]?.sessions, 1);
	assert.equal(readdirSync(srcStore).length, 1, "source file untouched");
	const dest = getCentralStoreDir(agentDir, "copied");
	assert.equal(readdirSync(dest).length, 1, "copy landed in store");
	assert.equal(
		readSessionHeader(readdirSync(dest).map((n) => `${dest}/${n}`)[0]!)?.cwd,
		root,
		"copy header rewritten to canonical cwd",
	);

	// re-run: duplicate detected, no -suffix spawn
	const report2 = adoptSessions(r, { sourceDir: source, agentDir, copy: true });
	assert.equal(report2.duplicates, 1);
	assert.equal(report2.imported.length, 0);
	assert.equal(readdirSync(dest).length, 1, "no duplicate copies created");
});

test("adopt: copy mode maps parentSession to an already-adopted parent", () => {
	const root = fakeRepo(area, "coparent", "git");
	const srcStore = piStore(root);
	const parent = fakeSession(srcStore, { cwd: root });
	fakeSession(srcStore, { cwd: root, parentSession: parent });

	const r = loadRegistry(agentDir);
	// first run imports both
	adoptSessions(r, { sourceDir: source, agentDir, copy: true });
	// second run re-copies ONLY the parent (simulate: remove child from dest)
	const dest = getCentralStoreDir(agentDir, "coparent");
	const destFiles = readdirSync(dest).map((n) => `${dest}/${n}`);
	const childFile = destFiles.find((f) => readSessionHeader(f)?.parentSession);
	rmSync(childFile!);

	const report3 = adoptSessions(r, { sourceDir: source, agentDir, copy: true });
	assert.equal(report3.duplicates, 1, "parent detected as duplicate");
	assert.equal(report3.imported[0]?.sessions, 1, "child re-imported");
	const destFiles2 = readdirSync(dest).map((n) => `${dest}/${n}`);
	const parentId = readSessionHeader(parent)!.id;
	const parentDest = destFiles2.find(
		(f) => readSessionHeader(f)?.id === parentId,
	)!;
	const childDest = destFiles2.find((f) => readSessionHeader(f)?.parentSession);
	assert.equal(
		readSessionHeader(childDest!)?.parentSession,
		parentDest,
		"child parentSession points at the existing adopted parent",
	);
});

test("adopt: missing source dir is a no-op", () => {
	const r = loadRegistry(agentDir);
	const report = adoptSessions(r, { sourceDir: `${area}/nope`, agentDir });
	assert.equal(report.imported.length, 0);
	assert.equal(report.skipped.length, 0);
	assert.equal(report.stamped, 0);
});
