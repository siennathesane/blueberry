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
  parseJunit,
  readLcovIfPresent,
  registerId,
  retireId,
} from "../src/core/lifecycle.ts";
import { openDb } from "../src/core/db.ts";
import { cleanup, tmpAgentDir, tmpDir } from "./helpers.ts";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

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

// --- JUnit ingestion (design 005 §Ingestion) --------------------------------

test("parseJunit: tagged pass, failing untagged, self-closing, classname, escapes", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="deno test" tests="4" failures="1" errors="0">
  <testsuite name="test/lifecycle.test.ts" tests="4" failures="1" errors="0">
    <testcase name="code search: first query works [a1b2c3]" classname="test/lifecycle.test.ts" time="0.003"/>
    <testcase name="untagged interior test" classname="test/lifecycle.test.ts" time="0.001">
      <failure message="AssertionError">boom
stack line</failure>
    </testcase>
    <testcase name="passes &amp; quotes &quot;ok&quot;" classname="suite.two" time="0.002"/>
    <testcase name="plain" time="0.000"/>
  </testsuite>
</testsuites>`;
  const cases = parseJunit(xml);
  assert.equal(cases.length, 4);
  assert.deepEqual(cases[0], {
    testName: "code search: first query works [a1b2c3]",
    className: "test/lifecycle.test.ts",
    outcome: "pass",
    id: "a1b2c3",
  });
  assert.equal(cases[1]!.outcome, "fail");
  assert.equal(cases[1]!.id, null);
  assert.equal(cases[1]!.testName, "untagged interior test");
  assert.equal(cases[2]!.className, "suite.two");
  assert.equal(cases[2]!.testName, 'passes & quotes "ok"');
  assert.equal(cases[3]!.className, null);
  assert.equal(cases[3]!.outcome, "pass");
});

test("parseJunit: empty and no-testcase documents", () => {
  assert.deepEqual(parseJunit(""), []);
  assert.deepEqual(parseJunit("<testsuites></testsuites>"), []);
});

test("junit_results round-trip: parsed cases persist with ids and outcomes", () => {
  const db = openDb(agentDir);
  const cases = parseJunit(
    `<testsuites><testsuite name="s">
      <testcase name="accept [abc123]" classname="s" time="1"/>
      <testcase name="broken [def456]" classname="s" time="1"><failure>x</failure></testcase>
    </testsuite></testsuites>`,
  );
  const ins = db.prepare(
    "INSERT INTO junit_results (test_name, class_name, outcome, id, ts) VALUES (?, ?, ?, ?, ?)",
  );
  for (const c of cases) ins.run(c.testName, c.className, c.outcome, c.id, "t");
  const rows = db
    .prepare("SELECT test_name, outcome, id FROM junit_results ORDER BY rowid")
    .all() as Array<{ test_name: string; outcome: string; id: string | null }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.id, "abc123");
  assert.equal(rows[1]!.outcome, "fail");
  assert.equal(rows[1]!.id, "def456");
  db.close();
});

// --- Lcov opportunistic read (design 005 §Ingestion) --------------------------

test("readLcovIfPresent returns null for absent file", () => {
  const dir = tmpDir();
  const result = readLcovIfPresent(join(dir, "nope.lcov"));
  assert.equal(result, null);
  cleanup(dir);
});

test("readLcovIfPresent aggregates LF and LH across multiple SF sections", () => {
  const dir = tmpDir();
  const path = join(dir, "cov.lcov");
  writeFileSync(
    path,
    [
      "SF:A.ts",
      "LF:10",
      "LH:8",
      "end_of_record",
      "SF:B.ts",
      "LF:5",
      "LH:5",
      "end_of_record",
    ].join("\n") + "\n",
  );
  const summary = readLcovIfPresent(path);
  assert.notEqual(summary, null);
  assert.equal(summary!.linesHit, 13);
  assert.equal(summary!.linesFound, 15);
  assert.equal(typeof summary!.mtime, "string");
  assert.ok(summary!.mtime.length > 0);
  cleanup(dir);
});

test("readLcovIfPresent returns null for malformed content with no LF lines", () => {
  const dir = tmpDir();
  const path = join(dir, "bad.lcov");
  writeFileSync(path, "SF:A.ts\nend_of_record\n");
  assert.equal(readLcovIfPresent(path), null);
  cleanup(dir);
});

test("lcov_snapshot upsert: second INSERT OR REPLACE overwrites first", () => {
  const db = openDb(agentDir);
  const upsert = db.prepare(
    "INSERT OR REPLACE INTO lcov_snapshot (path, lines_hit, lines_found, mtime, read_at) VALUES (?, ?, ?, ?, ?)",
  );
  upsert.run("/a.lcov", 8, 10, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  upsert.run("/a.lcov", 9, 10, "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
  const rows = db
    .prepare("SELECT lines_hit, lines_found, mtime FROM lcov_snapshot")
    .all() as Array<{ lines_hit: number; lines_found: number; mtime: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.lines_hit, 9);
  assert.equal(rows[0]!.mtime, "2026-01-02T00:00:00.000Z");
  db.close();
});
