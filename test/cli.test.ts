import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { main, defaultDeps, type CliDeps } from "../src/cli/main.ts";
import { findBySlug } from "../src/core/registry.ts";
import { loadRegistrySync } from "../src/core/db.ts";
import { getCentralStoreDir } from "../src/core/agent-dir.ts";
import { readSessionHeader, listSessions } from "../src/core/sessions.ts";
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
let outLines: string[];
let errLines: string[];
let spawnCalls: Array<{
	root: string;
	sessionDir: string;
	argv: string[];
	env: NodeJS.ProcessEnv;
}>;

function deps(cwd: string): CliDeps {
	return {
		cwd,
		agentDir,
		runPi: async (plan) => {
			spawnCalls.push({
				root: plan.root,
				sessionDir: plan.sessionDir,
				argv: plan.argv,
				env: plan.env,
			});
			return 0;
		},
		out: (l) => outLines.push(l),
		err: (l) => errLines.push(l),
		gitRemoteReader: () => null,
	};
}

beforeEach(() => {
	agentDir = tmpAgentDir();
	area = tmpDir("bb-cli-");
	outLines = [];
	errLines = [];
	spawnCalls = [];
});
afterEach(() => {
	cleanup(agentDir, area);
});

test("cli: --help prints usage", async () => {
	const code = await main(["--help"], deps(area));
	assert.equal(code, 0);
	assert.ok(outLines.some((l) => l.includes("blueberry")));
	assert.ok(outLines.some((l) => l.includes("sessions list")));
});

test("cli: launch mode resolves project and spawns pi with env", async () => {
	const root = fakeRepo(area, "launch", "git");
	const code = await main([], deps(root));
	assert.equal(code, 0);
	assert.equal(spawnCalls.length, 1);
	assert.equal(spawnCalls[0]!.root, root);
	assert.equal(spawnCalls[0]!.env["PI_CODING_AGENT_DIR"], agentDir);
	assert.ok(
		spawnCalls[0]!.env["PI_CODING_AGENT_SESSION_DIR"]!.includes(
			"/sessions/launch",
		),
	);
});

test("cli: unknown first arg passes through to pi launch", async () => {
	const root = fakeRepo(area, "passthru", "git");
	const code = await main(["-p", "hello world"], deps(root));
	assert.equal(code, 0);
	assert.deepEqual(spawnCalls[0]!.argv, ["-p", "hello world"]);
});

test("cli: projects list / rename / forget", async () => {
	const root = fakeRepo(area, "proj-a", "git");
	await main([], deps(root)); // mint + persist

	assert.equal(await main(["projects", "list"], deps(area)), 0);
	assert.ok(outLines.some((l) => l.includes("proj-a")));

	assert.equal(
		await main(["projects", "rename", "proj-a", "proj-b"], deps(area)),
		0,
	);
	const r = loadRegistrySync(agentDir);
	assert.ok(findBySlug(r, "proj-b"));
	assert.ok(!findBySlug(r, "proj-a"));

	assert.equal(await main(["projects", "forget", "proj-b"], deps(area)), 0);
	assert.equal(loadRegistrySync(agentDir).projects.length, 0);
});

test("cli: projects nest/unnest guardrails and messaging", async () => {
	const outer = fakeRepo(area, "host", "git");
	const inner = fakeRepo(outer, "guest", "git");
	await main([], deps(outer));
	await main([], deps(inner));

	assert.equal(
		await main(["projects", "nest", "guest", "--into", "host"], deps(area)),
		0,
	);
	assert.ok(outLines.some((l) => l.includes("belong to 'host'")));

	assert.equal(await main(["projects", "unnest", "guest"], deps(area)), 0);
	assert.ok(outLines.some((l) => l.includes("own sessions")));
});

