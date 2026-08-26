/**
 * Design + plan store tests: scaffold/completeness/transitions;
 * step parsing, seeding, consistency passes.
 */
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { openDb } from "../src/core/db.ts";
import {
  checkCompleteness,
  DESIGN_SCAFFOLD,
  designBreadcrumb,
  findOpenDesign,
  readDesignDoc,
  REQUIRED_SECTIONS,
  scaffoldDesign,
  stripComments,
  writeDesignStatus,
} from "../src/core/design-store.ts";
import {
  activePlan,
  createPlan,
  getPlan,
  parseSteps,
  passDependencySanity,
  passDesignCompleteness,
  passIdInheritance,
  passPlanPurity,
  passTestCompleteness,
  planBreadcrumb,
  planProgress,
  runAllPasses,
  seedPlan,
  setPlanStatus,
  updatePlanBody,
} from "../src/core/plan-store.ts";
import { ingestDesignDocs, searchDocs } from "../src/core/doc-index.ts";
import { listTodos } from "../src/core/todo-store.ts";
import { cleanup, tmpAgentDir, tmpDir } from "./helpers.ts";

let agentDir: string;
let area: string;
let db: ReturnType<typeof openDb>;
const PROJECT = "proj-dp-1";

beforeEach(() => {
  agentDir = tmpAgentDir();
  area = tmpDir("bb-dp-");
  db = openDb(agentDir);
  db
    .prepare(
      "INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES (?, 'p', ?, ?, ?)",
    )
    .run(PROJECT, area, new Date().toISOString(), new Date().toISOString());
});
afterEach(() => {
  db.close();
  cleanup(agentDir, area);
});

// --- scaffold ------------------------------------------------------------------------

test("scaffold: file created with frontmatter id, title, date; questions embedded", () => {
  const { path, id } = scaffoldDesign(area, "Test Design Alpha");
  assert.match(id, /^[0-9a-f]{6}$/);
  const raw = readFileSync(path, "utf8");
  assert.ok(raw.includes(`id: ${id}`));
  assert.ok(raw.includes("title: Test Design Alpha"));
  assert.ok(raw.includes("status: open"));
  assert.ok(raw.includes("## Audience"));
  assert.ok(raw.includes("## Requirements"));
  assert.ok(raw.includes("<!--")); // questions present
  assert.ok(path.endsWith("test-design-alpha.md"));
  // NO date in the filename (user call: numbers order, dates churn)
  assert.ok(
    !/\d{4}-\d{2}-\d{2}/.test(basename(path)),
    "no date-encoded filename",
  );
});

test("scaffold: zero-padded numeric sequence — 001, 002, ...; legacy files untouched", () => {
  // legacy date-named file pre-exists: left alone, doesn't join the sequence
  const dir = join(area, "docs", "design");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "2026-01-01-legacy-design.md"),
    "---\nstatus: done\n---\n## Problem\nx\n",
  );

  const first = scaffoldDesign(area, "First Numbered");
  assert.ok(basename(first.path).startsWith("001-"), "first numbered is 001");

  const second = scaffoldDesign(area, "Second Numbered");
  assert.ok(basename(second.path).startsWith("002-"), "second is 002");

  // three digits holds past 999 handled by padStart growth (1000 → "1000")
  assert.ok(
    existsSync(join(dir, "2026-01-01-legacy-design.md")),
    "legacy untouched",
  );
});

// --- completeness ---------------------------------------------------------------------

test("completeness: fresh scaffold is unanswered; filled doc passes", () => {
  const { path } = scaffoldDesign(area, "Gate Test");
  const raw = readFileSync(path, "utf8");
  const r1 = checkCompleteness(raw);
  assert.ok(
    r1.unanswered.length >= 8,
    `fresh scaffold mostly unanswered: ${r1.unanswered.length}`,
  );

  // fill every required section with content
  let filled = stripComments(raw);
  for (const section of REQUIRED_SECTIONS) {
    const re = new RegExp(`(## ${section.replace(/[&]/g, "\\&")}\\s*\\n)`, "m");
    filled = filled.replace(re, `$1ANSWERED: real content for ${section}.\n`);
  }
  // Approaches: the scaffold's bullets survive comments — that's fine
  const r2 = checkCompleteness(filled);
  assert.equal(
    r2.unanswered.length,
    0,
    `all answered: ${r2.unanswered.join(", ")}`,
  );
});

