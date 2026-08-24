import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import {
	parseAddress,
	resolveAddress,
	parseSessionFile,
	renderSummary,
	renderTree,
	renderMessages,
	renderMessage,
	numberMessages,
	searchSessions,
	formatSearchHits,
	forkSession,
	capHead,
	capTail,
} from "../src/core/library.ts";
import { loadRegistry, mutations, findBySlug } from "../src/core/registry.ts";
import { getCentralStoreDir } from "../src/core/agent-dir.ts";
import { listSessions, readSessionHeader } from "../src/core/sessions.ts";
import { tmpAgentDir, tmpDir, fakeRepo, fakeSession, cleanup } from "./helpers.ts";

let agentDir: string;
let area: string;

beforeEach(() => {
	agentDir = tmpAgentDir();
	area = tmpDir("bb-lib-");
});
afterEach(() => {
	cleanup(agentDir, area);
});

/** Register a project with a session and return {root, store, file}. */
function setupProject(name: string, opts?: { sessionName?: string; firstText?: string }) {
	const root = fakeRepo(area, name, "git");
	const registry = loadRegistry(agentDir);
	mutations.register(registry, { root });
	const store = getCentralStoreDir(agentDir, name);
	const spec: Parameters<typeof fakeSession>[1] = {
		cwd: root,
		firstUserText: opts?.firstText ?? "hello world",
		entries: 2,
	};
	if (opts?.sessionName !== undefined) spec.name = opts.sessionName;
	const file = fakeSession(store, spec);
	return { root, store, file, registry };
}

// --- addressing ---------------------------------------------------------------

test("parseAddress: bare, project-scoped, multi-slash selector", () => {
	assert.deepEqual(parseAddress("3"), { selector: "3" });
	assert.deepEqual(parseAddress("webmail/3"), { project: "webmail", selector: "3" });
	assert.deepEqual(parseAddress("webmail/my/name"), { project: "webmail", selector: "my/name" });
	assert.throws(() => parseAddress("/leading"), /invalid address/);
	assert.throws(() => parseAddress("proj/"), /invalid address/);
});

test("resolveAddress: index, name, uuid prefix, bare=current, errors", () => {
	const { root, registry } = setupProject("alpha", { sessionName: "the-one" });
	const file2 = fakeSession(getCentralStoreDir(agentDir, "alpha"), { cwd: root, firstUserText: "second" });
	const id2 = readSessionHeader(file2)!.id;

	// index (2 = second newest via mtime ordering; both created same ms -> force order)
	// use names and ids which are deterministic instead:
	const byName = resolveAddress(registry, agentDir, "alpha", "alpha/the-one");
	assert.equal(byName.session.name, "the-one");
	const byPrefix = resolveAddress(registry, agentDir, "alpha", `alpha/${id2.slice(0, 8)}`);
	assert.equal(byPrefix.session.id, id2);
	// bare selector = current project
	const bare = resolveAddress(registry, agentDir, "alpha", "the-one");
	assert.equal(bare.session.name, "the-one");

	assert.throws(() => resolveAddress(registry, agentDir, "alpha", "alpha/9999"), /out of range/);
	assert.throws(() => resolveAddress(registry, agentDir, "ghost", "ghost/1"), /no project 'ghost'.*known: alpha/);
	assert.throws(() => resolveAddress(registry, agentDir, "alpha", "alpha/nope"), /no session matching/);
	assert.throws(() => resolveAddress(registry, agentDir, "alpha", "alpha/"), /invalid address/);
});

test("resolveAddress: ambiguous name refuses and lists candidates", () => {
	const { root, registry } = setupProject("dupes", { sessionName: "same" });
	fakeSession(getCentralStoreDir(agentDir, "dupes"), { cwd: root, name: "same", firstUserText: "second copy" });
	assert.throws(() => resolveAddress(registry, agentDir, "dupes", "dupes/same"), /ambiguous name 'same'/);
});

// --- views ----------------------------------------------------------------------