test("cli: sessions list/rename/move/trash end to end", async () => {
	const rootA = fakeRepo(area, "src-proj", "git");
	const rootB = fakeRepo(area, "dst-proj", "git");
	await main([], deps(rootA));
	await main([], deps(rootB));
	fakeSession(getCentralStoreDir(agentDir, "src-proj"), {
		cwd: rootA,
		firstUserText: "hello there",
	});

	// list
	assert.equal(await main(["sessions", "list"], deps(rootA)), 0);
	assert.ok(outLines.some((l) => l.includes("hello there")));

	// rename by index
	assert.equal(
		await main(["sessions", "rename", "1", "my-session"], deps(rootA)),
		0,
	);
	assert.equal(await main(["sessions", "list", "--json"], deps(rootA)), 0);
	const listed = JSON.parse(outLines[outLines.length - 1]!) as Array<{
		name: string | null;
	}>;
	assert.equal(listed[0]?.name, "my-session");

	// move to other project
	assert.equal(
		await main(["sessions", "move", "my-session", "dst-proj"], deps(rootA)),
		0,
	);
	assert.equal(listSessions(getCentralStoreDir(agentDir, "dst-proj")).length, 1);
	assert.equal(listSessions(getCentralStoreDir(agentDir, "src-proj")).length, 0);
	assert.equal(
		readSessionHeader(
			listSessions(getCentralStoreDir(agentDir, "dst-proj"))[0]!.file,
		)?.cwd,
		rootB,
	);

	// trash
	assert.equal(await main(["sessions", "trash", "1"], deps(rootB)), 0);
	assert.equal(listSessions(getCentralStoreDir(agentDir, "dst-proj")).length, 0);
});

test("cli: sessions open spawns pi with --session in project root", async () => {
	const root = fakeRepo(area, "openable", "git");
	await main([], deps(root));
	const s = fakeSession(getCentralStoreDir(agentDir, "openable"), {
		cwd: root,
		firstUserText: "x",
		id: "cccccccc-3333-4333-8333-333333333333", // deterministic non-digit prefix
	});
	const id = readSessionHeader(s)!.id;

	// open from an unrelated directory via --project (the cross-project browser path)
	assert.equal(
		await main(
			["sessions", "open", id.slice(0, 8), "--project", "openable"],
			deps(area),
		),
		0,
	);
	const last = spawnCalls[spawnCalls.length - 1]!;
	assert.equal(last.root, root);
	assert.ok(last.argv.includes("--session"));
	assert.ok(last.argv.some((a) => a.endsWith(".jsonl")));
});

test("cli: adopt --copy leaves the pi source tree untouched", async () => {
	const root = fakeRepo(area, "clipy", "git");
	const piSource = `${area}/pi-sessions`;
	const piStore = `${piSource}/${encodeCwdToDirName(root)}`;
	fakeSession(piStore, { cwd: root, firstUserText: "ancient" });

	assert.equal(await main(["adopt", piSource, "--copy"], deps(area)), 0);
	assert.ok(
		outLines.some((l) => l.includes("imported 1 sessions -> clipy (copied)")),
	);
	assert.equal(readdirSync(piStore).length, 1, "source file preserved");
	assert.equal(readdirSync(getCentralStoreDir(agentDir, "clipy")).length, 1);

	// re-run reports duplicates without spawning files
	assert.equal(await main(["adopt", piSource, "--copy"], deps(area)), 0);
	assert.ok(outLines.some((l) => l.includes("already present")));
	assert.equal(readdirSync(getCentralStoreDir(agentDir, "clipy")).length, 1);
});

test("cli: adopt imports pi history from a source dir", async () => {
	const root = fakeRepo(area, "historic", "git");
	const piSource = `${area}/pi-sessions`;
	const piStore = `${piSource}/${encodeCwdToDirName(root)}`;
	fakeSession(piStore, { cwd: root, firstUserText: "ancient" });

	assert.equal(await main(["adopt", piSource], deps(area)), 0);
	assert.ok(outLines.some((l) => l.includes("imported 1 sessions -> historic")));
	const r = loadRegistrySync(agentDir);
	assert.ok(findBySlug(r, "historic"));
	assert.equal(listSessions(getCentralStoreDir(agentDir, "historic")).length, 1);
});

test("cli: fix applies, doctor is read-only", async () => {
	const root = fakeRepo(area, "fixable", "git");
	// orphan store with a recoverable cwd
	fakeSession(getCentralStoreDir(agentDir, "fixable"), { cwd: root });

	assert.equal(await main(["doctor"], deps(area)), 0);
	assert.ok(outLines.some((l) => l.includes("would register")));
	assert.equal(
		loadRegistrySync(agentDir).projects.length,
		0,
		"doctor mutated nothing",
	);

	assert.equal(await main(["fix"], deps(area)), 0);
	assert.ok(
		loadRegistrySync(agentDir).projects.length === 1,
		"fix registered the orphan",
	);
});

