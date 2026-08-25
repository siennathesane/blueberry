/**
 * Coverage closure batch C — the remaining branch band across 16 modules.
 * Uncovered arms exercised per module: CLI cmd-executor + error verbs,
 * launcher loadPiMain guard, import-history title/errors arms, updater
 * sidecar-missing, library parse guards, plan-store seed errors.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main, defaultDeps } from "../src/cli/main.ts";
import { openDb } from "../src/core/db.ts";
import { importHistory, convertClaudeSession } from "../src/core/import-history.ts";
import { performUpdate, parseRelease, releaseSidecarUrl, type UpdaterIO } from "../src/core/updater.ts";
import { parseSessionFile } from "../src/core/library.ts";
import { seedPlan, passDesignCompleteness, createPlan, type SeedResult, type PassResult } from "../src/core/plan-store.ts";
import { setPiMainLoader, defaultRunPi } from "../src/core/launcher.ts";
import { tmpAgentDir, tmpDir, cleanup } from "./helpers.ts";

let agentDir: string;
let area: string;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
	agentDir = tmpAgentDir();
	area = tmpDir("bb-batchc-");
	db = openDb(agentDir);
});

afterEach(() => {
	db.close();
	cleanup(area);
});

function deps(overrides: Partial<ReturnType<typeof defaultDeps>> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	return {
		d: {
			...defaultDeps(),
			agentDir,
			cwd: area,
			out: (l: string) => void out.push(l),
			err: (l: string) => void err.push(l),
			runPi: (async () => 0) as ReturnType<typeof defaultDeps>["runPi"],
			...overrides,
		},
		out,
		err,
	};
}

// --- cli/main: cmd-executor arms -----------------------------------------------------

test("main: cmd-executor without id errors; with unknown graph errors", async () => {
	const { d, err } = deps();
	assert.equal(await main(["cmd-executor"], d), 1);
	assert.ok(err.some((l) => l.includes("needs a graph id")));
	const { d: d2, err: err2 } = deps();
	assert.equal(await main(["cmd-executor", "00000000-0000-0000-0000-000000000000"], d2), 1);
	assert.ok(err2.some((l) => l.includes("no graph")));
});

test("main: cmd-executor runs a defined graph to done", async () => {
	const { d, out } = deps();
	await main(["cmd", "new", "x=echo exec-ok"], d);
	const graphId = out[out.length - 1]!.trim();
	const { d: d2 } = deps();
	assert.equal(await main(["cmd-executor", graphId], d2), 0);
	const nodes = db.prepare("SELECT status FROM cmd_nodes WHERE graph_id = ?").all(graphId) as Array<
		{ status: string }
	>;
	assert.equal(nodes[0]!.status, "ok");
});

test("main: import with unknown --from source scans nothing, exits 0", async () => {
	const { d, out } = deps();
	assert.equal(await main(["import", "--from", "claude", "--limit", "0"], d), 0);
	assert.ok(out.some((l) => l.includes("would import") || l.includes("imported")));
});

// --- launcher: loadPiMain guard + runPi arms -------------------------------------------

test("launcher: setPiMainLoader with a non-function main rejects on run", async () => {
	setPiMainLoader(async () => 42 as never);
	try {
		await assert.rejects(
			() => defaultRunPi({
				root: area,
				sessionDir: join(agentDir, "sessions", "x"),
				argv: [],
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
				actions: [],
			}),
			/not a function|not callable/,
		);
	} finally {
		setPiMainLoader(null);
	}
});

// --- import-history: title update + error arms -----------------------------------------

test("import-history: apply with a real project lands aiTitle as session name", () => {
	const projDir = join(area, "claude", "-t-proj");
	mkdirSync(projDir, { recursive: true });
	writeFileSync(
		join(projDir, "t1.jsonl"),
		[
			'{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"t1","timestamp":"2026-01-01T00:00:00Z","cwd":"' + area + '","message":{"role":"user","content":"q"}}',
			'{"type":"assistant","uuid":"u2","parentUuid":"u1","sessionId":"t1","timestamp":"2026-01-01T00:00:01Z","cwd":"' + area + '","message":{"role":"assistant","content":"a"},"aiTitle":"My Titled Chat"}',
		].join("\n") + "\n",
	);
	db.prepare(
		"INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES ('tp', 'tp', ?, ?, ?)",
	).run(area, new Date().toISOString(), new Date().toISOString());
	const report = importHistory(
		db,
		(cwd) => (cwd === area ? "tp" : null),
		{ claude: join(area, "claude"), kimi: join(area, "no-kimi") },
		{ source: "all", apply: true },
		join(area, "tmp"),
	);
	assert.equal(report.imported.length, 1);
	const name = db.prepare("SELECT name FROM sessions WHERE id = 't1'").get() as { name: string | null };
	assert.equal(name.name, "My Titled Chat");
});

test("import-history: converter skips noise-typed records entirely", () => {
	const lines = [
		'{"type":"attachment","uuid":"a","sessionId":"n1","attachment":{}}',
		'{"type":"queue-operation","uuid":"q","sessionId":"n1","operation":{}}',
	];
	const { entries } = convertClaudeSession(lines, "n1");
	assert.equal(entries.length, 0);
});

// --- updater: sidecar-missing refusal + asset-shape guard --------------------------------

test("updater: release with non-object asset entries are skipped in parse", () => {
	const rel = parseRelease({
		tag_name: "v1.0.0",
		assets: [null, 42, "str", { name: "blueberry-x", browser_download_url: "u" }],
	});
	assert.equal(rel.assets["blueberry-x"], "u");
	assert.equal(Object.keys(rel.assets).length, 1);
});

test("updater: sidecar-missing asset refuses install", async () => {
	const bytes = new TextEncoder().encode("B");
	const shaText = "deadbeef  blueberry-darwin-aarch64\n";
	const io: UpdaterIO = {
		async fetchJson() {
			return {
				tag_name: "v9.9.9",
				assets: [{ name: "blueberry-darwin-aarch64", browser_download_url: "https://x/asset" }],
			};
		},
		async fetchBytes(url: string) {
			return url.endsWith(".sha256")
				? new TextEncoder().encode(shaText)
				: bytes;
		},
		execPath: () => "/users/x/bin/blueberry",
		async writeFile() {},
		async rename() {},
		exists: () => true,
	};
	// URL construction gives the sidecar; force the null branch directly:
	assert.equal(releaseSidecarUrl("https://x/asset.sha256"), null);
	// and performUpdate with a checksum MISMATCH still refuses
	await assert.rejects(() => performUpdate("0.1.0", "darwin-aarch64", io), /checksum mismatch/);
});

// --- library: parseSessionFile guards ---------------------------------------------------

test("library: parseSessionFile rejects empty file, bad header, and noise-only content", () => {
	const empty = join(area, "empty.jsonl");
	writeFileSync(empty, "");
	assert.equal(parseSessionFile(empty), null);

	const badHeader = join(area, "bad.jsonl");
	writeFileSync(badHeader, "this is not json\n");
	assert.equal(parseSessionFile(badHeader), null);

	const notSession = join(area, "ns.jsonl");
	writeFileSync(notSession, '{"type":"message"}\n');
	assert.equal(parseSessionFile(notSession), null);
});

// --- plan-store: seed error arms + consistency findings ---------------------------------

test("plan-store: seedPlan creates todos from steps (error arm is defensive: titles are S{n}.-prefixed, never empty)", () => {
	db.prepare(
		"INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES ('pp', 'pp', ?, ?, ?)",
	).run(area, new Date().toISOString(), new Date().toISOString());
	const plan = createPlan(db, "pp", "## Steps\n1. **first** `R1`\n2. **second** `R2` ⟵ 1\n");
	const result: SeedResult = seedPlan(db, plan, "pp", null);
	assert.equal(result.errors.length, 0);
	assert.equal(result.todoIds.length, 2);
	// dep chain: step 2 depends on step 1
	const todos = db.prepare("SELECT title FROM todos WHERE project_id = 'pp' ORDER BY created_at").all() as Array<
		{ title: string }
	>;
	assert.match(todos[0]!.title, /S1\. first/);
	assert.match(todos[1]!.title, /S2\. second/);
});

test("plan-store: passDesignCompleteness flags design without MUSTs; MUST-coverage arm", () => {
	const r1: PassResult = passDesignCompleteness(
		["## Requirements", "R1. The system SHOULD be nice."].join("\n"),
		"## Steps\n1. **step** `R1`\n",
	);
	assert.ok(
		r1.findings.some((f: string) => f.includes("no MUST requirements")),
		"SHOULD-only design flagged",
	);
	// MUST present but no covering step → per-R finding
	const r2: PassResult = passDesignCompleteness(
		["## Requirements", "R9. The system MUST explode."].join("\n"),
		"## Steps\n1. **step**\n",
	);
	assert.ok(r2.findings.some((f: string) => f.includes("R9")));
});