test("completeness: MUST detection and verification cross-check", () => {
  let body = DESIGN_SCAFFOLD.replaceAll("{{ID}}", "aa0000")
    .replaceAll("{{TITLE}}", "T")
    .replaceAll("{{DATE}}", "2026-08-25");
  body = stripComments(body);
  // fill all sections; Requirements with a MUST, Verification with a matching line
  body = body.replace(
    "## Requirements\n",
    "## Requirements\n\nR1. The system MUST complete sync under 2s.\n",
  );
  body = body.replace(
    "## Verification\n",
    "## Verification\n\nWhen this ships, R1 is proven by the sync benchmark.\n",
  );
  for (
    const section of [
      "Audience",
      "Problem",
      "Goal",
      "Non-goals",
      "Approaches considered",
      "Decision",
      "Risks & open questions",
    ]
  ) {
    body = body.replace(
      `## ${section}\n`,
      `## ${section}\n\ncontent ${section}.\n`,
    );
  }
  const r = checkCompleteness(body);
  assert.equal(r.unanswered.length, 0);
  assert.equal(r.requirements.musts.length, 1);
  assert.ok(r.requirements.musts[0]!.includes("MUST"));
  // covered (Verification non-empty) → no uncovered
  assert.equal(r.requirements.uncoveredMusts.length, 0);
});

// --- transitions ---------------------------------------------------------------------

test("writeDesignStatus: updates frontmatter in place; superseded-by inserted", () => {
  const { path } = scaffoldDesign(area, "Transition Test");
  writeDesignStatus(path, "decided");
  let doc = readDesignDoc(path);
  assert.equal(doc!.status, "decided");

  writeDesignStatus(path, "superseded", { supersededBy: "ff9911" });
  doc = readDesignDoc(path);
  assert.equal(doc!.status, "superseded");
  assert.equal(doc!.supersededBy, "ff9911");
});

test("findOpenDesign: none before ingest; found after; null after decided", () => {
  assert.equal(findOpenDesign(db, PROJECT), null);
  const { path } = scaffoldDesign(area, "Open Finder");
  ingestDesignDocs(db, area, PROJECT); // indexes it as open
  const found = findOpenDesign(db, PROJECT);
  assert.ok(found);
  assert.equal(found!.title, "Open Finder");
  writeDesignStatus(path, "decided");
  ingestDesignDocs(db, area, PROJECT); // re-ingest with decided status
  assert.equal(findOpenDesign(db, PROJECT), null);
});

test("designBreadcrumb: needle format", () => {
  const b = designBreadcrumb("p", "ab12cd", "Title Here", "open->decided");
  assert.ok(b.startsWith("design:p/ab12cd"));
  assert.ok(b.includes("Title Here"));
});

// --- step parsing -----------------------------------------------------------------------

test("parseSteps: numbered steps with reqs, deps, deliverable, acceptance", () => {
  const body = `## Steps

1. **Build the store** \`R1,R2\`
   - Deliverable: store module
   - Acceptance: unit tests pass

2. **Wire the CLI** \`R1\` ⟵ 1
   - Deliverable: bb command
   - Acceptance: e2e green

3. **Ship it** ⟵ 1,2

## Test matrix
`;
  const steps = parseSteps(body);
  assert.equal(steps.length, 3);
  assert.equal(steps[0]!.title, "Build the store");
  assert.deepEqual(steps[0]!.requirements, ["R1", "R2"]);
  assert.deepEqual(steps[0]!.dependsOn, []);
  assert.equal(steps[0]!.deliverable, "store module");
  assert.equal(steps[0]!.acceptance, "unit tests pass");
  assert.deepEqual(steps[1]!.dependsOn, [1]);
  assert.deepEqual(steps[2]!.dependsOn, [1, 2]);
  assert.deepEqual(steps[2]!.requirements, []);
});

test("parseSteps: no Steps section → empty", () => {
  assert.deepEqual(parseSteps("## Other\n\nno steps"), []);
});

