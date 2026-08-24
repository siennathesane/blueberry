import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, stripAnsi, padEndVisible, truncateVisible, centerVisible } from "../src/core/ansi.ts";

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

test("visibleWidth: escape sequences are zero-width", () => {
	assert.equal(visibleWidth("hello"), 5);
	assert.equal(visibleWidth(`${RED}hello${RESET}`), 5);
	assert.equal(visibleWidth(`${RED}${RESET}`), 0);
	assert.equal(visibleWidth(""), 0);
});

test("stripAnsi: removes all escapes", () => {
	assert.equal(stripAnsi(`${RED}ab${RESET}${RED}c${RESET}`), "abc");
	assert.equal(stripAnsi("plain"), "plain");
});

test("padEndVisible: pads to VISIBLE width, not string length", () => {
	const colored = `${RED}hi${RESET}`;
	const padded = padEndVisible(colored, 6);
	assert.equal(padded.length, colored.length + 4, "pads by the visible deficit only");
	assert.equal(visibleWidth(padded), 6);
	assert.equal(padEndVisible("already-long-enough", 4), "already-long-enough");
});

test("truncateVisible: cuts at visible width, keeps leading color, adds ellipsis", () => {
	const colored = `${RED}abcdefghij${RESET}`;
	const cut = truncateVisible(colored, 5);
	assert.ok(cut.startsWith(RED), "leading color preserved");
	assert.equal(stripAnsi(cut), "abcd…");
	assert.equal(visibleWidth(cut), 5);
	// under limit: returned untouched
	assert.equal(truncateVisible(`${RED}abc${RESET}`, 10), `${RED}abc${RESET}`);
	// exact fit: untouched
	assert.equal(truncateVisible("abcde", 5), "abcde");
	// uncolored
	assert.equal(stripAnsi(truncateVisible("abcdefghij", 5)), "abcd…");
});

test("centerVisible: left-biased centering", () => {
	assert.equal(centerVisible("ab", 6), "  ab  ");
	assert.equal(centerVisible("abc", 6), " abc  ");
	assert.equal(centerVisible("toolong", 3), "toolong");
});
