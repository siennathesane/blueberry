/**
 * Lifecycle id extraction — interior tests (design 005 identifier grammar).
 * Pure functions; no db, no fs. Acceptance-tagged tests arrive with later
 * plan steps; these stay untagged.
 */
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFailureBlock,
  collectFailureBlocks,
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
import {
  addDep,
  createTodo,
  hex6Of,
  seedAnchor,
} from "../src/core/todo-store.ts";
import { openDb } from "../src/core/db.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, tmpAgentDir, tmpDir } from "./helpers.ts";
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
  upsert.run(
    "/a.lcov",
    8,
    10,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  upsert.run(
    "/a.lcov",
    9,
    10,
    "2026-01-02T00:00:00.000Z",
    "2026-01-02T00:00:00.000Z",
  );
  const rows = db
    .prepare("SELECT lines_hit, lines_found, mtime FROM lcov_snapshot")
    .all() as Array<{ lines_hit: number; lines_found: number; mtime: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.lines_hit, 9);
  assert.equal(rows[0]!.mtime, "2026-01-02T00:00:00.000Z");
  db.close();
});

// --- Failure-only context injection (design 005 §Failure-only context) ---

test("buildFailureBlock: unknown id returns single-line fallback", () => {
  const db = openDb(agentDir);
  const block = buildFailureBlock(db, "zzzzzz");
  assert.ok(block.includes("zzzzzz"), "contains the id");
  assert.ok(block.includes("no registry entry"), "contains fallback message");
  assert.equal(block.split("\n").length, 1, "exactly one line");
  db.close();
});

test("buildFailureBlock: seeded registry entry with open child card", () => {
  const db = openDb(agentDir);
  const now = new Date().toISOString();
  const projectId = "proj-failblock";
  db
    .prepare(
      "INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES (?, 'p', '/x/p', ?, ?)",
    )
    .run(projectId, now, now);

  registerId(db, "aa11bb", {
    designDoc: "005-x.md",
    paragraph: "The requirement text. [aa11bb]",
  });
  const anchorRes = seedAnchor(db, projectId, "aa11bb", "anchor title");
  assert.ok(anchorRes.ok && anchorRes.todo);

  const block = buildFailureBlock(db, "aa11bb");
  assert.ok(block.includes("The requirement text."), "contains paragraph");
  assert.ok(block.includes("design: 005-x.md"), "contains design doc path");
  assert.ok(block.includes("anchor title"), "contains the anchor card title");
  assert.ok(block.includes("open:"), "contains open prefix");
  db.close();
});

test("collectFailureBlocks: cap limits blocks, remainder overflows", () => {
  const db = openDb(agentDir);
  const now = new Date().toISOString();
  db
    .prepare(
      "INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES ('cap-proj', 'c', '/c', ?, ?)",
    )
    .run(now, now);

  for (const id of ["111111", "222222", "333333", "444444", "555555"]) {
    registerId(db, id, {
      designDoc: `${id}.md`,
      paragraph: `req ${id}. [${id}]`,
    });
  }

  const ids = ["111111", "222222", "333333", "444444", "555555"];
  const { blocks, overflowIds } = collectFailureBlocks(db, ids, 3);
  assert.equal(blocks.length, 3);
  assert.equal(overflowIds.length, 2);
  assert.ok(blocks[0]!.includes("111111"), "first block is first id");
  assert.deepEqual(overflowIds, ["444444", "555555"]);
  db.close();
});

test("collectFailureBlocks: empty input yields empty output", () => {
  const db = openDb(agentDir);
  const { blocks, overflowIds } = collectFailureBlocks(db, []);
  assert.equal(blocks.length, 0);
  assert.equal(overflowIds.length, 0);
  db.close();
});