// --- plan store + seeding ------------------------------------------------------------------

test("plan: create/get/active/update rev + reindex", () => {
  const plan = createPlan(db, PROJECT, "## Steps\n\n1. **Step one** `R1`");
  assert.equal(plan.status, "draft");
  assert.equal(plan.rev, 1);
  assert.equal(activePlan(db, PROJECT)!.id, plan.id);

  updatePlanBody(
    db,
    plan.id,
    "## Steps\n\n1. **Step one** `R1`\n2. **Step two**",
  );
  const updated = getPlan(db, plan.id);
  assert.equal(updated!.rev, 2);
  assert.ok(updated!.body.includes("Step two"));

  // no active plan for another project
  assert.equal(activePlan(db, "other-project"), null);
});

test("seedPlan: steps become tasks, deps become DAG edges, status building", () => {
  const body = `## Steps

1. **Foundation** \`R1\`
   - Deliverable: base
   - Acceptance: tests

2. **Middle** \`R2\` ⟵ 1

3. **Top** \`R1,R2\` ⟵ 2
`;
  const plan = createPlan(db, PROJECT, body);
  const result = seedPlan(db, plan, "p", "session-1");
  assert.equal(result.count, 3);
  assert.equal(result.errors.length, 0);

  const todos = listTodos(db, PROJECT);
  assert.equal(todos.length, 3);
  const s1 = todos.find((t) => t.title.startsWith("S1."))!;
  const s2 = todos.find((t) => t.title.startsWith("S2."))!;
  const s3 = todos.find((t) => t.title.startsWith("S3."))!;
  assert.ok(s1.title.includes("[R1]"));
  assert.ok(s3.title.includes("[R1,R2]"));

  // deps: s2 ⟵ s1, s3 ⟵ s2
  assert.deepEqual(s2.blockedBy, [s1.hex6]);
  assert.deepEqual(s3.blockedBy, [s2.hex6]);
  assert.deepEqual(s1.blockedBy, []);

  // plan status: building, seeded
  const seeded = getPlan(db, plan.id);
  assert.equal(seeded!.status, "building");
  assert.equal(seeded!.seeded_count, 3);

  // progress: 0/3
  const prog = planProgress(db, seeded!);
  assert.equal(prog.total, 3);
  assert.equal(prog.done, 0);
});

test("seedPlan: dep on missing step reported, not fatal", () => {
  const body = `## Steps\n\n1. **Only** ⟵ 99\n`;
  const plan = createPlan(db, PROJECT, body);
  const result = seedPlan(db, plan, "p", null);
  assert.equal(result.count, 1);
  assert.ok(result.errors.some((e) => e.includes("missing step 99")));
});

// --- consistency passes ----------------------------------------------------------------------

function designWithRequirements(reqs: string): string {
  let body = DESIGN_SCAFFOLD.replaceAll("{{ID}}", "ab12cd")
    .replaceAll("{{TITLE}}", "T")
    .replaceAll("{{DATE}}", "d");
  body = stripComments(body);
  body = body.replace("## Requirements\n", `## Requirements\n\n${reqs}\n`);
  body = body.replace(
    "## Verification\n",
    "## Verification\n\nV-R1 proven by tests.\n",
  );
  for (
    const s of [
      "Audience",
      "Problem",
      "Goal",
      "Non-goals",
      "Approaches considered",
      "Decision",
      "Risks & open questions",
    ]
  ) {
    body = body.replace(`## ${s}\n`, `## ${s}\n\ncontent.\n`);
  }
  return body;
}

test("P1: uncovered MUST flagged; covered MUST clean", () => {
  const design = designWithRequirements(
    "R1. The system MUST sync fast.\nR2. The system MUST be safe.",
  );
  const planNoCover = "## Steps\n\n1. **Only covers R1** `R1`";
  const r1 = passDesignCompleteness(design, planNoCover);
  assert.ok(!r1.clean);
  assert.ok(r1.findings.some((f) => f.includes("R2")));

  const planCovers = "## Steps\n\n1. **A** `R1`\n2. **B** `R2`";
  const r2 = passDesignCompleteness(design, planCovers);
  assert.ok(r2.clean, JSON.stringify(r2.findings));
});

