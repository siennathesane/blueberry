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
import { hex6Of } from "./todo-store.ts";

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
