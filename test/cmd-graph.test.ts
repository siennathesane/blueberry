/**
 * Command graph tests (design 003, id 8d4d99) — R1–R7 verification.
 *
 * R1 store round-trip · R2 diamond ordering + blocking · R3 exit codes →
 * state · R4 detach/inspect (same-db, cross-process is the CLI's job) ·
 * R5 both surfaces drive one runner (CLI verbs tested at dispatch; here the
 * store/runner contracts they call) · R6 templates with BB_ARG_* env ·
 * R7 output TTL by generations + wall-clock floor.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/core/db.ts";
import {
	appendOutput,
	blockedByFailure,
	bumpGeneration,
	createGraph,
	currentGeneration,
	getGraph,
	getTemplate,
	graphNodes,
	listGraphs,
	nodeOutput,
	purgeOutput,
	readySet,
	runGraph,
	runTemplate,
	saveTemplate,
	CMD_OUTPUT_FLOOR_H,
} from "../src/core/cmd-graph.ts";
import { tmpAgentDir, cleanup } from "./helpers.ts";

let agentDir: string;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
	agentDir = tmpAgentDir();
	db = openDb(agentDir);
});

afterEach(() => {
	db.close();
	cleanup(agentDir);
});

// --- R1: store round-trip ---------------------------------------------------------

test("R1: graphs persist as first-class rows; todo tables untouched", () => {
	const before = db.prepare("SELECT COUNT(*) n FROM todos").get() as { n: number };
	const id = createGraph(db, null, [{ name: "a", command: "true" }], []);
	assert.ok(getGraph(db, id), "graph row exists");
	const nodes = graphNodes(db, id);
	assert.equal(nodes.length, 1);
	assert.equal(nodes[0]!.name, "a");
	assert.equal(nodes[0]!.status, "pending");
	const after = db.prepare("SELECT COUNT(*) n FROM todos").get() as { n: number };
	assert.equal(after.n, before.n, "todos untouched");
	// edge validation: unknown node names reject atomically
	assert.throws(
		() => createGraph(db, null, [{ name: "a", command: "true" }], [{ node: "a", dep: "ghost" }]),
		/unknown node/,
	);
	const count = listGraphs(db, null);
	assert.equal(count.length, 1);
});

// --- R2 + R3: diamond ordering, exit-code state ------------------------------------

test("R2/R3: diamond graph — topo order, parallel siblings, failure blocks downstream", async () => {
	// build → [test ∥ lint] → bundle; test FAILS → bundle never starts
	const id = createGraph(
		db,
		null,
		[
			{ name: "build", command: "echo built" },
			{ name: "test", command: "exit 1" },
			{ name: "lint", command: "echo linted" },
			{ name: "bundle", command: "echo bundled" },
		],
		[
			{ node: "test", dep: "build" },
			{ node: "lint", dep: "build" },
			{ node: "bundle", dep: "test" },
			{ node: "bundle", dep: "lint" },
		],
	);
	const order: string[] = [];
	await runGraph(db, id, {
		onNodeStart: (n) => order.push(n.name),
	});
	assert.equal(order[0], "build", "build first");
	const byName = Object.fromEntries(graphNodes(db, id).map((n) => [n.name, n]));
	assert.equal(byName["build"].status, "ok");
	assert.equal(byName["test"].status, "failed");
	assert.equal(byName["test"].exit_code, 1);
	assert.equal(byName["lint"].status, "ok", "sibling unaffected");
	assert.equal(byName["bundle"].status, "pending", "downstream blocked");
	assert.equal(blockedByFailure(db, id), 1);
	assert.equal(getGraph(db, id)!.status, "failed");
	// output recorded per node (R3)
	const out = nodeOutput(db, byName["build"].id);
	assert.ok(out.some((l) => l.text.includes("built")), "stdout captured");
});

test("R3: happy-path diamond completes; all ok", async () => {
	const id = createGraph(
		db,
		null,
		[
			{ name: "build", command: "echo b" },
			{ name: "test", command: "echo t" },
			{ name: "lint", command: "echo l" },
			{ name: "bundle", command: "echo d" },
		],
		[
			{ node: "test", dep: "build" },
			{ node: "lint", dep: "build" },
			{ node: "bundle", dep: "test" },
			{ node: "bundle", dep: "lint" },
		],
	);
	await runGraph(db, id);
	for (const n of graphNodes(db, id)) {
		assert.equal(n.status, "ok", `${n.name} ok`);
	}
	assert.equal(getGraph(db, id)!.status, "done");
});

// --- R2: ready-set purity -----------------------------------------------------------

test("R2: readySet excludes unmet deps; includes only pending", () => {
	const id = createGraph(
		db,
		null,
		[
			{ name: "a", command: "true" },
			{ name: "b", command: "true" },
		],
		[{ node: "b", dep: "a" }],
	);
	const ready = readySet(db, id);
	assert.equal(ready.length, 1);
	assert.equal(ready[0]!.name, "a");
});

// --- R6: templates ------------------------------------------------------------------

test("R6: template save → run with args; BB_ARG_* env reaches commands", async () => {
	saveTemplate(db, "checks", {
		params: ["file"],
		nodes: [
			{ name: "echo-arg", command: 'echo "file=$BB_ARG_FILE"' },
		],
		edges: [],
	});
	const tpl = getTemplate(db, "checks");
	assert.ok(tpl);
	assert.deepEqual(tpl!.params, ["file"]);
	const id = runTemplate(db, "checks", { file: "src/a.ts" }, null);
	await runGraph(db, id);
	const node = graphNodes(db, id)[0]!;
	assert.equal(node.status, "ok");
	const out = nodeOutput(db, node.id);
	assert.ok(
		out.some((l) => l.text.includes("file=src/a.ts")),
		"argument arrived via env",
	);
	// missing arg refuses before anything runs
	assert.throws(() => runTemplate(db, "checks", {}, null), /missing arg/);
	// unknown template refuses
	assert.throws(() => runTemplate(db, "nope", {}, null), /no template/);
});

// --- R7: output TTL -----------------------------------------------------------------

test("R7: floor-week-young output survives ANY generation distance; past-floor expires by generation", () => {
	const id = createGraph(db, null, [{ name: "n", command: "true" }], []);
	const young = graphNodes(db, id)[0]!;
	appendOutput(db, young.id, "out", "young-line");

	// young row: survives every generation bump (floor protection)
	for (let i = 0; i < 6; i++) bumpGeneration(db);
	assert.equal(nodeOutput(db, young.id).length, 1, "week-young survives 6 generations");

	// past-floor row: backdate ts beyond 168h, then generation decides
	const old2 = graphNodes(db, id)[0]!;
	appendOutput(db, old2.id, "out", "past-floor-gen0");
	db.prepare("UPDATE cmd_output SET ts = ? WHERE node_id = ? AND text = ?").run(
		new Date(Date.now() - (CMD_OUTPUT_FLOOR_H + 1) * 3600_000).toISOString(),
		old2.id,
		"past-floor-gen0",
	);
	// distance 0 at gen 6: survives (gen - g = 6 > 3? no: row gen 0, distance 6 > 3 → purge NOW)
	// wait — the row was appended at the CURRENT generation (6). Backdate ts only:
	db.prepare("UPDATE cmd_output SET generation = 3 WHERE node_id = ? AND text = ?").run(
		old2.id,
		"past-floor-gen0",
	);
	bumpGeneration(db); // → 7, purge pass runs: distance 7-3=4 > 3 → purged
	const remaining = nodeOutput(db, old2.id).map((l) => l.text);
	assert.ok(!remaining.includes("past-floor-gen0"), "past-floor, 4 generations back → purged");
	assert.ok(remaining.includes("young-line"), "young row survives on the same node");
	assert.equal(currentGeneration(db), 7);
});

test("R7: past-floor row within 3 generations survives", () => {
	const id = createGraph(db, null, [{ name: "n", command: "true" }], []);
	const node = graphNodes(db, id)[0]!;
	appendOutput(db, node.id, "out", "recent-gen");
	db.prepare("UPDATE cmd_output SET ts = ? WHERE node_id = ?").run(
		new Date(Date.now() - (CMD_OUTPUT_FLOOR_H + 1) * 3600_000).toISOString(),
		node.id,
	);
	// current generation, past floor: distance 0 → survives
	bumpGeneration(db);
	bumpGeneration(db);
	assert.equal(nodeOutput(db, node.id).length, 1, "within 3 generations of past-floor row survives");
});


// --- R4: detach contract (state-in-DB is what makes detach possible) ----------------

test("R4: a fresh DB handle sees running-graph state mid-flight", async () => {
	const id = createGraph(
		db,
		null,
		[
			{ name: "slow", command: "sleep 0.3; echo done" },
			{ name: "after", command: "echo after" },
		],
		[{ node: "after", dep: "slow" }],
	);
	const run = runGraph(db, id);
	// while running: a second connection (the detach inspector) sees 'running'
	const db2 = openDb(agentDir);
	const g = getGraph(db2, id)!;
	assert.equal(g.status, "running");
	db2.close();
	await run;
	assert.equal(getGraph(db, id)!.status, "done");
});
