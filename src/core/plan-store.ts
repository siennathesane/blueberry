/**
 * Plan lifecycle store (§Plan layer): decomposition parsing, DAG seeding,
 * consistency passes. Plans are DB-native rows (§Design: DB-invisible for
 * plan-only; design_id NULL when no doc).
 */
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { hex6Of } from "./todo-store.ts";
import { addDep, createTodo, listTodos } from "./todo-store.ts";
import { indexPlanDoc, planUri } from "./doc-index.ts";
import { ID_LINE_PATTERN } from "./lifecycle.ts";

export type PlanStatus =
  | "draft"
  | "approved"
  | "building"
  | "done"
  | "abandoned";

export interface PlanRow {
  id: string;
  design_id: string | null;
  project_id: string;
  status: PlanStatus;
  rev: number;
  body: string;
  created_at: string;
  updated_at: string;
  seeded_at: string | null;
  seeded_count: number | null;
}

// --- step parsing -------------------------------------------------------------------

export interface PlanStep {
  n: number; // 1-based step number
  title: string;
  requirements: string[]; // R# tags
  dependsOn: number[]; // step numbers
  deliverable: string | null;
  acceptance: string | null;
}

/**
 * Parse the ## Steps section into structured steps.
 * Format per step:
 *   N. **Title** `R1,R3` ⟵ 2
 *      - Deliverable: ...
 *      - Acceptance: ...
 */
export function parseSteps(body: string): PlanStep[] {
  const stripped = body.replace(/<!--[\s\S]*?-->/g, "");
  const stepsMatch = /^##\s+Steps\s*$/m.exec(stripped);
  if (!stepsMatch) return [];
  const after = stripped.slice(stepsMatch.index + stepsMatch[0].length);
  const nextSection = /^##\s/m.exec(after);
  const section = nextSection ? after.slice(0, nextSection.index) : after;

  const steps: PlanStep[] = [];
  // split on numbered list items at line starts (legacy) or
  // `### Step N — Title [hex6]` headings (lifecycle grammar)
  const lines = section.split("\n");
  let current: Partial<PlanStep> | null = null;
  for (const line of lines) {
    const headingMatch =
      /^###\s+Step\s+(\d+)\s+[—–-]\s+(.+?)\s*(?:\[([0-9a-f]{6})\])?\s*(?:⟵\s*([\d,\s]+))?\s*$/
        .exec(line.trim());
    if (headingMatch) {
      if (current && current.n !== undefined) steps.push(current as PlanStep);
      current = {
        n: Number(headingMatch[1]),
        title: headingMatch[2]!,
        requirements: headingMatch[3] ? [headingMatch[3]] : [],
        dependsOn: (headingMatch[4] ?? "")
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0),
      };
      continue;
    }
    const headMatch =
      /^(\d+)\.\s+\*\*(.+?)\*\*(?:\s+`([R\d,\s]+)`)?(?:\s+⟵\s*([\d,\s]+))?\s*$/
        .exec(
          line.trim(),
        );
    if (headMatch) {
      if (current && current.n !== undefined) steps.push(current as PlanStep);
      current = {
        n: Number(headMatch[1]),
        title: headMatch[2]!,
        requirements: (headMatch[3] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== ""),
        dependsOn: (headMatch[4] ?? "")
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0),
      };
      continue;
    }
    if (current) {
      const del = /^-\s+Deliverable:\s*(.+)$/.exec(line.trim());
      if (del) current.deliverable = del[1]!;
      const acc = /^-\s+Acceptance:\s*(.+)$/.exec(line.trim());
      if (acc) current.acceptance = acc[1]!;
      // lifecycle grammar: `Acceptance GWT [id]: given… when… then…`
      const gwt = /^Acceptance GWT \[([0-9a-f]{6})\]:\s*(.+)$/.exec(
        line.trim(),
      );
      if (gwt) current.acceptance = gwt[2]!;
    }
  }
  if (current && current.n !== undefined) steps.push(current as PlanStep);
  return steps;
}

// --- store ops ----------------------------------------------------------------------

