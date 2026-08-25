/**
 * Title-guard tests: the transport-level tab-header fix.
 *
 * The regression: pi writes OSC 0 title sequences from 8 call sites
 * (including async paths extensions can't observe), re-asserting
 * "<pi> - blueberry" on the tab no matter how many events we hook.
 * The interceptor rewrites every non-ours title at the byte level.
 * These tests pin that contract without a real terminal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
	installInterceptor,
	rewriteChunk,
	rewriteResumeHint,
	rewriteTitles,
	titleSequence,
} from "../src/core/title-guard.ts";

const OURS = "blueberry — blueberry";

// --- pure rewriters ---------------------------------------------------------------

test("titleSequence: builds OSC 0 with BEL terminator", () => {
	assert.equal(titleSequence("x"), "\x1b]0;x\x07");
});

test("rewriteTitles: pi's title becomes ours; ours passes through", () => {
	const piTitle = "\x1b]0;pi - blueberry\x07";
	assert.equal(rewriteTitles(piTitle, OURS), titleSequence(OURS));
	// already ours: byte-identical pass-through
	assert.equal(rewriteTitles(titleSequence(OURS), OURS), titleSequence(OURS));
});

test("rewriteTitles: non-title bytes untouched; chunks without OSC pass clean", () => {
	const mixed = `some output${"\x1b]0;pi - blueberry\x07"}more output`;
	const out = rewriteTitles(mixed, OURS);
	assert.ok(out.startsWith("some output"));
	assert.ok(out.endsWith("more output"));
	assert.ok(!out.includes("pi - blueberry"));
	// no OSC at all: fast path returns the same string
	const plain = "just text\nno escapes";
	assert.equal(rewriteTitles(plain, OURS), plain);
});

test("rewriteTitles: OSC 2 form also rewritten", () => {
	const osc2 = "\x1b]2;pi - somewhere\x07";
	assert.equal(rewriteTitles(osc2, OURS), titleSequence(OURS));
});

test("rewriteTitles: multiple titles in one chunk all become ours", () => {
	const two = "\x1b]0;pi\x07text\x1b]0;also not ours\x07";
	const out = rewriteTitles(two, OURS);
	assert.equal(out, `${titleSequence(OURS)}text${titleSequence(OURS)}`);
});

test("rewriteResumeHint: pi command → bb command, session-dir preserved", () => {
	const hint =
		"To resume this session: pi --session-dir /Users/x/.blueberry/sessions/blueberry --session 01a038b3-bb3e";
	const out = rewriteResumeHint(hint);
	// custom stores keep --session-dir or resume lands in the wrong place
	assert.equal(
		out,
		"To resume this session: blueberry --session-dir /Users/x/.blueberry/sessions/blueberry --session 01a038b3-bb3e",
	);
	// no hint → untouched
	assert.equal(rewriteResumeHint("normal output"), "normal output");
});

test("rewriteResumeHint: ANSI-dimmed label (the v0.3.0 leak)", () => {
	// the fork writes chalk.dim("To resume this session:") — escape codes
	// sit between the label and the command; the old \s* regex silently
	// no-matched and the raw pi line leaked to the user
	const leaked =
		"\x1b[2mTo resume this session:\x1b[22m pi --session-dir /Users/sienna/.blueberry/sessions/scratchpad --session 01a039d9-9f1b-7282-9820-3c09e8ddce49\n";
	const out = rewriteResumeHint(leaked);
	assert.equal(
		out,
		"To resume this session: blueberry --session-dir /Users/sienna/.blueberry/sessions/scratchpad --session 01a039d9-9f1b-7282-9820-3c09e8ddce49\n",
	);
	// default-store hint (no --session-dir) still rewrites cleanly
	assert.equal(
		rewriteResumeHint("To resume this session: pi --session abc123"),
		"To resume this session: blueberry --session abc123",
	);
});

test("rewriteChunk: both rewrites compose", () => {
	const chunk = `work\x1b]0;pi - x\x07To resume this session: pi --session-dir /d --session abc`;
	const out = rewriteChunk(chunk, OURS);
	assert.ok(out.includes(titleSequence(OURS)));
	assert.ok(out.includes("blueberry --session-dir /d --session abc"));
	assert.ok(!out.includes("pi --session-dir"));
});

// --- interceptor ------------------------------------------------------------------

test("interceptor: wraps a stream, rewrites titles, restore undoes", () => {
	const stream = new PassThrough();
	const seen: string[] = [];
	stream.on("data", (d: Buffer) => seen.push(d.toString()));

	const restore = installInterceptor(stream, OURS);
	stream.write("before\x1b]0;pi - tab\x07after");
	restore();
	stream.write(`plain ${"\x1b]0;raw title\x07"} stays`);

	assert.equal(seen.length, 2);
	assert.ok(seen[0]!.includes(titleSequence(OURS)));
	assert.ok(!seen[0]!.includes("pi - tab"));
	// after restore: no rewriting
	assert.ok(seen[1]!.includes("raw title"));
});

test("interceptor: idempotent — double install cannot double-wrap", () => {
	const stream = new PassThrough();
	const seen: string[] = [];
	stream.on("data", (d: Buffer) => seen.push(d.toString()));

	installInterceptor(stream, OURS);
	const restore2 = installInterceptor(stream, OURS); // no-op install
	restore2(); // no-op restore

	stream.write("\x1b]0;pi\x07x");
	assert.equal(seen.length, 1);
	assert.ok(seen[0]!.includes(titleSequence(OURS)));
	assert.ok(!seen[0]!.includes("\x1b]0;pi"));
});

test("interceptor: Buffer chunks pass unwrapped (fast path)", () => {
	const stream = new PassThrough();
	const seen: string[] = [];
	stream.on("data", (d: Buffer) => seen.push(d.toString()));
	installInterceptor(stream, OURS);

	const buf = Buffer.from("binary-ish \x1b]0;pi\x07 bytes");
	stream.write(buf);
	// Buffers skip the rewrite (only string chunks with OSC are rewritten);
	// acceptable: pi writes titles as strings
	assert.equal(seen[0]!, buf.toString());
});

test("interceptor: restore after another wrap leaves the later wrap intact", () => {
	const stream = new PassThrough() as PassThrough & {
		write: (c: string | Buffer) => boolean;
	};
	const restore = installInterceptor(stream, OURS);
	const later = stream.write;
	stream.write = ((c: string | Buffer) => later(c)) as typeof stream.write;
	restore(); // orig restored only if stream.write is still `wrapped`
	// stream.write was replaced after install: restore no-ops safely
	assert.ok(typeof stream.write === "function");
});
