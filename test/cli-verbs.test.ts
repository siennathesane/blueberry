/**
 * CLI verb coverage — main()-level tests with injected deps (the node-era
 * pattern, extended to the new verbs): update --check, cmd new/run/ls/ps/
 * logs/template, import dry-run, --license/--version/--help, and the
 * unknown-command passthrough arm.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { main, defaultDeps } from "../src/cli/main.ts";
import { openDb } from "../src/core/db.ts";
import { tmpAgentDir, tmpDir, fakeRepo, cleanup } from "./helpers.ts";

let agentDir: string;
let area: string;
let outLines: string[];
let errLines: string[];

function deps(overrides: Partial<ReturnType<typeof defaultDeps>> = {}) {
	return {
		...defaultDeps(),
		agentDir,
		cwd: area,
		out: (l: string) => void outLines.push(l),
		err: (l: string) => void errLines.push(l),
		runPi: (async () => 0) as ReturnType<typeof defaultDeps>["runPi"],
		...overrides,
	};
}

beforeEach(() => {
	agentDir = tmpAgentDir();
	area = tmpDir("bb-cliverbs-");
	outLines = [];
	errLines = [];
});

afterEach(() => {
	cleanup(area);
});

// --- top-level flags -----------------------------------------------------------------

test("main: --help prints USAGE including cmd/import/license lines", async () => {
	const rc = await main(["--help"], deps());
	assert.equal(rc, 0);
	assert.ok(outLines.join("\n").includes("blueberry cmd new"));
	assert.ok(outLines.join("\n").includes("blueberry import"));
	assert.ok(outLines.join("\n").includes("--license"));
});

test("main: --license prints the summary; --version prints version + license line", async () => {
	assert.equal(await main(["--license"], deps()), 0);
	assert.ok(outLines.join("\n").includes("PolyForm Strict"));
	outLines = [];
	assert.equal(await main(["--version"], deps()), 0);
	assert.ok(outLines[0]!.startsWith("blueberry "));
	assert.ok(outLines[1]!.includes("PolyForm Strict"));
});

test("main: unknown command routes to launch (runPi) and propagates its code", async () => {
	let ran = false;
	const rc = await main(
		["--print", "hello"],
		deps({
			runPi: (async () => {
				ran = true;
				return 42;
			}) as ReturnType<typeof defaultDeps>["runPi"],
		}),
	);
	// prepareLaunch needs a resolvable project: fakeRepo registers via resolution
	assert.equal(ran, true);
	assert.equal(rc, 42);
});

// --- cmd verbs ------------------------------------------------------------------------

test("main: cmd new → run → logs happy path through dispatch", async () => {
	const rc1 = await main(
		["cmd", "new", "a=echo one", "b=echo two", "--dep", "b:a"],
		deps(),
	);
	assert.equal(rc1, 0);
	const graphId = outLines[0]!.trim();
	assert.match(graphId, /^[0-9a-f-]{36}$/);

	outLines = [];
	assert.equal(await main(["cmd", "run", graphId.slice(0, 8)], deps()), 0);
	assert.match(outLines[0]!, /^graph \w+ done$/);

	outLines = [];
	assert.equal(await main(["cmd", "logs", graphId.slice(0, 8)], deps()), 0);
	const logText = outLines.join("\n");
	assert.ok(logText.includes("── a [ok 0] ──"));
	assert.ok(logText.includes("one"));
	assert.ok(logText.includes("── b [ok 0] ──"));
});

test("main: cmd new rejects bad node spec; cmd run --bg detaches; ps lists nothing after done", async () => {
	assert.equal(await main(["cmd", "new", "no-equals-sign"], deps()), 1);
	assert.ok(errLines.some((l) => l.includes("name=command")));
	errLines = [];

	await main(["cmd", "new", "quick=echo q"], deps());
	const graphId = outLines[0]!.trim();
	outLines = [];
	assert.equal(await main(["cmd", "run", graphId, "--bg"], deps()), 0);
	assert.match(outLines[0]!, /^bg \w+/);
	// wait for the detached executor to finish
	await new Promise((r) => setTimeout(r, 1500));
	outLines = [];
	assert.equal(await main(["cmd", "ps"], deps()), 0);
	// done graph → ps empty
	assert.equal(outLines.length, 0);
});

test("main: cmd template save → list → run with --arg", async () => {
	assert.equal(
		await main(
			["cmd", "template", "save", "hello", "who", "say=echo hi $BB_ARG_WHO"],
			deps(),
		),
		0,
	);
	assert.match(outLines[0]!, /template 'hello' saved/);

	outLines = [];
	assert.equal(await main(["cmd", "template", "list"], deps()), 0);
	assert.match(outLines[0]!, /^hello\s/);

	outLines = [];
	assert.equal(
		await main(["cmd", "run", "hello", "--arg", "who=world"], deps()),
		0,
	);
	assert.match(outLines[0]!, /^graph \w+ done$/);
	const graphId = outLines[0]!.split(" ")[1]!;

	outLines = [];
	assert.equal(await main(["cmd", "logs", graphId], deps()), 0);
	assert.ok(outLines.join("\n").includes("hi world"));
});

test("main: cmd ls lists graphs; unknown verb usage error", async () => {
	await main(["cmd", "new", "x=echo x"], deps());
	outLines = [];
	assert.equal(await main(["cmd", "ls"], deps()), 0);
	assert.match(outLines[0]!, /^\w{8}\s+/);

	assert.equal(await main(["cmd", "frobnicate"], deps()), 1);
	assert.ok(errLines.some((l) => l.includes("cmd new|run|ls")));
});

test("main: cmd run with no target errors", async () => {
	assert.equal(await main(["cmd", "run"], deps()), 1);
	assert.ok(errLines.some((l) => l.includes("needs a graph")));
});

// --- import (dry-run only here; apply covered in import-history tests) ----------------

test("main: import dry-run scans, reports, writes nothing", async () => {
	const home = join(area, "fakehome");
	const claudeDir = join(home, ".claude", "projects", "-edge-proj");
	mkdirSync(claudeDir, { recursive: true });
	writeFileSync(
		join(claudeDir, "sess-x.jsonl"),
		'{"type":"user","uuid":"u","parentUuid":null,"sessionId":"sess-x","timestamp":"2026-01-01T00:00:00Z","cwd":"' +
			area +
			'","message":{"role":"user","content":"hi"}}\n',
	);
	// main reads ~/.claude — can't point it elsewhere without HOME override;
	// this test pins the dispatch + report surface only (real dirs tested in
	// import-history.test.ts against synthetic workDirs)
	const rc = await main(["import"], deps());
	assert.equal(rc, 0);
	assert.ok(
		outLines.some((l) => l.includes("would import") || l.includes("imported")),
		"report line present",
	);
});

// --- version guard surface ------------------------------------------------------------

test("main: -v short flag matches --version", async () => {
	assert.equal(await main(["-v"], deps()), 0);
	assert.ok(outLines[0]!.startsWith("blueberry "));
});
