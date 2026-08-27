/**
 * Lifecycle coverage map: design-id extraction and registry (design 005).
 *
 * Pure extraction functions plus stateful registry operations backed by
 * blueberry.db. The one pattern the harness ever needs, applied at line-ends
 * across design docs, plan rows, DAG anchors, and JUnit testcase names.
 * A mid-line bracketed hex never matches.
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { hex6Of } from "./todo-store.ts";
import { stripComments } from "./design-store.ts";
import type { LinkCapability } from "./deeplink.ts";
import { renderCardRef } from "./deeplink.ts";

/** Trailing six-lowercase-hex id at end of line — the single join pattern. */
export const ID_LINE_PATTERN = /\[([0-9a-f]{6})\]\s*$/;

/** Global multiline clone for whole-document scans (matchAll-safe; the
 * exported pattern stays stateless for single-line test/exec). */
const ID_LINE_GLOBAL = new RegExp(ID_LINE_PATTERN.source, "gm");

/**
 * Every id matched at a line-end, in document order, de-duplicated
 * preserving first occurrence. Empty input → [].
 */
export function extractIds(markdown: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of markdown.matchAll(ID_LINE_GLOBAL)) {
    const id = m[1]!;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Requirement paragraphs from markdown. A paragraph is a blank-line-delimited
 * block (split on /\n\s*\n/) whose final line ends with an id. Returned text
 * is the full block trimmed, id included, verbatim. Blocks whose final line
 * carries no id (context, rationale) yield nothing.
 */
export function extractIdParagraphs(
  markdown: string,
): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  for (const block of markdown.split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (trimmed === "") continue;
    const last = trimmed.split("\n").pop()!;
    const id = ID_LINE_PATTERN.exec(last)?.[1];
    if (id) out.push({ id, text: trimmed });
  }
  return out;
}

// --- registry ----------------------------------------------------------------

export interface MintedId {
  id: string;
}

/**
 * Draw a collision-free six-lowercase-hex id.
 *
 * Collides against: lifecycle_ids (any status), todo-card hex6s, and
 * opts.exclude. Retries up to 50 draws; throws if all collide.
 */
export function mintId(
  db: DatabaseSync,
  opts: { exclude?: string[]; rng?: () => string } = {},
): string {
  const todoHexes = new Set(
    (db.prepare("SELECT id FROM todos").all() as Array<{ id: string }>)
      .map((r) => hex6Of(r.id)),
  );
  const regIds = new Set(
    (db
      .prepare("SELECT id FROM lifecycle_ids")
      .all() as Array<{ id: string }>).map((r) => r.id),
  );
  const excludeSet = new Set(opts.exclude ?? []);

  const rng = opts.rng ?? (() => randomUUID());
  for (let i = 0; i < 50; i++) {
    const hex6 = hex6Of(rng());
    if (
      !regIds.has(hex6) &&
      !todoHexes.has(hex6) &&
      !excludeSet.has(hex6)
    ) {
      return hex6;
    }
  }
  throw new Error("lifecycle: mintId exhausted 50 attempts without a free id");
}

/**
 * Record a minted id into lifecycle_ids. Throws on duplicate (UNIQUE).
 */
export function registerId(
  db: DatabaseSync,
  id: string,
  meta: { designDoc: string; paragraph: string },
): void {
  db
    .prepare(
      "INSERT INTO lifecycle_ids (id, design_doc, paragraph, minted_at) VALUES (?, ?, ?, ?)",
    )
    .run(id, meta.designDoc, meta.paragraph, new Date().toISOString());
}

/** Mark an id as retired. Retired ids are never re-minted. */
export function retireId(db: DatabaseSync, id: string): void {
  db.prepare("UPDATE lifecycle_ids SET status = 'retired' WHERE id = ?").run(
    id,
  );
}

/**
 * True iff the id is absent from lifecycle_ids (any status, including retired)
 * and absent from todo-card hex6s and not in exclude.
 */
export function idIsFree(
  db: DatabaseSync,
  id: string,
  exclude: string[] = [],
): boolean {
  const row = db
    .prepare("SELECT 1 FROM lifecycle_ids WHERE id = ? LIMIT 1")
    .get(id) as Record<string, unknown> | undefined;
  if (row) return false;

  const todos = db
    .prepare("SELECT id FROM todos")
    .all() as Array<{ id: string }>;
  for (const r of todos) {
    if (hex6Of(r.id) === id) return false;
  }

  if (exclude.includes(id)) return false;
  return true;
}

// --- decide-time minting (design 005 §Registry) --------------------------------