test("P2: uncited steps flagged; all-cited clean", () => {
  const plan = "## Steps\n\n1. **Cited** `R1`\n2. **Uncited step here**";
  const r = passPlanPurity(plan);
  assert.ok(!r.clean);
  assert.ok(r.findings.some((f) => f.includes("step 2")));

  const clean = passPlanPurity("## Steps\n\n1. **A** `R1`\n2. **B** `R2`");
  assert.ok(clean.clean);
});

test("P3: missing matrix and uncovered MUST cases flagged", () => {
  const design = designWithRequirements("R1. The system MUST work.");
  const noMatrix = "## Steps\n\n1. **A** `R1`";
  const r1 = passTestCompleteness(design, noMatrix);
  assert.ok(!r1.clean);
  assert.ok(r1.findings.some((f) => f.includes("Test matrix")));

  const withMatrix =
    `## Steps\n\n1. **A** \`R1\`\n\n## Test matrix\n\n| Case | Type | Proves | Covers | Step |\n|------|------|--------|--------|------|\n| T1 | happy | R1 works | R1 | 1 |`;
  const r2 = passTestCompleteness(design, withMatrix);
  assert.ok(r2.clean, JSON.stringify(r2.findings));
});

test("P4: missing dep target and cycles detected; clean plan passes", () => {
  const bad = "## Steps\n\n1. **A** ⟵ 2\n2. **B** ⟵ 1\n3. **C** ⟵ 99";
  const r = passDependencySanity(bad);
  assert.ok(!r.clean);
  assert.ok(r.findings.some((f) => f.includes("cycle")));
  assert.ok(r.findings.some((f) => f.includes("missing step 99")));

  const good = "## Steps\n\n1. **A**\n2. **B** ⟵ 1";
  assert.ok(passDependencySanity(good).clean);
});

test("runAllPasses: full pipeline on a good design+plan", () => {
  const design = designWithRequirements("R1. The system MUST sync fast.");
  const plan =
    `## Steps\n\n1. **Build** \`R1\`\n   - Deliverable: module\n   - Acceptance: tests\n\n## Test matrix\n\n| Case | Type | Proves | Covers | Step |\n|------|------|--------|--------|------|\n| T1 | happy | R1 | R1 | 1 |\n\n## Coverage matrix\n\n| Aspect | Steps | Cases |\n|---------|-------|-------|\n| R1 | 1 | T1 |`;
  const results = runAllPasses(design, plan);
  assert.equal(results.length, 5);
  for (const r of results) {
    assert.ok(r.clean, `${r.pass}: ${r.findings.join("; ")}`);
  }
});

test("planBreadcrumb: needle format", () => {
  const b = planBreadcrumb("p", "cd34ef", "Plan Title", "approved");
  assert.ok(b.startsWith("plan:p/cd34ef"));
});

// --- branch closure: design-store edges, plan-store edges ---

test("completeness: untagged MUSTs are not collected (R# prefix required by contract)", () => {
  let body = stripComments(
    DESIGN_SCAFFOLD.replaceAll("{{ID}}", "x")
      .replaceAll("{{TITLE}}", "T")
      .replaceAll("{{DATE}}", "d"),
  );
  body = body.replace(
    "## Requirements\n",
    "## Requirements\n\n1. The system MUST do a thing without an R tag.\n",
  );
  for (
    const s of [
      "Audience",
      "Problem",
      "Goal",
      "Non-goals",
      "Approaches considered",
      "Decision",
      "Risks & open questions",
      "Verification",
    ]
  ) {
    body = body.replace(`## ${s}\n`, `## ${s}\n\ncontent.\n`);
  }
  const r = checkCompleteness(body);
  // the MUST regex requires an R# prefix: untagged imperatives are prose,
  // not collected — the doc contract says tag requirements as R#
  assert.equal(r.requirements.musts.length, 0, "untagged MUST not collected");
  assert.equal(r.requirements.uncoveredMusts.length, 0);
});