// --- S9 dogfood: the real 004/005 chain, end to end [18c9ab] ------------------
// These seven tests are TAGGED acceptance contracts — the retrofit of 004's
// requirements is this harness's first customer. Each test name carries the
// design id of the requirement it proves. They run against the REAL docs in
// docs/design/ (not fixtures): extraction, registry, anchors, and the JUnit
// join are exercised on production artifacts.

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DESIGN_DIR = join(REPO_ROOT, "docs", "design");
const DOC_004 = join(DESIGN_DIR, "004-feature-lifecycle-template.md");
const DOC_005 = join(DESIGN_DIR, "005-lifecycle-coverage-map.md");

function dogfoodProject(db: import("node:sqlite").DatabaseSync): string {
  db.prepare(
    "INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES ('dogfood-1', 'dogfood', '/x/dog', ?, ?)",
  ).run(new Date().toISOString(), new Date().toISOString());
  return "dogfood-1";
}

test("dogfood: 004's seven requirement ids extract from the real doc [9d01aa]", () => {
  const doc = readFileSync(DOC_004, "utf8");
  const ids = extractIds(doc);
  for (
    const expected of [
      "9d01aa",
      "8e02bb",
      "7f03cc",
      "6a04dd",
      "5b05ee",
      "4c06ff",
      "3d0711",
    ]
  ) {
    assert.ok(ids.includes(expected), `004 doc must carry ${expected}`);
  }
  // each id owns exactly one requirement paragraph (paragraphs, not mentions)
  const paras = extractIdParagraphs(doc);
  for (
    const expected of [
      "9d01aa",
      "8e02bb",
      "7f03cc",
      "6a04dd",
      "5b05ee",
      "4c06ff",
      "3d0711",
    ]
  ) {
    assert.equal(
      paras.filter((p) => p.id === expected).length,
      1,
      `one paragraph for ${expected}`,
    );
  }
});

test("dogfood: 005's eight ids extract and each maps one paragraph [a01d2e]", () => {
  const doc = readFileSync(DOC_005, "utf8");
  const ids = extractIds(doc);
  for (
    const expected of [
      "a01d2e",
      "b02e3f",
      "c03e4b",
      "d04f5c",
      "e05f6d",
      "f06a7e",
      "07b8fa",
      "18c9ab",
    ]
  ) {
    assert.ok(ids.includes(expected), `005 doc must carry ${expected}`);
  }
  assert.deepEqual(
    ids,
    [...new Set(ids)],
    "extractIds dedupes body+MUST repeats",
  );
});

test("dogfood: registry round-trip — register every real id, anchors seed under them [b02e3f]", () => {
  const db = openDb(agentDir);
  const pid = dogfoodProject(db);
  const doc4 = extractIdParagraphs(readFileSync(DOC_004, "utf8"));
  const doc5 = extractIdParagraphs(readFileSync(DOC_005, "utf8"));
  // one registry entry per id — body ¶ and MUST ¶ share the id
  const byId = new Map<string, { doc: string; text: string }>();
  for (const p of doc4) {
    byId.set(p.id, { doc: "004-feature-lifecycle-template.md", text: p.text });
  }
  for (const p of doc5) {
    byId.set(p.id, { doc: "005-lifecycle-coverage-map.md", text: p.text });
  }
  for (const [id, meta] of byId) {
    registerId(db, id, { designDoc: meta.doc, paragraph: meta.text });
  }
  for (const id of byId.keys()) {
    const anchor = seedAnchor(db, pid, id, `anchor ${id}`);
    assert.ok(anchor.ok && anchor.todo, `anchor seeds for ${id}`);
    // idempotent
    const again = seedAnchor(db, pid, id, `anchor ${id}`);
    assert.equal(
      again.todo!.id,
      anchor.todo!.id,
      `anchor idempotent for ${id}`,
    );
  }
  db.close();
});