/**
 * Mint + register ids for every untagged requirement paragraph in the
 * `## Requirements` section of a design body, returning the rewritten body
 * with ` [hex6]` appended to each newly tagged paragraph.
 *
 * Already-tagged paragraphs stay verbatim and are registered if absent —
 * re-running on a decided doc is idempotent (the UNIQUE duplicate is
 * swallowed). Comment-only paragraphs are scaffold prompts, not
 * requirements — never minted. No `## Requirements` section → nothing
 * minted, body returned unchanged. Everything outside the section is
 * byte-preserved.
 */
export function mintRequirementsFor(
  db: DatabaseSync,
  designDocPath: string,
  body: string,
  opts: { home?: string } = {},
): { minted: string[]; rewritten: string } {
  const heading = /^##[ \t]+Requirements[ \t]*$/m.exec(body);
  if (!heading) return { minted: [], rewritten: body };
  const contentStart = heading.index + heading[0].length;
  const after = body.slice(contentStart);
  const next = /^##\s/m.exec(after);
  const tail = next ? next.index : after.length;
  const docBasename = basename(designDocPath);

  const minted: string[] = [];
  const rebuilt: string[] = [];
  // split keeping the blank-line separators, so untouched whitespace and
  // paragraph-internal newlines round-trip verbatim
  const parts = after.slice(0, tail).split(/(\n\s*\n)/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i % 2 === 1) {
      rebuilt.push(part); // separator — pass through
      continue;
    }
    const trimmed = part.trim();
    if (trimmed === "" || stripComments(trimmed).trim() === "") {
      rebuilt.push(part); // context / scaffold comment — pass through
      continue;
    }
    const existing = ID_LINE_PATTERN.exec(trimmed.split("\n").pop()!)?.[1];
    if (existing) {
      try {
        registerId(db, existing, {
          designDoc: docBasename,
          paragraph: trimmed,
        });
      } catch {
        // UNIQUE violation — already registered; idempotent re-decide
      }
      rebuilt.push(part);
      continue;
    }
    const id = mintId(db, { exclude: minted });
    registerId(db, id, {
      designDoc: docBasename,
      paragraph: `${trimmed} [${id}]`,
    });
    minted.push(id);
    rebuilt.push(part.replace(/\s*$/, ` [${id}]`));
  }
  const rewritten = body.slice(0, contentStart) + rebuilt.join("") +
    after.slice(tail);
  return { minted, rewritten };
}

// --- verify seam (design 005 S9) -----------------------------------------------

export interface VerifyReport {
  /** True iff every extracted id has a registry row. */
  ok: boolean;
  /** Unique ids found across all docs (deduped, first occurrence kept). */
  totalIds: number;
  /** Number of .md docs scanned. */
  docs: number;
  /** Ids missing from lifecycle_ids, with the doc that carries them. */
  unregistered: Array<{ id: string; doc: string }>;
}

/**
 * Lifecycle integrity: every id-paragraph in every .md under dir must be
 * registered in lifecycle_ids. Pure scan — reports, never mutates.
 */
export function verifyDocs(dir: string, db: DatabaseSync): VerifyReport {
  const registered = new Set(
    (db.prepare("SELECT id FROM lifecycle_ids").all() as Array<
      { id: string }
    >).map((r) => r.id),
  );
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  const seen = new Set<string>();
  const unregistered: Array<{ id: string; doc: string }> = [];
  for (const f of files) {
    for (
      const { id } of extractIdParagraphs(readFileSync(join(dir, f), "utf8"))
    ) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!registered.has(id)) unregistered.push({ id, doc: f });
    }
  }
  return {
    ok: unregistered.length === 0,
    totalIds: seen.size,
    docs: files.length,
    unregistered,
  };
}

// --- JUnit ingestion (design 005 §Ingestion) ----------------------------------

export interface JunitCase {
  testName: string;
  className: string | null;
  outcome: "pass" | "fail";
  id: string | null;
}