/** Write a rich hand-crafted session for view tests. */
function richSession(store: string, name: string): string {
	mkdirSync(store, { recursive: true });
	const file = `${store}/rich.jsonl`;
	const ts = new Date().toISOString();
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "rich-id-0001", timestamp: ts, cwd: "/x/rich" }),
		JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: ts, message: { role: "user", content: "run the tests please", timestamp: 1 } }),
		JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: ts, message: { role: "assistant", content: [
			{ type: "thinking", thinking: "secret internal reasoning" },
			{ type: "text", text: "Running them now." },
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } },
		], provider: "p", model: "m", usage: null, stopReason: "toolUse", timestamp: 2 } }),
		JSON.stringify({ type: "message", id: "m3", parentId: "m2", timestamp: ts, message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "all tests passed\nok" }], isError: false, timestamp: 3 } }),
		JSON.stringify({ type: "message", id: "m4", parentId: "m3", timestamp: ts, message: { role: "bashExecution", command: "echo hi", output: "hi", exitCode: 0, cancelled: false, truncated: false, timestamp: 4 } }),
		JSON.stringify({ type: "message", id: "m5", parentId: "m4", timestamp: ts, message: { role: "bashExecution", command: "secret", output: "", excludeFromContext: true, timestamp: 5 } }),
		JSON.stringify({ type: "model_change", id: "c1", parentId: "m5", timestamp: ts, provider: "zai", modelId: "glm-5.3" }),
		JSON.stringify({ type: "label", id: "l1", parentId: "c1", timestamp: ts, targetId: "m1", label: "start" }),
		JSON.stringify({ type: "session_info", id: "s1", parentId: "l1", timestamp: ts, name }),
		JSON.stringify({ type: "message", id: "m6", parentId: "m5", timestamp: ts, message: { role: "user", content: "branch point test", timestamp: 6 } }),
	].join("\n") + "\n";
	writeFileSync(file, lines);
	return file;
}

test("parseSessionFile: header + entries, malformed skipped", () => {
	const store = getCentralStoreDir(agentDir, "views");
	const file = richSession(store, "rich-session");
	const parsed = parseSessionFile(file)!;
	assert.equal(parsed.entries.length, 9); // 6 messages + model_change + label + session_info
	assert.equal(parsed.header["id"], "rich-id-0001");

	// malformed line tolerated: append garbage and re-parse
	const orig = readFileSync(file, "utf8");
	writeFileSync(file, `${orig}{ this is not json\n`);
	const reparsed = parseSessionFile(file)!;
	assert.equal(reparsed.entries.length, 9, "garbage line skipped");

	// garbage header -> null
	writeFileSync(`${store}/bad.jsonl`, "not json\n");
	assert.equal(parseSessionFile(`${store}/bad.jsonl`), null);
});

test("renderSummary: name, ids, models, counts", () => {
	const store = getCentralStoreDir(agentDir, "views");
	const file = richSession(store, "rich-session");
	const session = listSessions(store).find((s) => s.file === file)!;
	const parsed = parseSessionFile(file)!;
	const text = renderSummary(session, parsed);
	assert.ok(text.includes("rich-session"));
	assert.ok(text.includes("rich-id-0001"));
	assert.ok(text.includes("zai/glm-5.3"));
	assert.ok(text.includes("run the tests please"));
	assert.ok(text.includes("labels: 1"));
});

test("renderTree: structure, branch point, all entry kinds", () => {
	const store = getCentralStoreDir(agentDir, "views");
	const file = richSession(store, "rich-session");
	const text = renderTree(parseSessionFile(file)!);
	assert.ok(text.includes("[user] run the tests please"));
	assert.ok(text.includes("[toolResult] bash"));
	assert.ok(text.includes("[bash] echo hi"));
	assert.ok(text.includes("[model] zai/glm-5.3"));
	assert.ok(text.includes("[label] start"));
	assert.ok(text.includes("┄ branch point"), "m5 has two children");
});