export function createPlan(
  db: DatabaseSync,
  projectId: string,
  body: string,
  opts: { designId?: string | null } = {},
): PlanRow {
  const id = randomUUID();
  const now = new Date().toISOString();
  db
    .prepare(
      "INSERT INTO plans (id, design_id, project_id, status, rev, body, created_at, updated_at) VALUES (?, ?, ?, 'draft', 1, ?, ?, ?)",
    )
    .run(id, opts.designId ?? null, projectId, body, now, now);
  return getPlan(db, id)!;
}

/** Repoint a plan's design linkage (draft-time grabs the open design;
 * the plan's own parent declaration is authoritative once set). */
export function setPlanDesignId(
  db: DatabaseSync,
  planId: string,
  designId: string,
): void {
  db
    .prepare(
      "UPDATE plans SET design_id = ?, updated_at = ? WHERE id = ?",
    )
    .run(designId, new Date().toISOString(), planId);
}

export function getPlan(db: DatabaseSync, id: string): PlanRow | null {
  const row = db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    id: String(row["id"]),
    design_id: row["design_id"] === null ? null : String(row["design_id"]),
    project_id: String(row["project_id"]),
    status: String(row["status"]) as PlanStatus,
    rev: Number(row["rev"]),
    body: String(row["body"]),
    created_at: String(row["created_at"]),
    updated_at: String(row["updated_at"]),
    seeded_at: row["seeded_at"] === null ? null : String(row["seeded_at"]),
    seeded_count: row["seeded_count"] === null
      ? null
      : Number(row["seeded_count"]),
  };
}

/** The draft/approved/building plan for a project (latest first). */
export function activePlan(
  db: DatabaseSync,
  projectId: string,
): PlanRow | null {
  const row = db
    .prepare(
      "SELECT id FROM plans WHERE project_id = ? AND status IN ('draft','approved','building') ORDER BY updated_at DESC LIMIT 1",
    )
    .get(projectId) as { id: string } | undefined;
  return row ? getPlan(db, row.id) : null;
}

export function updatePlanBody(
  db: DatabaseSync,
  id: string,
  body: string,
  bumpRev = true,
): void {
  const plan = getPlan(db, id);
  if (!plan) throw new Error(`no plan '${id}'`);
  db
    .prepare("UPDATE plans SET body = ?, rev = ?, updated_at = ? WHERE id = ?")
    .run(body, bumpRev ? plan.rev + 1 : plan.rev, new Date().toISOString(), id);
  // keep the FTS index fresh
  indexPlanDoc(db, plan.project_id, hex6Of(id), body);
}

