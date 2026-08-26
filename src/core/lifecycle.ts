/**
 * Lifecycle coverage map: design-id extraction (design 005 — the identifier
 * grammar and design-prose sections).
 *
 * Pure functions, no side effects. The one pattern the harness ever needs,
 * applied at line-ends across design docs, plan rows, DAG anchors, and JUnit
 * testcase names. A mid-line bracketed hex never matches.
 */

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
