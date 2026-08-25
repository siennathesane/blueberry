import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import {
	ulid,
	slugify,
	expandTilde,
	encodeCwdToDirName,
	decodeDirNameToPathCandidates,
	sanitizeSessionName,
	shortEntryId,
} from "../src/core/util.ts";
import { existsSync, mkdirSync } from "node:fs";
import { tmpDir } from "./helpers.ts";

test("ulid: 26 chars, Crockford alphabet, sortable by time", () => {
	const a = ulid(1000);
	const b = ulid(2000);
	assert.equal(a.length, 26);
	assert.equal(b.length, 26);
	assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
	assert.ok(a < b, "later timestamp sorts after");
});

test("ulid: uniqueness under burst", () => {
	const seen = new Set(Array.from({ length: 1000 }, () => ulid()));
	assert.equal(seen.size, 1000);
});

test("slugify: lowercase, dashes, trimmed", () => {
	assert.equal(slugify("Blueberry Pi"), "blueberry-pi");
	assert.equal(slugify("  ../weird!! name  "), "weird-name");
	assert.equal(slugify("π≈3.14"), "3-14");
	assert.equal(slugify("---"), "project");
	assert.equal(slugify(""), "project");
});

test("slugify: max 48 chars", () => {
	assert.ok(slugify("x".repeat(100)).length <= 48);
});

test("expandTilde: ~ and ~/ prefixes, otherwise untouched", () => {
	const home = "/home/tester";
	if (os.platform() !== "win32") {
		// #32: expandTilde uses unix-style paths; Windows uses drive letters
		assert.equal(expandTilde("~", home), "/home/tester");
		assert.equal(expandTilde("~/dev", home), "/home/tester/dev");
		assert.equal(expandTilde("/abs/path", home), "/abs/path");
		assert.equal(expandTilde("~other/x", home), "~other/x");
	} else {
		// On Windows, test with a Windows-style home path
		const winHome = "C:\\Users\\test";
		assert.equal(expandTilde("~", winHome), "C:\\Users\\test");
		assert.equal(expandTilde("~/dev", winHome), "C:\\Users\\test\\dev");
		assert.equal(expandTilde("C:\\abs\\path", winHome), "C:\\abs\\path");
		assert.equal(expandTilde("~other/x", winHome), "~other/x");
	}
});

test("encodeCwdToDirName: matches pi's mangling", () => {
	assert.equal(
		encodeCwdToDirName("/Users/sienna/Development/blueberry"),
		"--Users-sienna-Development-blueberry--",
	);
});

test("decodeDirNameToPathCandidates: round-trips real dirs", () => {
	const base = tmpDir("bb-decode-");
	// Ambiguity pair: <base>/foo-bar (dashed component) and <base>/foo/bar (nested dir)
	// encode identically — both are legitimate decodings.
	mkdirSync(`${base}/foo-bar`, { recursive: true });
	mkdirSync(`${base}/foo/bar`, { recursive: true });

	const encoded = encodeCwdToDirName(`${base}/foo-bar`);
	const candidates = decodeDirNameToPathCandidates(encoded, existsSync);
	assert.ok(candidates.includes(`${base}/foo-bar`));
	assert.ok(candidates.includes(`${base}/foo/bar`));
});

test("decodeDirNameToPathCandidates: rejects non-pi dir names", () => {
	assert.deepEqual(
		decodeDirNameToPathCandidates("Users-sienna-x--", () => true),
		[],
	);
	assert.deepEqual(
		decodeDirNameToPathCandidates("--x--", () => true),
		["/x"],
	);
});

test("sanitizeSessionName: matches pi (strip CR/LF, trim)", () => {
	assert.equal(sanitizeSessionName("  hello \n world\r\n"), "hello   world");
});

test("shortEntryId: 8 hex, no collision with provided set", () => {
	const existing = new Set(["aaaaaaaa"]);
	const id = shortEntryId(existing);
	assert.match(id, /^[0-9a-f]{8}$/);
	assert.ok(!existing.has(id));
});