/** Decode the XML escapes JUnit names can carry. */
function xmlUnescape(v: string): string {
  return v
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Extract a double-quoted attribute value from a tag string. Raw quotes
 * never appear inside the value (they arrive as &quot;). */
function attrOf(tag: string, key: string): string | null {
  const m = new RegExp(`${key}="([^"]*)"`).exec(tag);
  return m ? xmlUnescape(m[1]!) : null;
}

/**
 * Minimal JUnit testcase scanner. No DOMParser in Deno; no deps — the
 * flat `<testcase …>` shape from `deno test --junit-path` is regular enough
 * to scan by fragment. Self-closing cases pass; `<failure`/`<error` children
 * fail. The trailing [hex6] of a tagged name is joined via ID_LINE_PATTERN.
 */
export function parseJunit(xml: string): JunitCase[] {
  const out: JunitCase[] = [];
  const parts = xml.split(/<testcase\b/).slice(1);
  for (const part of parts) {
    const openEnd = part.indexOf(">");
    if (openEnd < 0) continue;
    const tag = part.slice(0, openEnd);
    const selfClosing = tag.endsWith("/");
    const name = attrOf(tag, "name");
    if (!name) continue;
    const className = attrOf(tag, "classname");
    const body = selfClosing ? "" : part.slice(openEnd + 1);
    const outcome: "pass" | "fail" = /<(failure|error)\b/.test(body)
      ? "fail"
      : "pass";
    const id = ID_LINE_PATTERN.exec(name)?.[1] ?? null;
    out.push({ testName: name, className, outcome, id });
  }
  return out;
}

// --- Failure-only context injection (design 005 §Failure-only context) -----

/**
 * Build a plain-text failure block for one design id.
 *
 * Looks up the id in the lifecycle_ids registry, fetches open (non-done/dropped)
 * cards under its anchor, and composes a compact block.
 */
export function buildFailureBlock(
  db: DatabaseSync,
  id: string,
  opts?: { cap?: LinkCapability; slug?: string; tty?: boolean },
): string {
  const row = db
    .prepare(
      "SELECT design_doc, paragraph, status FROM lifecycle_ids WHERE id = ?",
    )
    .get(id) as
      | { design_doc: string; paragraph: string; status: string }
      | undefined;
  if (!row) {
    return `[${id}] no registry entry — unregistered id in a failing test`;
  }
  const lines: string[] = [
    `[${id}] requirement failed`,
    row.paragraph,
    `[${row.design_doc}](docs/design/${row.design_doc})`,
  ];
  const openCards = db
    .prepare(
      `SELECT t.id, t.title, t.stage FROM todos t
       WHERE t.design_id = ? AND t.stage NOT IN ('done','dropped')
       UNION
       SELECT c.id, c.title, c.stage FROM todos c
       JOIN todo_deps d ON d.todo_id = c.id
       JOIN todos a ON a.id = d.dep_id
       WHERE a.design_id = ? AND c.stage NOT IN ('done','dropped')`,
    )
    .all(id, id) as Array<{ id: string; title: string; stage: string }>;
  for (const card of openCards) {
    const h = hex6Of(card.id);
    if (opts?.cap && opts.slug) {
      lines.push(renderCardRef({ hex6: h, title: card.title, stage: card.stage, slug: opts.slug }, opts.cap, { tty: opts.tty ?? false }));
    } else {
      lines.push(`open: ${h} ${card.title}`);
    }
  }
  lines.push(`status: ${row.status}`);
  return lines.join("\n");
}

/**
 * Collect failure blocks for a list of ids, with a cap on full blocks.
 *
 * First `cap` unique ids (preserving first-occurrence order) get full blocks;
 * remaining ids go to overflowIds. Empty input → empty everything.
 */
export function collectFailureBlocks(
  db: DatabaseSync,
  ids: string[],
  cap = 3,
  opts?: { linkCap?: LinkCapability; slug?: string; tty?: boolean },
): { blocks: string[]; overflowIds: string[] } {
  if (ids.length === 0) return { blocks: [], overflowIds: [] };
  // Dedupe preserving first occurrence
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }
  const blocks = unique.slice(0, cap).map((id) =>
    buildFailureBlock(db, id, opts?.linkCap ? { cap: opts.linkCap, slug: opts.slug, tty: opts.tty } : undefined),
  );
  const overflowIds = unique.slice(cap);
  return { blocks, overflowIds };
}

// --- Lcov opportunistic read (design 005 §Ingestion) --------------------------

export interface LcovSummary {
  file: string;
  linesHit: number;
  linesFound: number;
  mtime: string;
}

/**
 * Read and aggregate an lcov info file. Returns null if the file is absent,
 * unreadable, or contains no LF: lines (treated as malformed). Never throws.
 */
export function readLcovIfPresent(path: string): LcovSummary | null {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let linesFound = 0;
  let linesHit = 0;
  for (const line of content.split("\n")) {
    const lfMatch = /^LF:(\d+)/.exec(line);
    if (lfMatch) {
      linesFound += Number(lfMatch[1]);
      continue;
    }
    const lhMatch = /^LH:(\d+)/.exec(line);
    if (lhMatch) {
      linesHit += Number(lhMatch[1]);
    }
  }
  if (linesFound === 0) return null;
  return {
    file: path,
    linesHit,
    linesFound,
    mtime: stat.mtime.toISOString(),
  };
}
