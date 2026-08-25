/**
 * Identity contract tests: the terminal title and the claimed keybindings.
 *
 * The title broke in the field (pi re-asserted "<pi> - blueberry" from an
 * internal event we didn't cover). These tests pin the format we own so the
 * extension's re-claim can never drift, and pin the keybindings JSON so the
 * shipped file always frees the keys our extensions claim.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_KEYBINDINGS, projectNameFor, terminalTitle, TITLE_MARK } from "../src/core/identity.ts";

// --- title format ------------------------------------------------------------------

test("title: project-only form", () => {
	assert.equal(terminalTitle("blueberry"), "blueberry — blueberry");
	assert.equal(terminalTitle("webmail"), "blueberry — webmail");
});

test("title: session form mirrors pi's shape (mark — session — project)", () => {
	assert.equal(terminalTitle("blueberry", "api redesign"), "blueberry — api redesign — blueberry");
});

test("title: NEVER contains pi (the regression that bit us)", () => {
	for (const [project, session] of [
		["blueberry", null],
		["webmail", "s1"],
		["engine", undefined],
	] as Array<[string, string | null | undefined]>) {
		const t = terminalTitle(project, session ?? null);
		assert.ok(!t.toLowerCase().includes("pi"), `title leaked pi: ${t}`);
		assert.ok(t.startsWith(TITLE_MARK), `title must start with the mark: ${t}`);
	}
});

test("title: whitespace-only session falls back to project-only", () => {
	assert.equal(terminalTitle("blueberry", "   "), "blueberry — blueberry");
	assert.equal(terminalTitle("blueberry", ""), "blueberry — blueberry");
});

test("title: empty project falls back to the bare mark", () => {
	assert.equal(terminalTitle(""), "blueberry — blueberry");
	assert.equal(terminalTitle("  "), "blueberry — blueberry");
});

test("title: whitespace is trimmed, never double-dashed", () => {
	assert.equal(terminalTitle(" blueberry ", " spaced "), "blueberry — spaced — blueberry");
	assert.ok(!terminalTitle("x").includes("——"));
});

// --- project name -----------------------------------------------------------------

test("projectNameFor: last segment; root and empty tolerances", () => {
	assert.equal(projectNameFor("/Users/sienna/Development/blueberry"), "blueberry");
	assert.equal(projectNameFor("/srv"), "srv");
	assert.equal(projectNameFor("/"), "/");
	assert.equal(projectNameFor(""), "");
});

// --- keybindings contract -----------------------------------------------------------

test("keybindings: exactly the claims we ship — shift+tab and ctrl+p freed", () => {
	assert.equal(DEFAULT_KEYBINDINGS["app.thinking.cycle"], "ctrl+shift+t", "thinking off shift+tab (mode ring)");
	assert.equal(DEFAULT_KEYBINDINGS["app.model.cycleForward"], "ctrl+m", "model cycle off ctrl+p (todo pane)");
	assert.equal(Object.keys(DEFAULT_KEYBINDINGS).length, 2, "no accidental extra claims");
});

test("keybindings: the LIVE ~/.blueberry/keybindings.json matches the contract", () => {
	const live = join(homedir(), ".blueberry", "keybindings.json");
	if (!existsSync(live)) return; // not installed on this machine (CI): skip silently
	const parsed = JSON.parse(readFileSync(live, "utf8")) as Record<string, string>;
	for (const [id, key] of Object.entries(DEFAULT_KEYBINDINGS)) {
		assert.equal(parsed[id], key, `live keybindings drifted: ${id} should be ${key}`);
	}
});

test("keybindings: setup.sh writes the same contract (source-level check)", () => {
	const setup = readFileSync(new URL("../bin/setup.sh", import.meta.url), "utf8");
	for (const [id, key] of Object.entries(DEFAULT_KEYBINDINGS)) {
		assert.ok(setup.includes(`"${id}": "${key}"`), `setup.sh missing claim: ${id}: ${key}`);
	}
});
