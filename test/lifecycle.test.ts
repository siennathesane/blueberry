/**
 * Lifecycle id extraction — interior tests (design 005 identifier grammar).
 * Pure functions; no db, no fs. Acceptance-tagged tests arrive with later
 * plan steps; these stay untagged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractIdParagraphs,
  extractIds,
  ID_LINE_PATTERN,
} from "../src/core/lifecycle.ts";

test("extractIds: ids at line-ends, document order, deduped", () => {
  const doc = [
    "First requirement. [a1b2c3]",
    "Context line with no id.",
    "Second requirement. [d4e5f6]",
    "Back-reference to the first id again. [a1b2c3]",
    "Third. [b2c3d4]",
  ].join("\n");
  assert.deepEqual(extractIds(doc), ["a1b2c3", "d4e5f6", "b2c3d4"]);
});

test("extractIds: empty input and no matches", () => {
  assert.deepEqual(extractIds(""), []);
  assert.deepEqual(extractIds("plain prose\nno ids\n"), []);
});

test("extractIds: uppercase hex and mid-line ids never match", () => {
  assert.deepEqual(extractIds("upper [A1B2C3] at end"), []);
  assert.deepEqual(extractIds("mid [a1b2c3] with trailing words"), []);
  assert.deepEqual(extractIds("wrong length [a1b2c] and [a1b2c3d]"), []);
});

test("extractIdParagraphs: multi-line paragraph, id on final line", () => {
  const doc =
    "Every decided requirement of this design is stated\nin prose, possibly spanning lines,\nand ends with its id. [abc123]\n\nContext paragraph explains rationale and carries no tag.";
  const blocks = extractIdParagraphs(doc);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.id, "abc123");
  assert.equal(
    blocks[0]!.text,
    "Every decided requirement of this design is stated\nin prose, possibly spanning lines,\nand ends with its id. [abc123]",
  );
});

test("extractIdParagraphs: block whose final line lacks an id yields nothing", () => {
  const doc =
    "A paragraph that mentions an id\nearly [a1b2c3] but keeps talking past it.\n\nAlso nothing here.";
  assert.deepEqual(extractIdParagraphs(doc), []);
});

test("extractIdParagraphs: realistic doc — requirements in order, context skipped", () => {
  const doc = `## Goal

A single identifier grammar carried unchanged through every surface. [a01d2e]

Ids are minted at decide time and are immutable. [b02e3f]

This paragraph is context only — it explains the goal without stating
a requirement, so it must yield nothing.

## Non-goals

Even here a requirement paragraph counts. [c03e4b]
`;
  const blocks = extractIdParagraphs(doc);
  assert.deepEqual(
    blocks.map((b) => b.id),
    ["a01d2e", "b02e3f", "c03e4b"],
  );
  assert.ok(blocks[0]!.text.startsWith("A single identifier"));
  assert.ok(blocks[1]!.text.endsWith("[b02e3f]"));
});

test("ID_LINE_PATTERN: the one pattern, anchored at line end", () => {
  assert.deepEqual(
    ID_LINE_PATTERN.exec("ends with id [f00dab]")?.[1],
    "f00dab",
  );
  assert.equal(ID_LINE_PATTERN.test("mid [f00dab] line"), false);
  assert.equal(ID_LINE_PATTERN.test("[F00DAB]"), false);
});