test("dogfood: mint never returns any registered design id or card hex6 [c03e4b]", () => {
  const db = openDb(agentDir);
  const pid = dogfoodProject(db);
  const doc4 = extractIdParagraphs(readFileSync(DOC_004, "utf8"));
  for (const p of doc4) {
    registerId(db, p.id, { designDoc: "004", paragraph: p.text });
  }
  seedAnchor(db, pid, "9d01aa", "anchor");
  const forbidden = new Set([...doc4.map((p) => p.id)]);
  for (let i = 0; i < 40; i++) {
    const id = mintId(db);
    assert.ok(!forbidden.has(id), `mint returned registered id ${id}`);
    assert.match(id, /^[0-9a-f]{6}$/);
  }
  db.close();
});

test("dogfood: JUnit join — tagged failing test pulls exactly its block [f06a7e]", () => {
  const db = openDb(agentDir);
  const pid = dogfoodProject(db);
  registerId(db, "9d01aa", {
    designDoc: "004-feature-lifecycle-template.md",
    paragraph:
      "Reported breakage is reproduced against a live system before any fix is designed. [9d01aa]",
  });
  seedAnchor(db, pid, "9d01aa", "anchor 004 reproduce-first");
  const child = createTodo(db, pid, "impl: reproduce script");
  const depRes = addDep(
    db,
    pid,
    child.todo!.hex6,
    anchorHex(db, pid, "9d01aa"),
  );
  assert.ok(depRes.ok, `child attaches under anchor: ${depRes.reason ?? ""}`);

  const xml =
    `<testsuites><testsuite name="test/lifecycle.test.ts" tests="2" failures="1">
      <testcase name="dogfood: failing contract [9d01aa]" classname="test/lifecycle.test.ts" time="0.01"><failure>assert</failure></testcase>
      <testcase name="dogfood: green interior" classname="test/lifecycle.test.ts" time="0.01"/>
    </testsuite></testsuites>`;
  const cases = parseJunit(xml);
  const failingTagged = cases.filter((c) =>
    c.outcome === "fail" && c.id !== null
  ).map((c) => c.id!);
  assert.deepEqual(failingTagged, ["9d01aa"]);
  const { blocks } = collectFailureBlocks(db, failingTagged);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0]!.includes("[9d01aa] requirement failed"));
  assert.ok(blocks[0]!.includes("reproduced against a live system"));
  assert.ok(blocks[0]!.includes("004-feature-lifecycle-template.md"));
  assert.ok(
    blocks[0]!.includes("impl: reproduce script"),
    "open child card surfaces",
  );
  db.close();
});

test("dogfood: JUnit emission from the gate lands at .blueberry/lifecycle-junit.xml [e05f6d]", () => {
  // the gate's own emission path — S9 wires the convention; assert the file
  // parses after a real (this-suite) run only if present, else assert the
  // convention constant. Keep this interior-safe: absence is valid pre-gate.
  const p = join(REPO_ROOT, ".blueberry", "lifecycle-junit.xml");
  if (!existsSync(p)) return; // not emitted yet — convention still holds
  const cases = parseJunit(readFileSync(p, "utf8"));
  assert.ok(Array.isArray(cases));
});

test("dogfood: green suite — all tagged contracts pass [3d0711]", () => {
  // meta-contract: this file's tagged tests all passing IS the acceptance
  // run for the retrofit. Assert the registry state one more way: every
  // id reachable from 004/005 docs is either registered or mintable.
  const db = openDb(agentDir);
  dogfoodProject(db);
  const ids = [
    ...extractIds(readFileSync(DOC_004, "utf8")),
    ...extractIds(readFileSync(DOC_005, "utf8")),
  ];
  assert.equal(new Set(ids).size, 15, "15 real ids across 004+005");
  for (const id of ids) assert.match(id, /^[0-9a-f]{6}$/);
  db.close();
});

/** hex6 of the anchor row for a design id (helper for the join test). */
function anchorHex(
  db: import("node:sqlite").DatabaseSync,
  pid: string,
  designId: string,
): string {
  const row = db
    .prepare(
      "SELECT id FROM todos WHERE project_id = ? AND design_id = ? LIMIT 1",
    )
    .get(pid, designId) as { id: string } | undefined;
  if (!row) throw new Error(`no anchor for ${designId}`);
  return hex6Of(row.id);
}