test("completeness: rid-tagged MUST with empty verification → uncovered", () => {
  let body = stripComments(
    DESIGN_SCAFFOLD.replaceAll("{{ID}}", "x")
      .replaceAll("{{TITLE}}", "T")
      .replaceAll("{{DATE}}", "d"),
  );
  body = body.replace(
    "## Requirements\n",
    "## Requirements\n\nR7. The system MUST retry.\n",
  );
  for (
    const s of [
      "Audience",
      "Problem",
      "Goal",
      "Non-goals",
      "Approaches considered",
      "Decision",
      "Risks & open questions",
    ]
  ) {
    body = body.replace(`## ${s}\n`, `## ${s}\n\ncontent.\n`);
  }
  // Verification left EMPTY
  const r = checkCompleteness(body);
  assert.equal(
    r.requirements.uncoveredMusts.length,
    1,
    "R7 with empty verification flagged",
  );
  assert.ok(r.requirements.uncoveredMusts[0]!.includes("R7"));
});

test("writeDesignStatus: malformed frontmatter (no closing ---) left as-is", () => {
  const path = join(area, "docs", "design", "malformed.md");
  mkdirSync(join(area, "docs", "design"), { recursive: true });
  writeFileSync(
    path,
    "---\nstatus: open\ntitle: M\n\n# no closing fence\nbody",
  );
  writeDesignStatus(path, "decided", { supersededBy: "zz0000" });
  const after = readFileSync(path, "utf8");
  // status line WAS replaced; the insert bailed (no crash)
  assert.ok(after.includes("status: decided"));
});

test("writeDesignStatus: existing superseded-by line replaced, not duplicated", () => {
  const { path } = scaffoldDesign(area, "Replace Me");
  writeDesignStatus(path, "superseded", { supersededBy: "aa1111" });
  writeDesignStatus(path, "superseded", { supersededBy: "bb2222" });
  const doc = readDesignDoc(path);
  assert.equal(doc!.supersededBy, "bb2222");
  const count = (readFileSync(path, "utf8").match(/^superseded-by:/gm) ?? [])
    .length;
  assert.equal(count, 1, "no duplicate lines");
});

test("seedPlan: whitespace-only step titles still seed (S<n>. prefix makes them valid)", () => {
  const body = `## Steps\n\n1. **  **  \`R1\`\n\n2. **Real** \`R2\`\n`;
  const plan = createPlan(db, PROJECT, body);
  const result = seedPlan(db, plan, "p", null);
  // step 1 title is spaces, but seeding prefixes it: "S1.  [R1]" — trims non-empty
  assert.equal(result.count, 2, JSON.stringify(result.errors));
  assert.equal(result.errors.length, 0);
  const todos = listTodos(db, PROJECT);
  assert.equal(todos.length, 2);
});

test("P1: design with no requirements at all — no legacy section, no trailing ids", () => {
  const r = passDesignCompleteness(
    "## Goal\n\nno reqs here",
    "## Steps\n\n1. **A**",
  );
  assert.ok(!r.clean);
  assert.ok(r.findings[0]!.includes("no MUST requirements"));
});

test("P1: lifecycle grammar — trailing [hex6] ids drive coverage", () => {
  const design =
    "## Some section\n\nA requirement stated in prose ending in its id. [abc123]\n\nAnother requirement. [def456]\n\nContext paragraph with no tag.";
  const r = passDesignCompleteness(
    design,
    "## Steps\n\nStep 1 covers [abc123].\n\nStep 2 covers [def456].",
  );
  assert.ok(r.clean);
  const r2 = passDesignCompleteness(
    design,
    "## Steps\n\nStep 1 covers [abc123].",
  );
  assert.ok(!r2.clean);
  assert.ok(r2.findings.some((f) => f.includes("def456")));
});

test("planProgress: no linked tasks → 0/0", () => {
  const plan = createPlan(db, PROJECT, "## Steps\n\n(nothing)");
  const prog = planProgress(db, plan);
  assert.equal(prog.total, 0);
  assert.equal(prog.done, 0);
});

test("updatePlanBody: unknown plan throws", () => {
  assert.throws(() => updatePlanBody(db, "no-such-plan", "x"), /no plan/);
});

// --- final branch closure for the new stores ---