test("renderMessages: numbering, verbatim text, tool lines, !! omitted", () => {
	const store = getCentralStoreDir(agentDir, "views");
	const file = richSession(store, "rich-session");
	const parsed = parseSessionFile(file)!;
	const text = renderMessages(parsed, 0, 100);

	assert.ok(text.includes("#1 user"));
	assert.ok(text.includes("run the tests please"));
	assert.ok(text.includes("Running them now."));
	assert.ok(!text.includes("secret internal reasoning"), "thinking omitted in messages view");
	assert.ok(text.includes("· tool bash"), "tool call one-liner");
	assert.ok(text.includes("toolResult bash → ok"), "tool result one-liner");
	assert.ok(text.includes("$ echo hi"), "visible bash included");
	assert.ok(!text.includes("secret"), "!! bash command omitted");
	assert.ok(text.includes("of 5 total"), "5 numbered messages (m5 excluded)");

	// pagination: #5 is the post-branch user message
	const page = renderMessages(parsed, 4, 2);
	assert.ok(page.includes("#5"));
	assert.ok(!page.includes("#1 user"));
});

test("renderMessage: full drill-down including thinking and tool args", () => {
	const store = getCentralStoreDir(agentDir, "views");
	const file = richSession(store, "rich-session");
	const parsed = parseSessionFile(file)!;

	const assistant = renderMessage(parsed, 2);
	assert.ok(assistant.includes("secret internal reasoning"), "thinking VISIBLE in message view");
	assert.ok(assistant.includes('"command": "npm test"'), "full tool arguments");

	const result = renderMessage(parsed, 3);
	assert.ok(result.includes("all tests passed"));

	const bash = renderMessage(parsed, 4);
	assert.ok(bash.includes("$ echo hi"));
	assert.ok(bash.includes("exit 0"));

	assert.throws(() => renderMessage(parsed, 99), /range 1\.\.5/);
});

test("numberMessages: !! excluded from numbering", () => {
	const store = getCentralStoreDir(agentDir, "views");
	const file = richSession(store, "rich-session");
	const numbered = numberMessages(parseSessionFile(file)!);
	assert.equal(numbered.length, 5);
});

// --- budgets ----------------------------------------------------------------------

test("capHead/capTail: line and byte budgets", () => {
	const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
	const head = capHead(big, 50_000, 100);
	assert.equal(head.shownLines, 100);
	assert.ok(head.truncated);
	const tail = capTail(big, 50_000, 100);
	assert.ok(tail.text.includes("line 2999"));
	const byteCapped = capTail("x".repeat(60_000), 1000, 2000);
	assert.ok(byteCapped.text.length <= 1000);
	assert.ok(byteCapped.truncated);
	const small = capHead("ok");
	assert.ok(!small.truncated);
});

test("renderMessages truncates huge sessions with notice", () => {
	const store = getCentralStoreDir(agentDir, "big");
	mkdirSync(store, { recursive: true });
	const file = `${store}/big.jsonl`;
	const ts = new Date().toISOString();
	const lines = [JSON.stringify({ type: "session", version: 3, id: "big-id", timestamp: ts, cwd: "/x" })];
	for (let i = 0; i < 400; i++) {
		lines.push(JSON.stringify({ type: "message", id: `e${i}`, parentId: `e${i - 1}`, timestamp: ts, message: { role: "user", content: `message ${i} ` + "x".repeat(400), timestamp: i } }));
	}
	writeFileSync(file, lines.join("\n") + "\n");
	const text = renderMessages(parseSessionFile(file)!, 0, 400);
	assert.ok(text.includes("[truncated"), "byte budget notice present");
});

// --- search -----------------------------------------------------------------------

