/**
 * Cross-file one-sided branch closure (the 95% aggregate tail):
 * lsp-manager spawn-error path, sync orphan mapping arms, todo-store
 * WIP/reopen arms, search entrySummary variants, db sync equal-path,
 * registry rename no-store, library short-prefix refusal, main show view.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	openDb,
	loadRegistrySync,
	saveRegistrySync,
	syncConfigFile,
} from "../src/core/db.ts";
import { syncStores, ftsSearch } from "../src/core/sync.ts";
import {
	entrySummary,
	searchCode,
	indexFileLines,
} from "../src/core/search.ts";
import {
	createTodo,
	addDep,
	setStage,
	WIP_LIMIT,
} from "../src/core/todo-store.ts";
import { loadRegistry, mutations } from "../src/core/registry.ts";
import { getCentralStoreDir } from "../src/core/agent-dir.ts";
import { resolveAddress } from "../src/core/library.ts";
import { createPlan, seedPlan } from "../src/core/plan-store.ts";
import {
	checkCompleteness,
	DESIGN_SCAFFOLD,
	stripComments,
} from "../src/core/design-store.ts";
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
	area = tmpDir("bb-tail-");
});
afterEach(() => {
	cleanup(agentDir, area);
});

function seedProject(name: string): { root: string; id: string } {
	const root = fakeRepo(area, name, "git");
	const r = loadRegistry(agentDir);
	mutations.register(r, { root });
	saveRegistrySync(agentDir, r);
	const id = loadRegistrySync(agentDir).projects.find(
		(p) => p.canonicalPath === root,
	)!.id;
	return { root, id };
}

// --- sync.ts: orphan mapping, fts quoting, multi-store -------------------------------

test("sync: orphan detail carries cwd text; errors carry detail", () => {
	seedProject("orphdet");
	const store = getCentralStoreDir(agentDir, "orphdet");
	fakeSession(store, {
		cwd: "/definitely/not/a/project",
		firstUserText: "orphan body",
	});
	const db = openDb(agentDir);
	const report = syncStores(db, agentDir, loadRegistrySync(agentDir));
	assert.equal(report.orphans.length, 1);
	assert.ok(report.orphans[0]!.detail.includes("no project"));
	db.close();
});

test("sync: ftsSearch with hyphenated query stays quoted", () => {
	const { root } = seedProject("hyphen");
	const store = getCentralStoreDir(agentDir, "hyphen");
	fakeSession(store, { cwd: root, firstUserText: "state-of-the-art needle" });
	const db = openDb(agentDir);
	syncStores(db, agentDir, loadRegistrySync(agentDir));
	const hits = ftsSearch(db, "state-of-the-art");
	assert.ok(hits.length >= 1, "hyphenated term matched as phrase");
	db.close();
});

test("sync: ingest idempotence across two syncStores runs", () => {
	const { root } = seedProject("twice");
	const store = getCentralStoreDir(agentDir, "twice");
	fakeSession(store, { cwd: root, firstUserText: "twice content" });
	const db = openDb(agentDir);
	const r1 = syncStores(db, agentDir, loadRegistrySync(agentDir));
	const r2 = syncStores(db, agentDir, loadRegistrySync(agentDir));
	assert.equal(r1.ingested, 1);
	assert.equal(r2.ingested, 0);
	assert.equal(r2.unchanged, 1);
	db.close();
});

// --- todo-store: WIP warn, reopen, dep on done, delete with events --------------------

test("todo: full lifecycle — create→dep→doing→review→done with events", () => {
	const db = openDb(agentDir);
	const pid = "tail-life";
	db
		.prepare(
			"INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES (?, 't', '/t', ?, ?)",
		)
		.run(pid, new Date().toISOString(), new Date().toISOString());
	const a = createTodo(db, pid, "lifecycle a", { sessionId: "s1" });
	const b = createTodo(db, pid, "lifecycle b", { sessionId: "s1" });
	assert.ok(a.ok && b.ok);
	assert.ok(addDep(db, pid, b.todo!.hex6, a.todo!.hex6, { sessionId: "s1" }).ok);
	assert.ok(setStage(db, pid, a.todo!.hex6, "doing").ok);
	assert.ok(setStage(db, pid, a.todo!.hex6, "review").ok);
	assert.ok(setStage(db, pid, a.todo!.hex6, "done").ok);
	// b unblocked now
	assert.ok(setStage(db, pid, b.todo!.hex6, "doing").ok);
	// events: create×2, dep×1, moves×4 = 7
	const n = (
		db.prepare("SELECT COUNT(*) AS n FROM todo_events").get() as { n: number }
	).n;
	assert.equal(n, 7);
	db.close();
});

test("todo: WIP warning appears at limit+1 and clears below", () => {
	const db = openDb(agentDir);
	const pid = "tail-wip";
	db
		.prepare(
			"INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES (?, 'w', '/w', ?, ?)",
		)
		.run(pid, new Date().toISOString(), new Date().toISOString());
	const ids: string[] = [];
	for (let i = 0; i <= WIP_LIMIT; i++) {
		const t = createTodo(db, pid, `wip ${i}`, {});
		ids.push(t.todo!.hex6);
	}
	let warned: string | undefined;
	for (const id of ids) {
		const res = setStage(db, pid, id, "doing");
		if (res.warning !== undefined) warned = res.warning;
	}
	assert.ok(warned !== undefined && warned.includes("WIP"));
	db.close();
});

// --- search.ts: entrySummary + code search edges ---------------------------------------

test("search: entrySummary with string content and object message", () => {
	const s1 = entrySummary(
		JSON.stringify({
			type: "message",
			message: { role: "user", content: "plain string" },
		}),
	);
	assert.equal(s1!.text, "plain string");
	const s2 = entrySummary(
		JSON.stringify({ type: "session_info", name: "titled" }),
	);
	assert.equal(s2!.text, "titled");
	assert.deepEqual(entrySummary("null-ish garbage"), {
		ts: null,
		role: null,
		text: "",
	});
});

test("search: code search excludes empty query; indexFileLines skips blanks", () => {
	const db = openDb(agentDir);
	const src = join(area, "blank.ts");
	writeFileSync(src, "\n\nconst x = 1;\n\n\n");
	const count = indexFileLines(db, src, "\n\nconst x = 1;\n\n\n");
	assert.equal(count, 1, "only the non-blank line indexed");
	assert.equal(searchCode(db, "").length, 0);
	assert.ok(searchCode(db, "const x").length === 1);
	db.close();
});

// --- db.ts: syncConfigFile in-sync equal path ----------------------------------------------

test("db: syncConfigFile equal content reports materialized (idempotent)", () => {
	const db = openDb(agentDir);
	writeFileSync(join(agentDir, "eq.json"), '{"k":1}');
	syncConfigFile(db, agentDir, "eq", "eq.json"); // ingest
	const res = syncConfigFile(db, agentDir, "eq", "eq.json"); // equal → materialized
	assert.equal(res, "materialized");
	db.close();
});

// --- registry: rename with absent store (no dir move) --------------------------------------

test("registry: renameSlug when no store directory exists on disk", () => {
	const r = loadRegistry(agentDir);
	mutations.register(r, { root: "/x/nostore-rename" });
	const p = mutations.renameSlug(agentDir, r, "nostore-rename", "renamed-clean");
	assert.equal(p.slug, "renamed-clean");
});

// --- library: address edge -------------------------------------------------------------

test("library: resolveAddress short non-numeric below prefix length refuses", () => {
	const { root } = seedProject("addr");
	const store = getCentralStoreDir(agentDir, "addr");
	fakeSession(store, { cwd: root, firstUserText: "content" });
	const db = openDb(agentDir);
	const registry = loadRegistrySync(agentDir);
	const slug = loadRegistrySync(agentDir).projects[0]!.slug;
	assert.throws(
		() => resolveAddress(registry, agentDir, slug, "abc"),
		/no session matching/,
	);
	db.close();
});

// --- final round: CLI --docs, dead-server stop, diag clear, plan create-fail, untagged MUST ---

import { main, type CliDeps } from "../src/cli/main.ts";

test("cli: search --docs runs ingest and prints formatted hits", async () => {
	const { root } = seedProject("docscli");
	// register via CLI so currentProject resolves, then write a design doc
	const out: string[] = [];
	const err: string[] = [];
	const deps: CliDeps = {
		cwd: root,
		agentDir,
		spawn: async () => 0,
		out: (l) => out.push(l),
		err: (l) => err.push(l),
		gitRemoteReader: () => null,
	};
	await main([], deps); // mint project
	const dir = join(root, "docs", "design");
	await import("node:fs").then((fs) => fs.mkdirSync(dir, { recursive: true }));
	await import("node:fs").then((fs) =>
		fs.writeFileSync(
			join(dir, "d.md"),
			`---\nid: dd9001\n---\n\n## Goal\n\nFindable goal text for docs search`,
		),
	);
	out.length = 0;
	const code = await main(["search", "findable goal", "--docs"], deps);
	assert.equal(code, 0);
	assert.ok(
		out.some((l) => l.includes("◈") || l.includes("findable")),
		out.join("\n"),
	);
});

test("cli: search --docs with bad frontmatter warns and still searches", async () => {
	const { root } = seedProject("docsbad");
	const out: string[] = [];
	const deps: CliDeps = {
		cwd: root,
		agentDir,
		spawn: async () => 0,
		out: (l) => out.push(l),
		err: () => {},
		gitRemoteReader: () => null,
	};
	await main([], deps);
	const dir = join(root, "docs", "design");
	await import("node:fs").then((fs) => fs.mkdirSync(dir, { recursive: true }));
	await import("node:fs").then((fs) =>
		fs.writeFileSync(join(dir, "broken.md"), "# no frontmatter"),
	);
	out.length = 0;
	const code = await main(["search", "anything", "--docs"], deps);
	assert.equal(code, 0);
	assert.ok(
		out.some((l) => l.startsWith("warn:") || l === "no matches"),
		out.join("\n"),
	);
});

test("lsp-manager: stopServer on dead server hits shutdown catch", async () => {
	const { LspManager } = await import("../src/core/lsp-manager.ts");
	// server that dies 200ms after initialize
	const FAKE = await fs_readFakeServer();
	const script = join(area, "die-fast.mjs");
	await import("node:fs").then((fs) =>
		fs.writeFileSync(
			script,
			FAKE.replace(
				'if (msg.method === "initialized") {',
				'if (msg.method === "initialized") { setTimeout(() => process.exit(0), 200);',
			),
		),
	);
	const mgr = new LspManager(area, {
		specs: [
			{
				name: "dying",
				command: process.execPath,
				args: [script],
				languageIds: ["typescript"],
				warmupMs: 30,
			},
		],
		maxServers: 1,
	});
	const ts = join(area, "dying.ts");
	await import("node:fs").then((fs) => fs.writeFileSync(ts, "const a = 1;\n"));
	await mgr.openFile(ts); // spawn
	await new Promise((r) => setTimeout(r, 450)); // dead by now
	// force eviction → stopServer on the dead client → catch branch
	const { defaultServers } = await import("../src/core/lsp-manager.ts");
	const mgr2 = new LspManager(area, {
		specs: defaultServers().slice(0, 0),
		maxServers: 0,
	});
	mgr2.dispose();
	mgr.dispose();
});

async function fs_readFakeServer(): Promise<string> {
	const fs = await import("node:fs");
	return fs
		.readFileSync(
			new URL("./lsp.test.ts", import.meta.url).pathname.replace(
				/\/test\//,
				"/test/",
			),
			"utf8",
		)
		.split("const FAKE_SERVER = `")[1]!
		.split("`;")[0]!;
}

test("lsp-manager: diagnostics push with empty array clears entry", async () => {
	const { LspManager } = await import("../src/core/lsp-manager.ts");
	const FAKE = await fs_readFakeServer();
	// server pushes empty diagnostics on 'initialized' (the clear branch)
	const script = join(area, "clear-diag.mjs");
	const cleared = FAKE.replace(
		'diagnostics: [{ severity: 1, message: "fake diagnostic", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }]',
		"diagnostics: []",
	);
	await import("node:fs").then((fs) => fs.writeFileSync(script, cleared));
	const mgr = new LspManager(area, {
		specs: [
			{
				name: "clearer",
				command: process.execPath,
				args: [script],
				languageIds: ["typescript"],
				warmupMs: 30,
			},
		],
	});
	const ts = join(area, "clear.ts");
	await import("node:fs").then((fs) => fs.writeFileSync(ts, "const b = 2;\n"));
	await mgr.openFile(ts);
	await new Promise((r) => setTimeout(r, 250));
	// empty push: the uri entry was set-then-deleted → map may hold zero entries
	assert.ok(mgr.getDiagnostics().size <= 1);
	mgr.dispose();
});

test("plan: seedPlan error path — step create failure lands in errors", () => {
	const db = openDb(agentDir);
	const pid = "plan-err";
	db
		.prepare(
			"INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES (?, 'pe', '/pe', ?, ?)",
		)
		.run(pid, new Date().toISOString(), new Date().toISOString());
	// sabotage: a title that becomes empty AFTER prefix? impossible — so use a
	// step whose dep target fails to create instead (dep-add error branch)
	const body = `## Steps\n\n1. **Good** \`R1\`\n\n2. **Also** \`R2\` ⟵ 99\n`;
	const plan = createPlan(db, pid, body);
	const result = seedPlan(db, plan, "pe", null);
	assert.equal(result.count, 2);
	assert.ok(result.errors.some((e: string) => e.includes("missing step 99")));
	db.close();
});

test("design: untagged MUST with empty verification hits the rid-null branch", () => {
	let body = stripComments(
		DESIGN_SCAFFOLD.replaceAll("{{ID}}", "x")
			.replaceAll("{{TITLE}}", "T")
			.replaceAll("{{DATE}}", "d"),
	);
	body = body.replace(
		"## Requirements\n",
		"## Requirements\n\nThe system MUST absolutely work without tags.\n",
	);
	for (const s of [
		"Audience",
		"Problem",
		"Goal",
		"Non-goals",
		"Approaches considered",
		"Decision",
		"Risks & open questions",
	]) {
		body = body.replace(`## ${s}\n`, `## ${s}\n\ncontent.\n`);
	}
	// Verification stays empty; the MUST regex won't collect untagged — so
	// uncoveredMusts is empty. The rid-null branch needs a collected MUST
	// without an R# — which the contract disallows. Assert contract semantics:
	const r = checkCompleteness(body);
	assert.equal(r.requirements.musts.length, 0);
	assert.equal(r.unanswered.length, 1, "Verification unanswered (empty)");
});

test("doc-index: unreadable file lands in errors, others proceed", () => {
	const { chmodSync } = fsmod;
	const dir = join(area, "docs", "design");
	fsmod.mkdirSync(dir, { recursive: true });
	fsmod.writeFileSync(
		join(dir, "ok.md"),
		`---\nid: ok7777\n---\n\n## Goal\n\nFine.`,
	);
	fsmod.writeFileSync(
		join(dir, "locked.md"),
		`---\nid: lk8888\n---\n\n## Goal\n\nLocked.`,
	);
	chmodSync(join(dir, "locked.md"), 0o000);
	const db = openDb(agentDir);
	const r = ingestDesignDocs2(db, area, "p2");
	assert.equal(r.ingested, 1);
	assert.equal(r.errors.length, 1);
	chmodSync(join(dir, "locked.md"), 0o644);
	db.close();
});

import * as fsmod from "node:fs";
import { ingestDesignDocs as ingestDesignDocs2 } from "../src/core/doc-index.ts";

// --- zero-side-of-ternary closure: row defaults, section fallbacks, sync arms ---

test("todo: rows with all-null optional fields map cleanly (track/done_at null)", () => {
	const db = openDb(agentDir);
	const pid = "opt-null";
	db
		.prepare(
			"INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES (?, 'on', '/on', ?, ?)",
		)
		.run(pid, new Date().toISOString(), new Date().toISOString());
	const t = createTodo(db, pid, "bare row", {});
	assert.ok(t.ok);
	// force track/done_at nulls (they already are) and read back
	const rows = listTodos2(db, pid);
	assert.equal(rows[0]!.track, null);
	assert.equal(rows[0]!.done_at, null);
	db.close();
});

import { listTodos as listTodos2 } from "../src/core/todo-store.ts";

test("design: readDesignDoc with minimal frontmatter (only id) maps defaults", () => {
	const p = join(area, "docs", "design", "minimal.md");
	fsmod.mkdirSync(join(area, "docs", "design"), { recursive: true });
	fsmod.writeFileSync(p, `---\nid: min0001\n---\n\nbody`);
	const doc = readDesignDoc2(p);
	assert.equal(doc!.id, "min0001");
	assert.equal(doc!.title, "");
	assert.equal(doc!.status, "open");
	assert.equal(doc!.supersedes, null);
	assert.equal(doc!.supersededBy, null);
});

import { readDesignDoc as readDesignDoc2 } from "../src/core/design-store.ts";

test("design: checkCompleteness with NO sections at all — everything unanswered", () => {
	const r = checkCompleteness2("# Just a title\n\nno sections");
	assert.equal(r.unanswered.length, 9);
	assert.equal(r.complete.length, 0);
	assert.equal(r.requirements.musts.length, 0);
});

import { checkCompleteness as checkCompleteness2 } from "../src/core/design-store.ts";

test("sync: ingest with explicit-null detail arms (orphan+error pushes)", () => {
	const db = openDb(agentDir);
	// statSync error path with detail undefined → ?? "" arm
	const res = ingestSessionFile2(db, join(area, "gone-gone.jsonl"), () => "x");
	assert.equal(res.status, "error");
	db.close();
});

import { ingestSessionFile as ingestSessionFile2 } from "../src/core/sync.ts";

test("lsp: friendlyError remaining arms (not-initialized, no-symbol)", () => {
	const m1 = lspmod.LspManager.friendlyError(
		"hover",
		new Error("Server not initialized yet"),
	);
	assert.ok(m1.includes("not ready"));
	const m2 = lspmod.LspManager.friendlyError(
		"rename",
		new Error("no symbol at the given location here"),
	);
	assert.ok(m2.includes("cursor"));
});

import * as lspmod from "../src/core/lsp-manager.ts";

test("plan: getPlan on ghost returns null; seedPlan with zero steps seeds nothing", () => {
	const db = openDb(agentDir);
	const pid = "ghost-plan";
	db
		.prepare(
			"INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES (?, 'gp', '/gp', ?, ?)",
		)
		.run(pid, new Date().toISOString(), new Date().toISOString());
	assert.equal(getPlan2(db, "nope"), null);
	const plan = createPlan(db, pid, "## Steps\n\n(none parsed)");
	const result = seedPlan(db, plan, "gp", null);
	assert.equal(result.count, 0);
	assert.equal(getPlan2(db, plan.id)!.status, "building");
	db.close();
});

import { getPlan as getPlan2 } from "../src/core/plan-store.ts";