test("cli: usage errors exit 2 with usage line", async () => {
	assert.equal(await main(["projects", "rename"], deps(area)), 2);
	assert.ok(errLines.some((l) => l.startsWith("usage:")));
	assert.equal(await main(["projects", "merge", "a"], deps(area)), 2);
});

test("cli: --here launch keeps cwd", async () => {
	const root = fakeRepo(area, "stay", "git");
	const sub = root + "/sub";
	mkdirSync(sub, { recursive: true });
	// register parent first so resolution knows it
	await main([], deps(root));

	assert.equal(await main(["--here"], deps(sub)), 0);
	const last = spawnCalls[spawnCalls.length - 1]!;
	assert.equal(
		last.root,
		sub,
		"--here keeps the launch directory as session cwd",
	);
});

// --- dispatch arms, error paths, and full command flows -----------------------

test("cli: --version reads the package version (source of truth)", async () => {
	const code = await main(["--version"], deps(area));
	assert.equal(code, 0);
	const { getVersion } = await import("../src/core/version.ts");
	assert.ok(outLines.some((l) => l.trim() === `blueberry ${getVersion()}`));
});

test("cli: --version honors BLUEBERRY_VERSION (binary escape hatch)", async () => {
	const prev = process.env["BLUEBERRY_VERSION"];
	process.env["BLUEBERRY_VERSION"] = "7.7.7-bin";
	try {
		assert.equal(await main(["--version"], deps(area)), 0);
		assert.ok(outLines.some((l) => l.trim() === "blueberry 7.7.7-bin"));
	} finally {
		if (prev === undefined) delete process.env["BLUEBERRY_VERSION"];
		else process.env["BLUEBERRY_VERSION"] = prev;
	}
});

test("cli: -h short help works", async () => {
	assert.equal(await main(["-h"], deps(area)), 0);
});

test("cli: launch error surfaces message and exit 1", async () => {
	const code = await main(["--project", "ghost"], deps(area));
	assert.equal(code, 1);
	assert.ok(errLines.some((l) => l.includes("no project 'ghost'")));
});

test("cli: projects error paths", async () => {
	assert.equal(
		await main(["projects", "rename", "missing", "x"], deps(area)),
		1,
	);
	assert.ok(errLines.some((l) => l.includes("no project with slug 'missing'")));
	assert.equal(
		await main(["projects", "merge", "a", "--into", "b"], deps(area)),
		1,
	);
	assert.equal(await main(["projects", "forget", "nope"], deps(area)), 1);
	assert.equal(
		await main(["projects", "nest", "a", "--into", "missing"], deps(area)),
		1,
	);
	assert.equal(await main(["projects", "unnest", "missing"], deps(area)), 1);
	assert.equal(
		await main(["projects", "sessions", "central", "missing"], deps(area)),
		1,
	);
	assert.equal(
		await main(["projects", "sessions", "badmode", "x"], deps(area)),
		2,
	);
	assert.equal(await main(["projects", "sessions"], deps(area)), 2);
	assert.equal(await main(["projects", "wat"], deps(area)), 2);
});

test("cli: projects sessions toggles modes", async () => {
	const root = fakeRepo(area, "modes", "git");
	await main([], deps(root));
	assert.equal(
		await main(["projects", "sessions", "repo", "modes"], deps(area)),
		0,
	);
	assert.ok(outLines.some((l) => l.includes("live in the repo")));
	assert.equal(
		await main(["projects", "sessions", "central", "modes"], deps(area)),
		0,
	);
	assert.ok(outLines.some((l) => l.includes("centralized")));
});

test("cli: projects merge moves sessions end to end", async () => {
	const rootA = fakeRepo(area, "ma", "git");
	const rootB = fakeRepo(area, "mb", "git");
	await main([], deps(rootA));
	await main([], deps(rootB));
	fakeSession(getCentralStoreDir(agentDir, "ma"), { cwd: rootA });

	assert.equal(
		await main(["projects", "merge", "ma", "--into", "mb"], deps(area)),
		0,
	);
	assert.ok(outLines.some((l) => l.includes("merged 'ma' into 'mb'")));
	assert.equal(readdirSync(getCentralStoreDir(agentDir, "mb")).length, 1);
});