test("searchSessions: current-only and --all scopes", () => {
	const a = setupProject("findable-a", { sessionName: "needle-here", firstText: "nothing special" });
	// register the second project into the SAME registry object (nothing persists between loads)
	const bRoot = fakeRepo(area, "findable-b", "git");
	mutations.register(a.registry, { root: bRoot });
	fakeSession(getCentralStoreDir(agentDir, "findable-b"), { cwd: bRoot, firstUserText: "the needle is in this text" });

	const currentOnly = searchSessions(a.registry, agentDir, "needle", { all: false, currentSlug: "findable-a" });
	assert.ok(currentOnly.length >= 1, "name hit in current project");
	assert.ok(currentOnly.every((h) => h.project === "findable-a"));

	const all = searchSessions(a.registry, agentDir, "needle", { all: true, currentSlug: "findable-b" });
	assert.ok(all.some((h) => h.project === "findable-a"));
	assert.ok(all.some((h) => h.project === "findable-b"));

	const none = searchSessions(a.registry, agentDir, "zzz-no-such-thing", { all: true, currentSlug: "findable-a" });
	assert.equal(none.length, 0);
	assert.equal(formatSearchHits(none), "no matches");

	const formatted = formatSearchHits(all);
	assert.ok(formatted.includes("findable-a/"));
});

test("searchSessions: case-insensitive with snippet context", () => {
	const r = setupProject("caseproj", { firstText: "The NEEDLE was found" }).registry;
	const hits = searchSessions(r, agentDir, "needle", { all: true, currentSlug: "caseproj" });
	assert.ok(hits.length >= 1);
	assert.ok(hits[0]!.snippet.toLowerCase().includes("needle"));
});

// --- fork -------------------------------------------------------------------------

test("forkSession: copies into target store, names name@project, source intact", () => {
	const src = setupProject("src-proj", { sessionName: "the-plan" });
	const dstRoot = fakeRepo(area, "dst-proj", "git");
	mutations.register(src.registry, { root: dstRoot });
	const dst = findBySlug(src.registry, "dst-proj")!;

	const session = listSessions(getCentralStoreDir(agentDir, "src-proj"))[0]!;
	const result = forkSession({
		agentDir,
		sourceFile: session.file,
		sourceProject: findBySlug(src.registry, "src-proj")!,
		sourceSession: session,
		targetProject: dst,
	});

	// landed in dst store with rewritten cwd and new name
	assert.ok(result.file.startsWith(getCentralStoreDir(agentDir, "dst-proj")));
	assert.equal(readSessionHeader(result.file)?.cwd, dstRoot);
	assert.equal(result.name, "the-plan@src-proj");
	const landed = listSessions(getCentralStoreDir(agentDir, "dst-proj"));
	assert.equal(landed.length, 1);
	assert.equal(landed[0]?.name, "the-plan@src-proj");

	// source untouched
	assert.equal(listSessions(getCentralStoreDir(agentDir, "src-proj")).length, 1);
	// parentSession cleared (would dangle across stores)
	assert.equal(readSessionHeader(result.file)?.parentSession, undefined);
});

test("forkSession: unnamed session derives name from first text; slashes stripped", () => {
	const src = setupProject("src2", { firstText: "fix the parser bug / quickly" });
	const dstRoot = fakeRepo(area, "dst2", "git");
	mutations.register(src.registry, { root: dstRoot });
	const dst = findBySlug(src.registry, "dst2")!;

	const session = listSessions(getCentralStoreDir(agentDir, "src2"))[0]!;
	const result = forkSession({
		agentDir,
		sourceFile: session.file,
		sourceProject: findBySlug(src.registry, "src2")!,
		sourceSession: session,
		targetProject: dst,
	});
	assert.ok(result.name.startsWith("fix the parser bug - quickly".slice(0, 20)));
	assert.ok(result.name.endsWith("@src2"));
	assert.ok(!result.name.includes("/"));
});

test("forkSession: same-store fork collides safely (suffixed copy, source intact)", () => {
	const src = setupProject("self-fork", { sessionName: "original" });
	const project = findBySlug(src.registry, "self-fork")!;
	const session = listSessions(getCentralStoreDir(agentDir, "self-fork"))[0]!;

	const result = forkSession({
		agentDir,
		sourceFile: session.file,
		sourceProject: project,
		sourceSession: session,
		targetProject: project,
	});

	assert.notEqual(result.file, session.file, "fork is a distinct file");
	const files = readdirSync(getCentralStoreDir(agentDir, "self-fork"));
	assert.equal(files.length, 2, "source + forked copy");
	const forked = listSessions(getCentralStoreDir(agentDir, "self-fork")).find((s) => s.file === result.file)!;
	assert.equal(forked.name, "original@self-fork");
});

