/**
 * Coverage-closing tests for the 95% gate: CLI search/sync/restore commands,
 * search/sync error paths, db branches, launcher spawn failure, todo-pane
 * edge branches.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { main, type CliDeps } from "../src/cli/main.ts";
import {
	openDb,
	loadRegistrySync,
	saveRegistrySync,
	syncConfigFile,
} from "../src/core/db.ts";
import { ingestSessionFile } from "../src/core/sync.ts";
import { entrySummary, indexFileLines } from "../src/core/search.ts";
import { applyInput, layoutFor, renderPane } from "../src/core/todo-pane.ts";
import { toCards } from "../src/core/todo-store.ts";
import { getCentralStoreDir } from "../src/core/agent-dir.ts";
import { loadRegistry, mutations } from "../src/core/registry.ts";
import {
	tmpAgentDir,
	tmpDir,
	fakeRepo,
	fakeSession,
	cleanup,
} from "./helpers.ts";

let agentDir: string;
let area: string;
let outLines: string[];
let errLines: string[];

function deps(cwd: string): CliDeps {
	return {
		cwd,
		agentDir,
		spawn: async () => 0,
		out: (l) => outLines.push(l),
		err: (l) => errLines.push(l),
		gitRemoteReader: () => null,
	};
}

beforeEach(() => {
	agentDir = tmpAgentDir();
	area = tmpDir("bb-cov95-");
	outLines = [];
	errLines = [];
});
afterEach(() => {
	cleanup(agentDir, area);
});

function tsColumn(l: string): boolean {
	return /\d{2}-\d{2} \d{2}:\d{2}/.test(l);
}

// --- CLI: sync / restore / search ------------------------------------------------

test("cli: sync and restore round-trip via dispatch", async () => {
	const root = fakeRepo(area, "roundtrip", "git");
	await main([], deps(root)); // register
	const store = getCentralStoreDir(agentDir, "roundtrip");
	fakeSession(store, { cwd: root, firstUserText: "survivor content" });

	assert.equal(await main(["sync"], deps(area)), 0);
	assert.ok(outLines.some((l) => l.includes("1 ingested")));

	const file = readdirSync(store)[0]!;
	rmSync(join(store, file));
	assert.equal(await main(["restore"], deps(area)), 0);
	assert.ok(outLines.some((l) => l.includes("restored")));
	assert.equal(readdirSync(store).length, 1, "file rebuilt");

	assert.equal(await main(["restore"], deps(area)), 0);
	assert.ok(outLines.some((l) => l.includes("nothing missing")));
});

test("cli: search sessions and code via dispatch", async () => {
	const root = fakeRepo(area, "findable", "git");
	await main([], deps(root));
	const store = getCentralStoreDir(agentDir, "findable");
	fakeSession(store, {
		cwd: root,
		firstUserText: "the xylophone query appears",
	});
	await main(["sync"], deps(area));

	assert.equal(await main(["search", "xylophone"], deps(area)), 0);
	assert.ok(
		outLines.some((l) => l.includes("▶")),
		"hit marked",
	);
	assert.ok(outLines.some(tsColumn), "timestamp column present");

	assert.equal(await main(["search", "zzz-nothing"], deps(area)), 0);
	assert.ok(outLines.some((l) => l === "no matches"));

	const db = openDb(agentDir);
	const src = join(area, "widget.ts");
	writeFileSync(src, "export const xylophoneWidget = 1;\n");
	indexFileLines(db, src, readFileSync(src, "utf8"));
	db.close();
	outLines = [];
	assert.equal(
		await main(["search", "xylophoneWidget", "--code"], deps(area)),
		0,
	);
	assert.ok(outLines.some((l) => l.includes("widget.ts:1")));

	assert.equal(await main(["search"], deps(area)), 2);
	assert.ok(errLines.some((l) => l.startsWith("usage:")));
});

// --- sync error paths ---------------------------------------------------------------

test("sync: statSync failure reports error (vanished file)", () => {
	const db = openDb(agentDir);
	const res = ingestSessionFile(db, join(area, "vanished.jsonl"), () => "p");
	assert.equal(res.status, "error");
	assert.ok(res.detail !== undefined);
	db.close();
});

test("sync: header-only session ingests zero entries, no name row", () => {
	const root = fakeRepo(area, "bare", "git");
	const r = loadRegistry(agentDir);
	mutations.register(r, { root });
	saveRegistrySync(agentDir, r);
	const projectId = loadRegistrySync(agentDir).projects[0]!.id;

	const db = openDb(agentDir);
	const store = getCentralStoreDir(agentDir, "bare");
	mkdirSync(store, { recursive: true });
	writeFileSync(
		join(store, "bare.jsonl"),
		`${JSON.stringify({ type: "session", version: 3, id: "bare-id-1", timestamp: new Date().toISOString(), cwd: root })}\n`,
	);
	const res = ingestSessionFile(db, join(store, "bare.jsonl"), (cwd) =>
		cwd === root ? projectId : null,
	);
	assert.equal(res.status, "ingested");
	const n = (
		db.prepare("SELECT COUNT(*) AS n FROM session_entries").get() as { n: number }
	).n;
	assert.equal(n, 0);
	db.close();
});

// --- search entrySummary edges -----------------------------------------------------

test("entrySummary: malformed json, non-message types, long-text truncation", () => {
	assert.deepEqual(entrySummary("{not json"), {
		ts: null,
		role: null,
		text: "",
	});
	assert.deepEqual(
		entrySummary(JSON.stringify({ type: "label", timestamp: "t1" })),
		{ ts: "t1", role: null, text: "" },
	);
	assert.deepEqual(
		entrySummary(JSON.stringify({ type: "message", timestamp: "t2" })),
		{ ts: "t2", role: null, text: "" },
	);
	assert.deepEqual(
		entrySummary(JSON.stringify({ type: "session_info", timestamp: "t3" })),
		{ ts: "t3", role: "session_info", text: "" },
	);

	const long = entrySummary(
		JSON.stringify({
			type: "message",
			message: { role: "user", content: "y".repeat(600), timestamp: 1 },
		}),
	);
	assert.ok(long.text.length <= 401 && long.text.endsWith("…"));

	const multi = entrySummary(
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "x" },
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
				],
			},
		}),
	);
	assert.equal(multi.text, "a\nb");
	assert.equal(multi.role, "assistant");
});

// --- db branches -------------------------------------------------------------------

test("db: corrupt registry.json import falls back to empty, no crash", () => {
	writeFileSync(join(agentDir, "registry.json"), "{corrupt json,,");
	const db = openDb(agentDir);
	assert.equal(loadRegistrySync(agentDir).projects.length, 0);
	db.close();
});

test("db: schema_version mismatch clamps back to current", () => {
	const db = openDb(agentDir);
	db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
	db.close();
	const db2 = openDb(agentDir);
	const v = db2
		.prepare("SELECT value FROM meta WHERE key = 'schema_version'")
		.get() as { value: string };
	assert.equal(Number(v.value), 1);
	db2.close();
});

test("db: syncConfigFile repairs corrupt file when stored value exists", () => {
	const db = openDb(agentDir);
	writeFileSync(join(agentDir, "settings.json"), '{"theme":"blueberry"}');
	assert.equal(
		syncConfigFile(db, agentDir, "settings", "settings.json"),
		"ingested",
	);

	writeFileSync(join(agentDir, "settings.json"), "{broken");
	assert.equal(
		syncConfigFile(db, agentDir, "settings", "settings.json"),
		"materialized",
	);
	assert.ok(
		readFileSync(join(agentDir, "settings.json"), "utf8").includes("blueberry"),
	);
	db.close();
});

// --- launcher spawn failure ----------------------------------------------------------

test("launcher: spawn error propagates (bundle missing)", async () => {
	// fork reality: spawn fails when the bundle path doesn't exist (no PATH)
	const oldBundle = process.env["BLUEBERRY_PI_BUNDLE"];
	process.env["BLUEBERRY_PI_BUNDLE"] = "/nonexistent-blueberry-test/no-bundle.js";
	try {
		const { prepareLaunch, defaultSpawnPi } = await import(
			"../src/core/launcher.ts"
		);
		const root = fakeRepo(area, "spawner", "git");
		const plan = await prepareLaunch({
			cwd: root,
			argv: [],
			agentDir,
			registry: loadRegistry(agentDir),
			persist: false,
			gitRemoteReader: () => null,
		});
		// missing module ≠ spawn error: the runtime starts and exits nonzero
		const code = await defaultSpawnPi(plan);
		assert.notEqual(code, 0, "nonzero exit when bundle is missing");
	} finally {
		if (oldBundle === undefined) delete process.env["BLUEBERRY_PI_BUNDLE"];
		else process.env["BLUEBERRY_PI_BUNDLE"] = oldBundle;
	}
});

// --- todo-pane remaining branches ----------------------------------------------------

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bold: (s: string) => s,
};

test("pane: empty board renders zero counts", () => {
	const lines = renderPane(100, identityTheme, [], { cursor: 0, detail: false });
	assert.ok(lines[0]!.includes("0/0 done"));
	assert.ok(lines.some((l) => l.includes("todo 0")));
});

test("pane: layoutFor enforces min column width on narrow terminals", () => {
	const { colW } = layoutFor(30);
	assert.equal(colW, 12);
});

test("store: dropped tasks render in done column", () => {
	const cards = toCards([
		{
			id: "full-uuid-dropped-01",
			hex6: "pped01",
			project_id: "p",
			title: "abandoned idea",
			track: null,
			stage: "dropped",
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			done_at: null,
			blockedBy: [],
		},
	]);
	assert.equal(cards[0]!.stage, "done");
});

test("pane: close-from-detail returns to pane (not CLOSED)", () => {
	const s = applyInput({ cursor: 2, detail: true }, "close", 5);
	assert.deepEqual(s, { cursor: 2, detail: false });
});

// --- remaining mapped branches --------------------------------------------------------

test("db: importRegistryJson skips invalid entries and tolerates missing fields", () => {
	writeFileSync(
		join(agentDir, "registry.json"),
		JSON.stringify({
			version: 1,
			projects: [
				{ broken: true }, // no string id → skipped
				{ id: "keep-1", slug: "kept", canonicalPath: "/k/one" }, // no aliases/sessionStore → defaults
			],
		}),
	);
	const db = openDb(agentDir);
	const projects = loadRegistrySync(agentDir).projects;
	assert.equal(projects.length, 1);
	assert.equal(projects[0]!.slug, "kept");
	assert.deepEqual(projects[0]!.aliases, []);
	assert.equal(projects[0]!.sessionStore, "central");
	db.close();
});

test("store: createTodo with track and without sessionId; rowToTodo keeps track", () => {
	const { createTodo, listTodos } = store_mod();
	const res = createTodo(db2(), "PROJECT", "tracked task", { track: "infra" });
	assert.ok(res.ok && res.todo);
	const res2 = createTodo(db2(), "PROJECT", "sessionless task");
	assert.ok(res2.ok && res2.todo);
	const rows = listTodos(db2(), "PROJECT");
	const tracked = rows.find((t) => t.title === "tracked task")!;
	assert.equal(tracked.track, "infra");
	const sessionless = rows.find((t) => t.title === "sessionless task")!;
	assert.equal(sessionless.track, null);
});

import * as store_mod2 from "../src/core/todo-store.ts";
function db2() {
	return openDb(agentDir);
}
function store_mod() {
	return store_mod2;
}