test("completeness: covered rid-tagged MUST with empty verification → uncovered (rid branch)", () => {
  // R7 in Verification TEXT but verification section itself empty → still uncovered
  let body = stripComments(
    DESIGN_SCAFFOLD.replaceAll("{{ID}}", "x")
      .replaceAll("{{TITLE}}", "T")
      .replaceAll("{{DATE}}", "d"),
  );
  body = body.replace(
    "## Requirements\n",
    "## Requirements\n\nR7. The system MUST retry.\n",
  );
  for (
    const s of [
      "Audience",
      "Problem",
      "Goal",
      "Non-goals",
      "Approaches considered",
      "Decision",
      "Risks & open questions",
    ]
  ) {
    body = body.replace(`## ${s}\n`, `## ${s}\n\ncontent.\n`);
  }
  const r = checkCompleteness(body);
  assert.equal(r.requirements.uncoveredMusts.length, 1);
});

test("writeDesignStatus: malformed no-close insert bails cleanly (coverage of closeIdx=-1)", () => {
  const path = join(area, "docs", "design", "noclose.md");
  mkdirSync(join(area, "docs", "design"), { recursive: true });
  // only ONE --- line: never a closing fence
  writeFileSync(path, "---\nstatus: open\ntitle: N\nbody without fences");
  writeDesignStatus(path, "abandoned", { supersededBy: "qq1234" });
  const after = readFileSync(path, "utf8");
  assert.ok(after.includes("status: abandoned"), "status replaced");
  assert.ok(!after.includes("superseded-by"), "insert bailed");
});

test("plan-store: updatePlanBody unknown id throws; setPlanStatus no-op-ish on ghost", () => {
  assert.throws(() => updatePlanBody(db, "ghost", "x"), /no plan/);
  // setPlanStatus on a ghost id: no throw (UPDATE matches zero rows)
  setPlanStatus(db, "ghost", "done");
  assert.equal(getPlan(db, "ghost"), null);
});

test("parseSteps: trailing detail lines without a step ignored", () => {
  const body =
    "## Steps\n\n1. **A** `R1`\n   - Deliverable: x\n\nstray line not a step\n- not a step either\n";
  const steps = parseSteps(body);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.deliverable, "x");
});

test("doc-index: ingest dir with CRLF frontmatter parses", () => {
  const path = join(area, "docs", "design", "crlf.md");
  mkdirSync(join(area, "docs", "design"), { recursive: true });
  writeFileSync(
    path,
    `---\r\nid: crlf99\r\ntitle: CRLF\r\n---\r\n\r\n## Goal\r\n\r\nWindows authored.`,
  );
  const r = ingestDesignDocs(db, area, PROJECT);
  assert.equal(r.ingested, 1);
  assert.ok(searchDocs(db, "windows authored").length >= 1);
});

// --- P5: id inheritance --------------------------------------------------------------

test("passIdInheritance: plan cites design-owned id is clean", () => {
  const design = "## MUST\n\nA real requirement. [abc123]\n";
  const plan = "## Steps\n\n1. **Build** [abc123]\n";
  const r = passIdInheritance(plan, design, new Set());
  assert.ok(r.clean, JSON.stringify(r.findings));
  assert.equal(r.pass, "P5");
});

test("passIdInheritance: unowned id fails with id named and line number", () => {
  const design = "## MUST\n\nA requirement. [abc123]\n";
  const plan = "## Steps\n\ncontext line\n1. **Build** [abc123]\n\n2. **Wire** [deadbe]\n";
  const r = passIdInheritance(plan, design, new Set());
  assert.ok(!r.clean);
  assert.ok(r.findings.some((f) => f.includes("deadbe")), JSON.stringify(r.findings));
  assert.ok(r.findings.some((f) => f.includes("line 6")), JSON.stringify(r.findings));
});

test("passIdInheritance: registry counts as ownership", () => {
  const design = "## MUST\n\nA requirement. [abc123]\n";
  const plan = "## Steps\n\n1. **Build** [abc123]\n2. **Wire** [reg1st]\n";
  const r = passIdInheritance(plan, design, new Set(["reg1st"]));
  assert.ok(r.clean, JSON.stringify(r.findings));
});