// --- branch-coverage batch: exotic roles, catch paths, edge branches --------------

/** Session containing every exotic message role the renderers know. */
function exoticSession(store: string): string {
	mkdirSync(store, { recursive: true });
	const file = `${store}/exotic.jsonl`;
	const ts = new Date().toISOString();
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "exotic-id-01", timestamp: ts, cwd: "/x" }),
		JSON.stringify({ type: "message", id: "x1", parentId: null, timestamp: ts, message: { role: "custom", customType: "my-ext", content: "injected context", display: true, timestamp: 1 } }),
		JSON.stringify({ type: "message", id: "x2", parentId: "x1", timestamp: ts, message: { role: "branchSummary", summary: "the abandoned path explored X", fromId: "x1", timestamp: 2 } }),
		JSON.stringify({ type: "message", id: "x3", parentId: "x2", timestamp: ts, message: { role: "compactionSummary", summary: "early talk about Y", tokensBefore: 5000, timestamp: 3 } }),
		JSON.stringify({ type: "message", id: "x4", parentId: "x3", timestamp: ts, message: { role: "mystery", weird: true, timestamp: 4 } }),
		JSON.stringify({ type: "message", id: "x5", parentId: "x4", timestamp: ts, message: { role: "user", content: [{ type: "text", text: "q" }], timestamp: 5, usage: { input: 1, output: 1 } } }),
	].join("\n") + "\n";
	writeFileSync(file, lines);
	return file;
}

test("renderMessages: exotic roles render one-liners, default role falls through", () => {
	const store = getCentralStoreDir(agentDir, "exotic");
	const file = exoticSession(store);
	const text = renderMessages(parseSessionFile(file)!, 0, 20);
	assert.ok(text.includes("#1 custom my-ext"));
	assert.ok(text.includes("injected context"));
	assert.ok(text.includes("#2 branch summary"));
	assert.ok(text.includes("the abandoned path"));
	assert.ok(text.includes("#3 compaction summary"));
	assert.ok(text.includes("#4 mystery"), "unknown role falls to default line");
});

test("renderMessage: exotic roles dump JSON, metadata and usage included", () => {
	const store = getCentralStoreDir(agentDir, "exotic");
	const file = exoticSession(store);
	const parsed = parseSessionFile(file)!;
	const custom = renderMessage(parsed, 1);
	assert.ok(custom.includes("customType: my-ext"));
	const branch = renderMessage(parsed, 2);
	assert.ok(branch.includes("from: x1"));
	const compaction = renderMessage(parsed, 3);
	assert.ok(compaction.includes("tokensBefore: 5000"));
	const user = renderMessage(parsed, 5);
	assert.ok(user.includes("--- usage ---"), "usage block dumped for generic roles");
});

test("renderSummary: bare session shows fallback labels", () => {
	const store = getCentralStoreDir(agentDir, "bare");
	// no user message (firstUserText null), no name, header without cwd
	mkdirSync(store, { recursive: true });
	const file = `${store}/bare.jsonl`;
	const ts = new Date().toISOString();
	writeFileSync(file, [
		JSON.stringify({ type: "session", version: 3, id: "bare-id-0001", timestamp: ts }),
		JSON.stringify({ type: "message", id: "b1", parentId: null, timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "just an assistant" }], usage: null, stopReason: "stop", timestamp: 1 } }),
	].join("\n") + "\n");
	const session = listSessions(store)[0]!;
	const text = renderSummary(session, parseSessionFile(file)!);
	assert.ok(text.includes("(unnamed)"));
	assert.ok(text.includes("(none)"), "no first message -> (none)");
});