test("cli: sessions error paths and usage", async () => {
	const root = fakeRepo(area, "errs", "git");
	await main([], deps(root));

	assert.equal(await main(["sessions", "rename", "99", "x"], deps(root)), 1);
	assert.ok(errLines.some((l) => l.includes("no session matching '99'")));
	assert.equal(await main(["sessions", "move", "99", "nowhere"], deps(root)), 1);
	assert.equal(
		await main(["sessions", "move", "1", "no-such-project"], deps(root)),
		1,
	);
	assert.equal(await main(["sessions", "open", "99"], deps(root)), 1);
	assert.equal(await main(["sessions", "trash", "99"], deps(root)), 1);
	assert.equal(await main(["sessions", "rename"], deps(root)), 2);
	assert.equal(await main(["sessions", "wat"], deps(root)), 2);
});

test("cli: sessions list --all prints across projects", async () => {
	const rootA = fakeRepo(area, "all-a", "git");
	const rootB = fakeRepo(area, "all-b", "git");
	await main([], deps(rootA));
	await main([], deps(rootB));
	fakeSession(getCentralStoreDir(agentDir, "all-a"), {
		cwd: rootA,
		firstUserText: "in a",
	});
	fakeSession(getCentralStoreDir(agentDir, "all-b"), {
		cwd: rootB,
		firstUserText: "in b",
	});

	assert.equal(await main(["sessions", "list", "--all"], deps(area)), 0);
	assert.ok(outLines.some((l) => l.includes("in a")));
	assert.ok(outLines.some((l) => l.includes("in b")));
});

test("cli: sessions list empty project message", async () => {
	const root = fakeRepo(area, "empty-list", "git");
	await main([], deps(root));
	assert.equal(await main(["sessions", "list"], deps(root)), 0);
	assert.ok(
		outLines.some((l) => l.includes("no sessions for 'empty-list' yet")),
	);
});

test("cli: fix and doctor via dispatch with --dry-run flag", async () => {
	const root = fakeRepo(area, "dispatch", "git");
	fakeSession(getCentralStoreDir(agentDir, "dispatch"), { cwd: root });

	assert.equal(await main(["fix", "--dry-run"], deps(area)), 0);
	assert.ok(outLines.some((l) => l.includes("would register")));
	assert.equal(loadRegistrySync(agentDir).projects.length, 0);

	assert.equal(await main(["fix"], deps(area)), 0);
	assert.equal(loadRegistrySync(agentDir).projects.length, 1);
});

test("cli: adopt with unresolvable dir reports skip", async () => {
	const bad = `${area}/--nope--dir--`;
	mkdirSync(bad, { recursive: true });
	fakeSession(bad, { cwd: "" });

	assert.equal(await main(["adopt", area], deps(area)), 0);
	assert.ok(outLines.some((l) => l.includes("skipped")));
});

test("cli: adopt on a file (not dir) errors cleanly", async () => {
	const notADir = `${area}/notadir`;
	writeFileSync(notADir, "x\n");
	assert.equal(await main(["adopt", notADir], deps(area)), 1);
	assert.ok(errLines.some((l) => l.includes("blueberry:")));
});

test("cli: fix errors cleanly when a store path is a file", async () => {
	mkdirSync(`${agentDir}/sessions`, { recursive: true });
	writeFileSync(`${agentDir}/sessions/blocked`, "not a dir\n");
	assert.equal(await main(["fix"], deps(area)), 1);
	assert.ok(errLines.some((l) => l.includes("blueberry:")));
});

test("cli: defaultDeps wires process io and actually invokes them", () => {
	const d = defaultDeps();
	assert.equal(typeof d.cwd, "string");
	assert.equal(typeof d.runPi, "function");
	// exercise the io arrows (stdout/stderr writes)
	d.out("blueberry-io-probe");
	d.err("blueberry-io-probe");
});

test("cli: projects list --json and empty-registry message", async () => {
	assert.equal(await main(["projects", "list"], deps(area)), 0);
	assert.ok(outLines.some((l) => l.includes("no projects registered")));

	const root = fakeRepo(area, "listed", "git");
	await main([], deps(root));
	assert.equal(await main(["projects", "list", "--json"], deps(area)), 0);
	const parsed = JSON.parse(outLines[outLines.length - 1]!) as Array<{
		slug: string;
	}>;
	assert.ok(parsed.some((p) => p.slug === "listed"));
});