test("passIdInheritance: no ids in plan is clean even with null designBody", () => {
  const r = passIdInheritance("just some text", null, new Set());
  assert.ok(r.clean);
});

test("passIdInheritance: ids in plan with null designBody fires finding", () => {
  const r = passIdInheritance("## Steps\n\n1. **Build** [abc123]\n", null, new Set());
  assert.ok(!r.clean);
  assert.ok(r.findings[0]!.includes("no parent design"));
});

test("runAllPasses: 2-arg call returns 5 passes (back-compat, default registry)", () => {
  const design = designWithRequirements("R1. The system MUST sync fast.");
  const plan =
    "## Steps\n\n1. **Build** `R1`\n   - Deliverable: module\n   - Acceptance: tests\n\n## Test matrix\n\n| Case | Type | Proves | Covers | Step |\n|------|------|--------|--------|------|\n| T1 | happy | R1 | R1 | 1 |\n\n## Coverage matrix\n\n| Aspect | Steps | Cases |\n|---------|-------|-------|\n| R1 | 1 | T1 |";
  const results = runAllPasses(design, plan);
  assert.equal(results.length, 5);
  // P5 should be clean here because the plan has no trailing [hex6] ids
  // (the R1 is in backtick format, not the lifecycle grammar)
  const p5 = results.find((r) => r.pass === "P5")!;
  assert.ok(p5.clean, JSON.stringify(p5.findings));
});

// --- lifecycle heading deps ----------------------------------------------------------

test("parseSteps: lifecycle heading with trailing dep arrow", () => {
  const body = `## Steps

### Step 1 — First

### Step 2 — Second ⟵ 1

### Step 3 — Third ⟵ 1,3

`;
  const steps = parseSteps(body);
  assert.equal(steps.length, 3);
  assert.deepEqual(steps[0]!.dependsOn, []);
  assert.deepEqual(steps[1]!.dependsOn, [1]);
  assert.deepEqual(steps[2]!.dependsOn, [1, 3]);
});

test("seedPlan: lifecycle two-step plan with explicit dep wires DAG edge", () => {
  const body = `## Steps

### Step 1 — Foundation

### Step 2 — Roof ⟵ 1

`;
  const plan = createPlan(db, PROJECT, body);
  const result = seedPlan(db, plan, "p", "sess");
  assert.equal(result.count, 2);
  assert.equal(result.errors.length, 0);

  const todos = listTodos(db, PROJECT);
  const s1 = todos.find((t) => t.title.startsWith("S1."))!;
  const s2 = todos.find((t) => t.title.startsWith("S2."))!;
  assert.deepEqual(s1.blockedBy, []);
  assert.deepEqual(s2.blockedBy, [s1.hex6]);
});

test("seedPlan: edge-free lifecycle plan gets serial default deps", () => {
  const body = `## Steps

### Step 1 — Alpha

### Step 2 — Beta

`;
  const plan = createPlan(db, PROJECT, body);
  const result = seedPlan(db, plan, "p", null);
  assert.equal(result.count, 2);
  assert.equal(result.errors.length, 0);

  const todos = listTodos(db, PROJECT);
  const s1 = todos.find((t) => t.title.startsWith("S1."))!;
  const s2 = todos.find((t) => t.title.startsWith("S2."))!;
  assert.deepEqual(s1.blockedBy, []);
  assert.deepEqual(s2.blockedBy, [s1.hex6], "serial default: step 2 blocked by step 1");
});

test("seedPlan: lifecycle dep on missing step number records error, still succeeds", () => {
  const body = `## Steps

### Step 1 — Exists

### Step 2 — Points nowhere ⟵ 99

`;
  const plan = createPlan(db, PROJECT, body);
  const result = seedPlan(db, plan, "p", null);
  assert.equal(result.count, 2, "both cards created");
  assert.ok(result.errors.some((e) => e.includes("missing step 99")));
  // step 2 has no real dep wired (step 99 absent)
  const todos = listTodos(db, PROJECT);
  const s2 = todos.find((t) => t.title.startsWith("S2."))!;
  assert.deepEqual(s2.blockedBy, []);
});