test("parseSessionFile: unreadable body returns null", () => {
	const store = getCentralStoreDir(agentDir, "unreadable");
	const file = fakeSession(store, { cwd: "/x" });
	chmodSync(file, 0o000);
	assert.equal(parseSessionFile(file), null);
	chmodSync(file, 0o644);
});

test("renderSummary: no model changes shows header-only note", () => {
	const store = getCentralStoreDir(agentDir, "plain");
	const file = fakeSession(store, { cwd: "/x", firstUserText: "plain session" });
	const session = listSessions(store)[0]!;
	const text = renderSummary(session, parseSessionFile(file)!);
	assert.ok(text.includes("(header only)"));
});

test("resolveAddress: exact uuid wins, short prefixes skip to name", () => {
	const { root, registry } = setupProject("uuids", { sessionName: "named" });
	const file2 = fakeSession(getCentralStoreDir(agentDir, "uuids"), { cwd: root, firstUserText: "second" });
	const id2 = readSessionHeader(file2)!.id;
	const byExact = resolveAddress(registry, agentDir, "uuids", `uuids/${id2}`);
	assert.equal(byExact.session.id, id2);
	// 3-char selector: below uuid-prefix length, falls through to name match
	assert.throws(() => resolveAddress(registry, agentDir, "uuids", "nam"), /no session matching 'nam'/);
});

test("renderTree + renderMessage: kitchen-sink fixture covers fallback branches", () => {
	const store = getCentralStoreDir(agentDir, "kitchen");
	mkdirSync(store, { recursive: true });
	const file = `${store}/kitchen.jsonl`;
	const ts = new Date().toISOString();
	writeFileSync(file, [
		JSON.stringify({ type: "session", version: 3, id: "kitchen-id", timestamp: ts, cwd: "/x" }),
		JSON.stringify({ type: "message", id: "k1", parentId: null, timestamp: ts, message: { role: "user", timestamp: 1 } }), // content undefined -> textOf "" branch
		JSON.stringify({ type: "message", id: "k2", parentId: "k1", timestamp: ts, message: { role: "toolResult", content: [{ type: "image", data: "zz" }], isError: true, timestamp: 2 } }), // no toolName, image block
		JSON.stringify({ type: "message", id: "k3", parentId: "k2", timestamp: ts, message: { role: "bashExecution", timestamp: 3 } }), // no command
		JSON.stringify({ type: "compaction", id: "k4", parentId: "k3", timestamp: ts }), // no tokensBefore
		JSON.stringify({ type: "branch_summary", id: "k5", parentId: "k4", timestamp: ts }), // no fromId
		JSON.stringify({ type: "future_thing", id: "k6", parentId: "k5", timestamp: ts, payload: 1 }), // unknown entry type
	].join("\n") + "\n");
	const parsed = parseSessionFile(file)!;

	const tree = renderTree(parsed);
	assert.ok(tree.includes("[user]"));
	assert.ok(tree.includes("[toolResult] ?"), "missing toolName falls back");
	assert.ok(tree.includes("[bash]"), "missing command falls back");
	assert.ok(tree.includes("[compaction] ? tokens before"));
	assert.ok(tree.includes("[branch summary] from ?"));
	assert.ok(tree.includes("[future_thing]"), "unknown entry type rendered");

	// toolResult with image block and no details
	const tr = renderMessage(parsed, 2);
	assert.ok(tr.includes("[image"));
	assert.ok(tr.includes("isError: true"));
	// tree over the exotic fixture: unknown MESSAGE role + thinking_level_change entry
	const exoticStore = getCentralStoreDir(agentDir, "exotic2");
	mkdirSync(exoticStore, { recursive: true });
	const exotic2 = `${exoticStore}/exotic2.jsonl`;
	writeFileSync(exotic2, [
		JSON.stringify({ type: "session", version: 3, id: "ex2", timestamp: ts, cwd: "/x" }),
		JSON.stringify({ type: "message", id: "y1", parentId: null, timestamp: ts, message: { role: "mystery", timestamp: 1 } }),
		JSON.stringify({ type: "thinking_level_change", id: "y2", parentId: "y1", timestamp: ts, thinkingLevel: "high" }),
		JSON.stringify({ type: "message", id: "y3", parentId: "y2", timestamp: ts, message: { role: "toolResult", content: "plain string result", isError: false, timestamp: 2 } }),
	].join("\n") + "\n");
	const exoticParsed = parseSessionFile(exotic2)!;
	const exoticTree = renderTree(exoticParsed);
	assert.ok(exoticTree.includes("[mystery] (y1)"), "unknown message role in tree");
	assert.ok(exoticTree.includes("[thinking] high"));
	// string (non-array) toolResult content: contentBlocks returns []
	const stringResult = renderMessage(exoticParsed, 2);
	assert.ok(stringResult.includes("tool: undefined") || stringResult.includes("tool:"), "string content tolerated");
});

