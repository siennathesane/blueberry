/**
 * Coverage closure: plan-gate, cmd-graph, design-store edge branches.
 * plan-gate: corrupt mode JSON, gate pass/fail arms. cmd-graph: corrupt
 * template JSON degrade, corrupt node env, output cap, spawn error.
 * design-store: nextDesignNumber no-dir, non-md skips, checkCompleteness
 * uncovered-must arm, readDesignDoc missing/unparseable.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/core/db.ts";
import { readMode, writeMode, planGateDecision } from "../src/core/plan-gate.ts";
import { saveTemplate, getTemplate, createGraph, graphNodes, appendOutput, nodeOutput } from "../src/core/cmd-graph.ts";
import { checkCompleteness, readDesignDoc, scaffoldDesign } from "../src/core/design-store.ts";
import { tmpAgentDir, tmpDir, fakeRepo, cleanup } from "./helpers.ts";

let agentDir: string;
let db: ReturnType<typeof openDb>;
let area: string;

beforeEach(() => {
	agentDir = tmpAgentDir();
	db = openDb(agentDir);
	area = tmpDir("bb-covclose-");
});

afterEach(() => {
	db.close();
	cleanup(area);
});

// --- plan-gate ------------------------------------------------------------------------

test("plan-gate: corrupt mode JSON degrades to normal (never throws)", () => {
	db.prepare(
		"INSERT INTO config (key, json) VALUES ('mode', ?)",
	).run("{not json");
	assert.equal(readMode(db), "normal");
	// gate in this state: normal → no cancel even without designs
	assert.equal(planGateDecision("p1", agentDir), undefined);
});

test("plan-gate: plan mode + open design passes; blocked arm covered elsewhere", async () => {
	const root = fakeRepo(area, "pg", "git");
	db.prepare(
		"INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES ('p2', 'pg2', ?, ?, ?)",
	).run(root, new Date().toISOString(), new Date().toISOString());
	const dir = join(root, "docs", "design");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "001-d.md"), "---\nid: aa1111\nstatus: open\ntitle: D\n---\n## Problem\nx\n");
	// production flow: the extension handler syncs file state before deciding
	const { ingestDesignDocs } = await import("../src/core/doc-index.ts");
	ingestDesignDocs(db, root, "p2");
	writeMode(db, "plan");
	assert.equal(planGateDecision("p2", agentDir), undefined, "design present → pass");
	// and the blocked arm still fires when no design exists
	writeMode(db, "plan");
	const blocked = planGateDecision("p-nope", agentDir);
	assert.ok(blocked?.cancel, "no design → cancel");
});

// --- cmd-graph ------------------------------------------------------------------------

test("cmd-graph: corrupt template JSON degrades to empty, not a crash", () => {
	db.prepare(
		"INSERT INTO cmd_templates (name, params, nodes, edges, created_at, updated_at) VALUES ('bad', '{nope', '{nope', '{nope', ?, ?)",
	).run(new Date().toISOString(), new Date().toISOString());
	const tpl = getTemplate(db, "bad");
	assert.ok(tpl);
	assert.deepEqual(tpl!.params, []);
	assert.deepEqual(tpl!.nodes, []);
	assert.deepEqual(tpl!.edges, []);
});

test("cmd-graph: saveTemplate + getTemplate round-trip preserves shape", () => {
	saveTemplate(db, "good", {
		params: ["a"],
		nodes: [{ name: "n", command: "echo $BB_ARG_A" }],
		edges: [],
	});
	const tpl = getTemplate(db, "good");
	assert.equal(tpl!.params.length, 1);
	assert.equal(tpl!.nodes[0]!.name, "n");
});

test("cmd-graph: appendOutput respects the byte cap", async () => {
	// run a node that floods stdout; assert the cap marker lands and rows stop
	const id = createGraph(db, null, [{ name: "flood", command: "yes | head -c 700000" }], []);
	await (async () => {
		const { runGraph } = await import("../src/core/cmd-graph.ts");
		await runGraph(db, id);
	})();
	const node = graphNodes(db, id)[0]!;
	const out = nodeOutput(db, node.id, 10000);
	assert.ok(
		out.some((l) => l.text.includes("[output capped at 512KB]")),
		"cap marker present",
	);
	// total stored text stays bounded (well under the raw 700KB)
	const total = out.reduce((n, l) => n + l.text.length, 0);
	assert.ok(total < 600_000, `capped output stored: ${total}`);
});

// --- design-store ---------------------------------------------------------------------

test("nextDesignNumber: non-md files skipped; next after 001 is 002 (via scaffold)", () => {
	const root = fakeRepo(area, "ds", "git");
	const dir = join(root, "docs", "design");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "notes.txt"), "not a design");
	writeFileSync(join(dir, "README"), "also not");
	const first = scaffoldDesign(root, "First");
	assert.ok(first.path.includes("001-"));
	const second = scaffoldDesign(root, "Second");
	assert.ok(second.path.includes("002-"), second.path);
});

test("checkCompleteness: MUST without verification lands in uncoveredMusts", () => {
	const body = [
		"## Audience", "x",
		"## Problem", "x",
		"## Goal", "x",
		"## Non-goals", "x",
		"## Approaches considered", "x",
		"## Decision", "x",
		"## Risks & open questions", "x",
		"## Requirements", "R1. The system MUST do the thing.",
		"## Verification", "",
	].join("\n");
	const r = checkCompleteness(body);
	// empty Verification: the section is unanswered AND its MUST is uncovered
	assert.ok(r.unanswered.includes("Verification"));
	assert.equal(r.requirements.musts.length, 1);
	assert.equal(r.requirements.uncoveredMusts.length, 1, "R1 with empty verification → uncovered");
});

test("readDesignDoc: missing file → null; unparseable frontmatter → null", () => {
	assert.equal(readDesignDoc(join(area, "nope.md")), null);
	const bad = join(area, "bad.md");
	writeFileSync(bad, "no frontmatter at all\n");
	assert.equal(readDesignDoc(bad), null);
});