export function setPlanStatus(
  db: DatabaseSync,
  id: string,
  status: PlanStatus,
): void {
  db
    .prepare("UPDATE plans SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), id);
}

// --- seeding -------------------------------------------------------------------------

export interface SeedResult {
  count: number;
  todoIds: string[]; // hex6 ids of created tasks
  errors: string[];
}

/**
 * Parse a plan's Steps and seed the DAG: one task per step, deps preserved,
 * titles prefixed with the step number. Requirements tags land in the task
 * title suffix so lineage survives the board.
 */
export function seedPlan(
  db: DatabaseSync,
  plan: PlanRow,
  _projectSlug: string,
  sessionId: string | null,
): SeedResult {
  const steps = parseSteps(plan.body);
  const result: SeedResult = { count: 0, todoIds: [], errors: [] };
  const stepToHex = new Map<number, string>();

  for (const step of steps) {
    const reqTag = step.requirements.length > 0
      ? ` [${step.requirements.join(",")}]`
      : "";
    const created = createTodo(
      db,
      plan.project_id,
      `S${step.n}. ${step.title}${reqTag}`,
      {
        sessionId,
      },
    );
    if (!created.ok || !created.todo) {
      result.errors.push(`step ${step.n}: ${created.reason}`);
      continue;
    }
    stepToHex.set(step.n, created.todo.hex6);
    result.todoIds.push(created.todo.hex6);
    result.count++;
  }

  // determine if any step declares explicit deps
  const anyExplicitDeps = steps.some((s) => s.dependsOn.length > 0);

  // deps: after all tasks exist (avoids ordering sensitivity)
  for (const step of steps) {
    const myHex = stepToHex.get(step.n);
    if (!myHex) continue;
    // serial-chain default: when no step declares any dependsOn,
    // wire each card to its predecessor in step-number order
    let deps = step.dependsOn;
    if (!anyExplicitDeps && step.n > 1) {
      deps = [step.n - 1];
    }
    for (const dep of deps) {
      const depHex = stepToHex.get(dep);
      if (!depHex) {
        result.errors.push(`step ${step.n}: dep on missing step ${dep}`);
        continue;
      }
      const res = addDep(db, plan.project_id, myHex, depHex, { sessionId });
      if (!res.ok) result.errors.push(`step ${step.n} ⟵ ${dep}: ${res.reason}`);
    }
  }

  const now = new Date().toISOString();
  db
    .prepare(
      "UPDATE plans SET status = 'building', seeded_at = ?, seeded_count = ? WHERE id = ?",
    )
    .run(now, result.count, plan.id);
  indexPlanDoc(db, plan.project_id, hex6Of(plan.id), plan.body);
  return result;
}

/** Plan progress: linked tasks by title prefix S<n>. */
export function planProgress(
  db: DatabaseSync,
  plan: PlanRow,
): {
  total: number;
  done: number;
  tasks: Array<{ hex6: string; title: string; stage: string }>;
} {
  const all = listTodos(db, plan.project_id);
  const linked = all.filter((t) => /^S\d+\./.test(t.title));
  let done = 0;
  for (const t of linked) {
    if (t.stage === "done" || t.stage === "dropped") done++;
  }
  return {
    total: linked.length,
    done,
    tasks: linked.map((t) => ({
      hex6: t.hex6,
      title: t.title,
      stage: t.stage,
    })),
  };
}

// --- consistency passes ----------------------------------------------------------------

export interface PassResult {
  pass: string;
  clean: boolean;
  findings: string[];
}

/**
 * Requirement extraction — dual grammar.
 *
 * Legacy: `## Requirements` section with `R#.` numbered MUST lines.
 * 005+: any section; requirement = paragraph whose final line ends with
 * a minted design id ` [hex6]`. Returns ids each grammar finds, preferring
 * the id grammar when both are present.
 */
export function extractRequirementIds(
  designBody: string,
): { ids: string[]; grammar: "legacy" | "lifecycle" } {
  const stripped = designBody.replace(/<!--[\s\S]*?-->/g, "");
  const trailing = [...stripped.matchAll(/\[([0-9a-f]{6})\]\s*$/gm)].map((m) =>
    m[1]!
  );
  if (trailing.length > 0) {
    return { ids: [...new Set(trailing)], grammar: "lifecycle" };
  }

  const reqSection = /^##\s+Requirements\s*$/m.exec(stripped);
  if (!reqSection) return { ids: [], grammar: "legacy" };
  const after = stripped.slice(reqSection.index + reqSection[0].length);
  const reqContent = (
    /^##\s/m.exec(after) ? after.slice(0, /^##\s/m.exec(after)!.index!) : after
  ).trim();
  const legacy = [
    ...reqContent.matchAll(/^(R\d+)\.\s+.*\bMUST\b(?! NOT)/gm),
  ].map((m) => m[1]!);
  return { ids: legacy, grammar: "legacy" };
}

/** P1: design completeness — every requirement covered by ≥1 step. */
export function passDesignCompleteness(
  designBody: string,
  planBody: string,
): PassResult {
  const findings: string[] = [];
  const { ids, grammar } = extractRequirementIds(designBody);
  if (ids.length === 0) {
    findings.push("no MUST requirements found — design has no hard contract");
  }
  for (const rid of ids) {
    const cited = grammar === "lifecycle"
      ? planBody.includes(`[${rid}]`)
      : new RegExp(`\`${rid}(,\\d+)?\``).test(planBody) ||
        planBody.includes(`\`${rid}`);
    if (!cited) findings.push(`${rid}: MUST with no covering step`);
  }
  return { pass: "P1", clean: findings.length === 0, findings };
}

/** P2: plan purity — every step cites a requirement or is ledgered. */
export function passPlanPurity(planBody: string): PassResult {
  const findings: string[] = [];
  const steps = parseSteps(planBody);
  for (const s of steps) {
    if (s.requirements.length === 0) {
      findings.push(
        `step ${s.n} ("${s.title}") cites no requirement — cut, ledger, or supersede`,
      );
    }
  }
  return { pass: "P2", clean: findings.length === 0, findings };
}

/** P3: test completeness — every requirement has ≥1 test case; matrix exists. */
export function passTestCompleteness(
  designBody: string,
  planBody: string,
): PassResult {
  const findings: string[] = [];
  if (!/^##\s+Test matrix/m.test(planBody)) {
    findings.push("no Test matrix section");
  }
  const { ids } = extractRequirementIds(designBody);
  const matrixMatch = /^##\s+Test matrix/m.exec(planBody);
  const matrixBody = matrixMatch ? planBody.slice(matrixMatch.index) : "";
  for (const rid of ids) {
    if (!matrixBody.includes(rid)) {
      findings.push(`${rid}: no test case in matrix`);
    }
  }
  return { pass: "P3", clean: findings.length === 0, findings };
}

/** P4: dependency sanity — deps reference existing steps, no cycles (steps form a DAG). */
export function passDependencySanity(planBody: string): PassResult {
  const findings: string[] = [];
  const steps = parseSteps(planBody);
  const nums = new Set(steps.map((s) => s.n));
  const deps = new Map<number, number[]>();
  for (const s of steps) {
    deps.set(s.n, s.dependsOn);
    for (const d of s.dependsOn) {
      if (!nums.has(d)) {
        findings.push(`step ${s.n} depends on missing step ${d}`);
      }
    }
  }
  // cycle detection over steps
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const dfs = (n: number): void => {
    if (visited.has(n)) return;
    if (visiting.has(n)) {
      findings.push(`cycle detected involving step ${n}`);
      return;
    }
    visiting.add(n);
    for (const d of deps.get(n) ?? []) if (nums.has(d)) dfs(d);
    visiting.delete(n);
    visited.add(n);
  };
  for (const s of steps) dfs(s.n);
  return { pass: "P4", clean: findings.length === 0, findings };
}

/** P5: id inheritance — every trailing id in the plan is owned by the
 * parent design body or registered in lifecycle_ids. */
export function passIdInheritance(
  planBody: string,
  designBody: string | null,
  registryIds: Set<string>,
): PassResult {
  const findings: string[] = [];
  const globalPat = new RegExp(ID_LINE_PATTERN.source, "gm");

  // Collect plan ids with first-occurrence line numbers
  const planIds = new Map<string, number>(); // id → 1-based line
  const lines = planBody.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = ID_LINE_PATTERN.exec(lines[i]!);
    if (m && !planIds.has(m[1]!)) {
      planIds.set(m[1]!, i + 1);
    }
  }

  if (planIds.size === 0) return { pass: "P5", clean: true, findings: [] };

  if (designBody === null) {
    findings.push(
      "plan carries ids but no parent design — cannot verify inheritance",
    );
    return { pass: "P5", clean: false, findings };
  }

  // Collect design-owned ids
  const designIds = new Set<string>();
  for (const m of designBody.matchAll(globalPat)) {
    designIds.add(m[1]!);
  }

  const owned = new Set([...designIds, ...registryIds]);
  for (const [id, line] of planIds) {
    if (!owned.has(id)) {
      findings.push(
        `plan cites unowned id '${id}' — no design paragraph or registry entry owns it (line ${line})`,
      );
    }
  }
  return { pass: "P5", clean: findings.length === 0, findings };
}