test("renderMessage: toolResult details block is fully inspectable", () => {
	const store = getCentralStoreDir(agentDir, "details");
	mkdirSync(store, { recursive: true });
	const file = `${store}/details.jsonl`;
	const ts = new Date().toISOString();
	writeFileSync(file, [
		JSON.stringify({ type: "session", version: 3, id: "det-id", timestamp: ts, cwd: "/x" }),
		JSON.stringify({ type: "message", id: "d1", parentId: null, timestamp: ts, message: { role: "toolResult", toolName: "t", content: [{ type: "text", text: "r" }], isError: false, details: { hidden: true }, timestamp: 1 } }),
	].join("\n") + "\n");
	const withDetails = renderMessage(parseSessionFile(file)!, 1);
	assert.ok(withDetails.includes("--- details ---"));
	assert.ok(withDetails.includes('"hidden": true'));
});

test("branch sweep: degenerate entries, empty results, truncation, fork fallbacks", () => {
	const store = getCentralStoreDir(agentDir, "sweep");
	mkdirSync(store, { recursive: true });
	const ts = new Date().toISOString();
	const header = JSON.stringify({ type: "session", version: 3, id: "sweep-id", timestamp: ts, cwd: "/x" });

	// 1. empty registry resolveAddress -> "known: none"
	const emptyReg2 = { version: 1 as const, projects: [] };
	assert.throws(() => resolveAddress(emptyReg2, agentDir, "nowhere", "nowhere/1"), /known: none/);

	// 2. degenerate entries: no message field, no id, tool-calls-only assistant, image in assistant
	const file = `${store}/degen.jsonl`;
	writeFileSync(file, [
		header,
		JSON.stringify({ type: "message", id: "g1", parentId: null, timestamp: ts }), // no message field
		JSON.stringify({ type: "weird", parentId: "g1", timestamp: ts }), // no id
		JSON.stringify({ type: "message", id: "g2", parentId: "g1", timestamp: ts, message: { role: "assistant", content: [
			{ type: "image", data: "zz", mimeType: "image/png" },
			{ type: "toolCall", id: 42, name: "t", arguments: {} }, // non-string id
		], timestamp: 1 } }),
	].join("\n") + "\n");
	const parsed = parseSessionFile(file)!;
	const tree = renderTree(parsed);
	assert.ok(tree.includes("[?] (g1)"), "message-less entry: role '?' id shown");
	const msgs = renderMessages(parsed, 0, 10);
	assert.ok(msgs.includes("(tool calls only)"), "assistant with no text block");
	assert.ok(msgs.includes("tool t (?)"), "non-string toolCall id falls back");
	const drill = renderMessage(parsed, 1);
	assert.ok(drill.includes("[image image/png]"), "image block in assistant drill-down");

	// 3. offset beyond end -> "none" range header + no-messages body
	const beyond = renderMessages(parsed, 99, 5);
	assert.ok(beyond.includes("[messages none of"));
	assert.ok(beyond.includes("(no messages in range)"));

	// 4. header-only session: empty tree
	const only = `${store}/only.jsonl`;
	writeFileSync(only, `${header}\n`);
	assert.ok(renderTree(parseSessionFile(only)!).includes("(empty)"));

	// 5. tree truncation past 2000 entries
	const bigLines = [header];
	for (let i = 0; i < 2100; i++) {
		bigLines.push(JSON.stringify({ type: "message", id: `t${i}`, parentId: i === 0 ? null : `t${i - 1}`, timestamp: ts, message: { role: "user", content: `m${i}`, timestamp: i } }));
	}
	const bigFile = `${store}/bigtree.jsonl`;
	writeFileSync(bigFile, bigLines.join("\n") + "\n");
	assert.ok(renderTree(parseSessionFile(bigFile)!).includes("[tree truncated]"));

	// 6. search: custom role content + needle deep in text + truncated hit list
	const deepStore = getCentralStoreDir(agentDir, "deep");
	mkdirSync(deepStore, { recursive: true });
	const deepLines = [JSON.stringify({ type: "session", version: 3, id: "deep-id", timestamp: ts, cwd: "/x" })];
	deepLines.push(JSON.stringify({ type: "message", id: "c1", parentId: null, timestamp: ts, message: { role: "custom", customType: "ext", content: "injected custom needle here", timestamp: 1 } }));
	for (let i = 0; i < 2100; i++) {
		deepLines.push(JSON.stringify({ type: "message", id: `d${i}`, parentId: `d${i - 1}`, timestamp: ts, message: { role: "user", content: `${"pad ".repeat(20)}needle number ${i}`, timestamp: i } }));
	}
	const deepFile = `${deepStore}/deep.jsonl`;
	writeFileSync(deepFile, deepLines.join("\n") + "\n");
	const deepReg = loadRegistry(agentDir);
	mutations.register(deepReg, { root: "/x/deep" }); // slug: deep — matches the store dir above
	const deepHits = searchSessions(deepReg, agentDir, "needle", { all: true, currentSlug: "deep" });
	assert.ok(deepHits.length > 2000);
	assert.ok(deepHits.some((h) => h.snippet.includes("custom") || h.messageNumber === 1), "custom-role content searched");
	const deepFormatted = formatSearchHits(deepHits);
	assert.ok(deepFormatted.includes("[truncated"));
	const deepHit = deepHits.find((h) => h.messageNumber > 1)!;
	assert.ok(deepHit.snippet.startsWith("pad"), "needle deep in text: snippet leads with padding");
});

