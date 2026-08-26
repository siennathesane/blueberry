/**
 * Lifecycle id extraction — interior tests (design 005 identifier grammar).
 * Pure functions; no db, no fs. Acceptance-tagged tests arrive with later
 * plan steps; these stay untagged.
 */
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  extractIdParagraphs,
  extractIds,
  ID_LINE_PATTERN,
  idIsFree,
  mintId,
  registerId,
  retireId,
} from "../src/core/lifecycle.ts";
import { openDb } from "../src/core/db.ts";
import { cleanup, tmpAgentDir } from "./helpers.ts";

let agentDir: string;

beforeEach(() => {
  agentDir = tmpAgentDir();
});
afterEach(() => {
  cleanup(agentDir);
});

// --- pure extraction --------------------------------------------------------

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

// --- registry ----------------------------------------------------------------

/** Build a uuid-shaped string whose hex6Of equals the given 6 chars. */
function uuidStr(h: string): string {
  const prefix = "00000000000000000000000000"; // 26 chars
  const raw = prefix.slice(0, 26) + h; // 32 hex chars
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${
    raw.slice(16, 20)
  }-${raw.slice(20)}`;
}

test("mintId produces a six-lowercase-hex id that is free", () => {
  const db = openDb(agentDir);
  const id = mintId(db);
  assert.match(id, /^[0-9a-f]{6}$/);
  assert.equal(idIsFree(db, id), true);
  db.close();
});

test("mintId refuses collisions against todo hex6 and lifecycle_ids", () => {
  const db = openDb(agentDir);
  // Seed a todo whose hex6 will be "aabbcc"
  const todoId = uuidStr("aabbcc");
  db
    .prepare(
      "INSERT INTO todos (id, project_id, title, created_at, updated_at) VALUES (?, 'proj', 'test', 't', 't')",
    )
    .run(todoId);
  // Seed a lifecycle_id "ddeeff"
  db
    .prepare(
      "INSERT INTO lifecycle_ids (id, design_doc, paragraph, minted_at, status) VALUES (?, 'd', 'p', 't', 'live')",
    )
    .run("ddeeff");

  // rng returns aabbcc first (todo collision), ddeeff second (lifecycle collision),
  // then a genuinely free id third.
  let call = 0;
  const ordered: string[] = [uuidStr("aabbcc"), uuidStr("ddeeff")];
  const id = mintId(db, {
    rng: () => {
      if (call < ordered.length) return ordered[call++]!;
      return uuidStr("11" + String(call).padStart(4, "0")); // should not reach
    },
  });
  // Must not be aabbcc or ddeeff
  assert.notEqual(id, "aabbcc");
  assert.notEqual(id, "ddeeff");
  assert.match(id, /^[0-9a-f]{6}$/);
  db.close();
});

test("mintId throws after 50 failed attempts", () => {
  const db = openDb(agentDir);
  const fixed = uuidStr("aabbcc");
  db
    .prepare(
      "INSERT INTO lifecycle_ids (id, design_doc, paragraph, minted_at, status) VALUES (?, 'd', 'p', 't', 'live')",
    )
    .run("aabbcc");

  assert.throws(
    () => mintId(db, { rng: () => fixed }),
    /exhausted 50 attempts/,
  );
  db.close();
});

test("registerId inserts; second registerId of same id throws", () => {
  const db = openDb(agentDir);
  registerId(db, "abc123", {
    designDoc: "005-lifecycle-coverage-map.md",
    paragraph: "A short requirement. [abc123]",
  });
  const row = db
    .prepare("SELECT * FROM lifecycle_ids WHERE id = ?")
    .get("abc123") as Record<string, unknown>;
  assert.equal(row["id"], "abc123");
  assert.equal(row["design_doc"], "005-lifecycle-coverage-map.md");
  assert.equal(row["status"], "live");

  assert.throws(
    () =>
      registerId(db, "abc123", {
        designDoc: "other.md",
        paragraph: "dup",
      }),
  );
  db.close();
});

test("retireId marks retired; idIsFree stays false for retired ids", () => {
  const db = openDb(agentDir);
  registerId(db, "ff00cc", {
    designDoc: "d.md",
    paragraph: "p",
  });
  assert.equal(idIsFree(db, "ff00cc"), false);

  retireId(db, "ff00cc");
  const row = db
    .prepare("SELECT status FROM lifecycle_ids WHERE id = ?")
    .get("ff00cc") as { status: string };
  assert.equal(row.status, "retired");
  // retired ids are never re-minted
  assert.equal(idIsFree(db, "ff00cc"), false);
  db.close();
});

test("registered id stays occupied even if not drawn by rng", () => {
  const db = openDb(agentDir);
  registerId(db, "beef01", {
    designDoc: "d.md",
    paragraph: "p",
  });
  assert.equal(idIsFree(db, "beef01"), false);
  db.close();
});