/** P6: reference hygiene — sigil-free prose per design 006 §reference grammar.
 * Flags §, bare R\d+, todo: needles, and bare 00\d document numbers.
 * Skips fenced code blocks and table rows. */
export function passReferenceHygiene(planBody: string): PassResult {
  const findings: string[] = [];
  const lines = planBody.split("\n");
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Track fenced code blocks (lines between ``` fences)
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Skip table rows (the Test matrix legitimately carries id columns)
    if (line.trimStart().startsWith("|")) continue;

    // Helper: check if a position is inside a backtick code span.
    // Odd number of backticks before matchStart → inside a code span.
    const isInsideCodeSpan = (matchStart: number): boolean => {
      let count = 0;
      for (let j = 0; j < matchStart; j++) {
        if (line[j] === "`") count++;
      }
      return count % 2 === 1;
    };

    // Helper: check if a range overlaps any [text](url) markdown link.
    const isInsideMarkdownLink = (
      matchStart: number,
      matchEnd: number,
    ): boolean => {
      let j = 0;
      while (j < line.length) {
        const bracketIdx = line.indexOf("[", j);
        if (bracketIdx === -1) break;
        const closeBracket = line.indexOf("]", bracketIdx + 1);
        if (closeBracket === -1) break;
        // Check if followed by (...)
        if (
          closeBracket + 1 < line.length &&
          line[closeBracket + 1] === "("
        ) {
          const closeParen = line.indexOf(")", closeBracket + 2);
          if (closeParen !== -1) {
            if (matchStart <= closeParen && matchEnd > bracketIdx) {
              return true;
            }
            j = closeParen + 1;
            continue;
          }
        }
        j = closeBracket + 1;
      }
      return false;
    };

    // 1. § sigil anywhere in a non-exempt line (code spans exempt)
    const sectionHits = [...line.matchAll(/\u00a7/g)].filter((m) =>
      !isInsideCodeSpan(m.index ?? 0)
    );
    if (sectionHits.length > 0) {
      findings.push(
        `sigil § at line ${lineNum} — write the name and link instead`,
      );
    }

    // 2. Bare R\d+ (word boundary) — except inside code spans
    for (const m of line.matchAll(/R\d+\b/g)) {
      if (m.index !== undefined && !isInsideCodeSpan(m.index)) {
        findings.push(
          `bare requirement sigil '${
            m[0]
          }' at line ${lineNum} — write the name and link instead`,
        );
      }
    }

    // 3. todo: needles outside code spans
    for (const m of line.matchAll(/todo:[a-z0-9-]+\/[0-9a-f]{6}/g)) {
      if (m.index !== undefined && !isInsideCodeSpan(m.index)) {
        findings.push(
          `todo needle '${
            m[0]
          }' at line ${lineNum} — reference cards by name and link, or the bb:// deep link`,
        );
      }
    }

    // 4. Bare document numbers 00\d (code spans exempt)
    for (const m of line.matchAll(/\b00\d\b/g)) {
      if (isInsideCodeSpan(m.index ?? 0)) continue;
      if (m.index === undefined) continue;
      const matchStart = m.index;
      const matchEnd = matchStart + m[0]!.length;

      // Skip if inside a code span
      if (isInsideCodeSpan(matchStart)) continue;

      // Skip if inside a markdown link [text](url)
      if (isInsideMarkdownLink(matchStart, matchEnd)) continue;

      // Skip if followed by a dash (filename like 005-lifecycle...)
      const afterChar = line[matchEnd];
      if (afterChar === "-") continue;

      findings.push(
        `bare document number '${
          m[0]
        }' at line ${lineNum} — link the document instead`,
      );
    }
  }

  return { pass: "P6", clean: findings.length === 0, findings };
}

export function runAllPasses(
  designBody: string | null,
  planBody: string,
  registryIds: Set<string> = new Set(),
): PassResult[] {
  const passes: PassResult[] = [];
  if (designBody !== null) {
    passes.push(passDesignCompleteness(designBody, planBody));
  }
  passes.push(passPlanPurity(planBody));
  if (designBody !== null) {
    passes.push(passTestCompleteness(designBody, planBody));
  }
  passes.push(passDependencySanity(planBody));
  passes.push(passIdInheritance(planBody, designBody, registryIds));
  passes.push(passReferenceHygiene(planBody));
  return passes;
}

/** breadcrumb needle for plan transitions. */
export function planBreadcrumb(
  slug: string,
  hex6: string,
  title: string,
  transition: string,
): string {
  return `plan:${slug}/${hex6} · ${title} · ${transition}`;
}

export { planUri };