test("forkSession: no name and no first text derives from id; empty base falls back", () => {
	const src = setupProject("sparse-src");
	// overwrite the setup session with one that has no user message: build fresh
	const store = getCentralStoreDir(agentDir, "sparse-src");
	const root = src.root;
	const file = fakeSession(store, { cwd: root, entries: 1 }); // no firstUserText, no name
	const session = listSessions(store).find((s) => s.file === file)!;
	assert.equal(session.firstUserText, null);

	const dstRoot = fakeRepo(area, "sparse-dst", "git");
	mutations.register(src.registry, { root: dstRoot });
	const dst = findBySlug(src.registry, "sparse-dst")!;
	const result = forkSession({
		agentDir,
		sourceFile: session.file,
		sourceProject: findBySlug(src.registry, "sparse-src")!,
		sourceSession: session,
		targetProject: dst,
	});
	assert.ok(result.name.endsWith("@sparse-src"));
	assert.ok(!result.name.startsWith("@"), "base derived from id, not empty");

	// slash-only name -> empty base -> "session" fallback
	const weird = fakeSession(store, { cwd: root, name: "///" });
	const weirdSession = listSessions(store).find((s) => s.file === weird)!;
	const result2 = forkSession({
		agentDir,
		sourceFile: weird,
		sourceProject: findBySlug(src.registry, "sparse-src")!,
		sourceSession: weirdSession,
		targetProject: dst,
	});
	assert.equal(result2.name, "session@sparse-src");
});

test("capHead: byte-only truncation with few lines", () => {
	const wide = `${"y".repeat(300)}\n${"z".repeat(300)}`;
	const capped = capHead(wide, 100, 2000);
	assert.ok(capped.truncated);
	assert.ok(capped.text.length <= 100);
});