test("cli: sessions show/search/fork — cross-project access", async () => {
	const rootA = fakeRepo(area, "lib-a", "git");
	const rootB = fakeRepo(area, "lib-b", "git");
	await main([], deps(rootA));
	await main([], deps(rootB));
	fakeSession(getCentralStoreDir(agentDir, "lib-a"), {
		cwd: rootA,
		name: "cross-session",
		firstUserText: "the needle lives here",
	});

	// show summary by address from the OTHER project's cwd
	assert.equal(
		await main(["sessions", "show", "lib-a/cross-session"], deps(rootB)),
		0,
	);
	assert.ok(outLines.some((l) => l.includes("cross-session")));

	// messages view with tool lines via address
	assert.equal(
		await main(
			["sessions", "show", "lib-a/cross-session", "--view", "messages"],
			deps(rootB),
		),
		0,
	);
	assert.ok(outLines.some((l) => l.includes("the needle lives here")));

	// bare selector = current project
	assert.equal(
		await main(["sessions", "show", "cross-session"], deps(rootA)),
		0,
	);

	// errors
	assert.equal(await main(["sessions", "show", "ghost/1"], deps(rootA)), 1);
	assert.ok(errLines.some((l) => l.includes("no project 'ghost'")));
	assert.equal(await main(["sessions", "show", "lib-a/999"], deps(rootB)), 1);
	assert.equal(
		await main(["sessions", "show", "lib-a/1", "--view", "bogus"], deps(rootB)),
		2,
	);
	assert.equal(await main(["sessions", "show"], deps(rootB)), 2);
	assert.equal(
		await main(["sessions", "show", "lib-a/1", "--view", "message"], deps(rootB)),
		2,
	);
	assert.equal(
		await main(
			["sessions", "show", "lib-a/1", "--view", "message", "--message", "abc"],
			deps(rootB),
		),
		2,
		"non-numeric message rejected",
	);

	// search: scoped and --all
	assert.equal(await main(["sessions", "search", "needle"], deps(rootB)), 0);
	assert.ok(
		outLines.some((l) => l.includes("no matches")),
		"current project has no needle",
	);
	assert.equal(
		await main(["sessions", "search", "needle", "--all"], deps(rootB)),
		0,
	);
	assert.ok(outLines.some((l) => l.includes("lib-a/")));
	assert.equal(await main(["sessions", "search"], deps(rootB)), 2);

	// fork from B's cwd: copies lib-a session into lib-b's store
	assert.equal(
		await main(["sessions", "fork", "lib-a/cross-session"], deps(rootB)),
		0,
	);
	assert.ok(outLines.some((l) => l.includes("cross-session@lib-a")));
	const forked = listSessions(getCentralStoreDir(agentDir, "lib-b"));
	assert.equal(forked.length, 1);
	assert.equal(forked[0]?.name, "cross-session@lib-a");
	assert.equal(forked[0]?.cwd, rootB, "fork header rewritten to target cwd");
	// source intact in lib-a
	assert.equal(listSessions(getCentralStoreDir(agentDir, "lib-a")).length, 1);
	assert.equal(await main(["sessions", "fork"], deps(rootB)), 2);
});

test("cli: sessions list marks sessions without a header cwd", async () => {
	const root = fakeRepo(area, "nocwd", "git");
	await main([], deps(root));
	fakeSession(getCentralStoreDir(agentDir, "nocwd"), { cwd: "" });

	assert.equal(await main(["sessions", "list"], deps(root)), 0);
	assert.ok(outLines.some((l) => l.includes("[no cwd]")));
});

test("cli: adopt --map flag form stamps and imports", async () => {
	const root = fakeRepo(area, "mappedflag", "git");
	const dirName = "--opaque--dir--";
	mkdirSync(`${area}/${dirName}`, { recursive: true });
	fakeSession(`${area}/${dirName}`, { cwd: "" });

	assert.equal(
		await main(["adopt", area, "--map", `${dirName}=${root}`], deps(area)),
		0,
	);
	assert.ok(outLines.some((l) => l.includes("stamped 1")));
	assert.ok(outLines.some((l) => l.includes("mappedflag")));
});

test("cli: adopt on empty source reports nothing to adopt", async () => {
	const empty = `${area}/empty-src`;
	mkdirSync(empty, { recursive: true });
	assert.equal(await main(["adopt", empty], deps(area)), 0);
	assert.ok(outLines.some((l) => l.includes("nothing to adopt")));
});

test("cli: doctor on clean state reports all clear", async () => {
	assert.equal(await main(["doctor"], deps(area)), 0);
	assert.ok(outLines.some((l) => l.includes("all clear")));
});
