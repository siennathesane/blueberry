/**
 * §Context composer — the three layers, two rails (DESIGN.md, REVISED:
 * zero-eviction rule).
 *
 * Rail discipline is structural in this module:
 *
 * - composeIdentity(): SYSTEM-PROMPT rail. Pure function of the capability
 *   probe; probed ONCE at session_start and frozen for the session. The
 *   zero-eviction invariant: identity bytes NEVER change mid-session —
 *   the test suite enforces it by composing across synthetic state churn.
 * - composeStateBlock() / composeDatetimeLine() / supersedeNudges():
 *   MESSAGE rail (ephemeral tail via the context event). Never persisted,
 *   never part of the cached prefix — volatile by design, zero cache cost.
 *
 * composeIdentity, composeStateBlock, composeDatetimeLine, supersedeNudges
 * are pure (no DB handles, no clock reads inside compose, no filesystem).
 * composeSystemPrompt and extractToolSurfaces read tool source files;
 * composeSystemPrompt delegates final assembly to the fork's
 * buildSystemPrompt.
 */

// ─── Layer 1: identity (frozen) ────────────────────────────────────────────

/** Capability probe result — captured once at session_start. */
export interface IdentityProbe {
  cwd: string;
  /** Languages with an installed LSP server (e.g. ["go", "rust"]). Empty = no bb_lsp surface. */
  lspLanguages: string[];
  /** Design lifecycle present: docs/design/ exists or a mode row is set. */
  hasDesignLifecycle: boolean;
  /** Any todos exist in the DAG. */
  hasTodos: boolean;
}

/**
 * Compose the identity block appended to the system prompt.
 * MUST be byte-stable for a given probe (no timestamps, no ordering churn:
 * languages are sorted before embedding). Frozen at session_start — never
 * recomputed mid-session.
 */
export function composeIdentity(probe: IdentityProbe): string {
  const lines: string[] = [];
  lines.push(
    "You are running inside blueberry — a coding harness with a work lifecycle (design → plan → implement) and a searchable, database-backed history. Needles like todo:<slug>/<hex6>, design:<slug>, and plan:<slug> are stable search keys: write them into breadcrumbs and summaries so future sessions can find this work.",
  );
  // communication directive (user, v0.3.0): own paragraph for prominence
  lines.push("You will speak with the user in simplified technical English.");
  // reference grammar (design 006): references are spoken names with links
  lines.push(
    "References are spoken names with working links: write [plain-English name](path) for documents and sections, bb://todo/<slug>/<hex6> for cards. Never write sigil shorthand (section marks, bare requirement numbers, lone document numbers) in prose — those forms belong to machines at line ends only. When no link can live, put the referenced content in-line instead of pointing at it.",
  );

  // Cross-tool orchestration — capability-gated: never mention a tool whose
  // surface isn't actually present.
  const orchestration: string[] = [];
  if (probe.lspLanguages.length > 0) {
    const langs = [...probe.lspLanguages].sort().join(", ");
    orchestration.push(
      `Navigation is LSP-first: for any symbol or code question (where is this defined, who calls it, what's the outline, does it compile) use bb_lsp — definitions, references, workspace symbols, diagnostics (servers installed: ${langs}). Raw grep/read is the FALLBACK when the language server has no answer, not the default.`,
    );
  }
  if (probe.lspLanguages.length > 0) {
    orchestration.push(
      "Past decisions and prior context live in history: that is bb_search's domain — context neighborhoods before re-deriving anything. Code questions go to bb_lsp; history questions go to bb_search.",
    );
  } else {
    orchestration.push(
      "Past decisions and prior context live in history: use bb_search with context neighborhoods before re-deriving anything.",
    );
  }
  orchestration.push(
    "Other projects' sessions are reachable: bb_library gives cross-project views when the current repo isn't the whole story.",
  );
  if (probe.hasTodos) {
    orchestration.push(
      "Work is tracked in a DAG: bb_todo is the record of now/next/blocked — check it when picking up work and update it when state changes.",
    );
  }
  if (probe.lspLanguages.length > 0) {
    orchestration.push(
      "Before claiming work is done, run bb_lsp diagnostics on touched files — errors you didn't fix are unfinished work.",
    );
  }
  if (orchestration.length > 0) {
    lines.push(orchestration.join("\n"));
  }

  if (probe.hasDesignLifecycle) {
    lines.push(
      "Designs are files under docs/design/ with required sections (requirements are prose paragraphs ending in a bracketed six-hex design id; acceptance tests carry the same id in their names); plans are reviewed rows consumed into the todo DAG. Shift+tab moves normal → design → plan; the completeness gate blocks half-written designs.",
    );
    lines.push(
      "## Feature lifecycle\n\nA test whose name ends in [hex6] is an acceptance contract for a design requirement — not an ordinary test. When one fails, a decided requirement is broken, not merely red. Before editing what such a test covers, read its requirement: the [lifecycle] block that appears after a failing gate run carries the requirement paragraph, the design doc path, and open cards. That block is harness-generated — trust it like git status. A tagged test's meaning may change only after its design doc changes. Untagged tests are interiors: refactor freely.",
    );
  }

  return lines.join("\n\n");
}

// ─── Layer 2: live state (ephemeral tail) ──────────────────────────────────

/** DB-derived live state snapshot for one turn. */
export interface LiveState {
  mode: "normal" | "design" | "plan";
  /** design mode: open design title. */
  designTitle?: string;
  /** design mode: missing required-section NAMES (steering, not status). */
  missingSections?: string[];
  /** plan mode: revision number and consistency-pass counts. */
  planRev?: number;
  passClean?: number;
  passDirty?: number;
  /** building: active design title + progress. */
  buildingTitle?: string;
  doneCount?: number;
  totalCount?: number;
  nowTask?: string;
  nextTask?: string;
}

/**
 * One compact state line for the message rail. Collapses to "" when there
 * is nothing active (idle = no noise). Volatile bytes are fine here: the
 * tail is never cached.
 */
export function composeStateBlock(state: LiveState): string {
  if (state.mode === "design" && state.designTitle) {
    const missing = (state.missingSections ?? []).join(", ");
    return missing === ""
      ? `[state] mode: design · open: "${state.designTitle}"`
      : `[state] mode: design · open: "${state.designTitle}" · missing sections: ${missing}`;
  }
  if (state.mode === "plan" && state.planRev !== undefined) {
    const clean = state.passClean ?? 0;
    const dirty = state.passDirty ?? 0;
    return `[state] mode: plan · rev ${state.planRev} · passes: ${clean} clean, ${dirty} dirty`;
  }
  if (
    state.buildingTitle &&
    state.totalCount !== undefined &&
    state.totalCount > 0
  ) {
    const done = state.doneCount ?? 0;
    const parts = [
      `[state] mode: normal · building "${state.buildingTitle}" ${done}/${state.totalCount}`,
    ];
    if (state.nowTask) parts.push(`NOW ${state.nowTask}`);
    if (state.nextTask) parts.push(`NEXT ${state.nextTask}`);
    return parts.join(" · ");
  }
  return "";
}

/**
 * The datetime line — fresh every turn (the message rail's always-accurate
 * clock). Takes the Date as an argument so tests are deterministic.
 */
export function composeDatetimeLine(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const ymd = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${
    pad(now.getDate())
  }`;
  const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  // Intl short zone name ("PDT"); falls back to the IANA id when unavailable.
  const zone = Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")?.value;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `[now] ${ymd}T${hm} ${zone ?? tz} (${tz})`;
}

// ─── Layer 3: hint supersede rule ──────────────────────────────────────────

export interface DiagnosticNudge {
  file: string;
  text: string;
}

/**
 * Diagnostics nudges supersede per file: stale diagnostics are lies, so the
 * context event keeps only the LATEST nudge per path. Breadcrumbs and
 * checkpoints never pass through here — they are immutable history.
 */
export function supersedeNudges(
  existing: DiagnosticNudge[],
  incoming: DiagnosticNudge[],
): DiagnosticNudge[] {
  const byFile = new Map<string, DiagnosticNudge>();
  for (const nudge of [...existing, ...incoming]) {
    byFile.set(nudge.file, nudge); // incoming wins on collision
  }
  return [...byFile.values()];
}

// ─── Tool surface extraction ─────────────────────────────────────────────

/** Extract promptSnippet and promptGuidelines from tool source files. */
export function extractToolSurfaces(
  toolSources: string[],
): { snippets: string[]; guidelines: string[] } {
  const snippets: string[] = [];
  const guidelines: string[] = [];
  for (const path of toolSources) {
    const src = Deno.readTextFileSync(path);
    for (const m of src.matchAll(/promptSnippet:\s*"((?:[^"\\]|\\.)*)"/g)) {
      if (!snippets.includes(m[1]!)) snippets.push(m[1]!);
    }
    const g = /promptGuidelines:\s*\[([\s\S]*?)\]/.exec(src);
    if (g) {
      for (const q of g[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        if (!guidelines.includes(q[1]!)) guidelines.push(q[1]!);
      }
    }
  }
  return { snippets, guidelines };
}

// ─── Full system prompt ownership (design 006) ───────────────────────────

import { buildSystemPrompt } from "../../pi/packages/coding-agent/src/core/system-prompt.ts";

/** Stock guideline lines folded into the blueberry guideline list. */
const STOCK_GUIDELINES = [
  "Be concise in your responses",
  "Show file paths clearly when working with files",
];

/**
 * Compose the full system prompt, owning the base text end to end.
 *
 * Uses the assembler underneath with customPrompt set to blueberry's own
 * identity + tool surfaces + guidelines. No third-party documentation
 * routing ships in the prompt.
 */
export function composeSystemPrompt(input: {
  cwd: string;
  probe: IdentityProbe;
  toolSnippets: string[];
  promptGuidelines: string[];
}): string {
  const { cwd, probe, toolSnippets, promptGuidelines } = input;

  // Base text: identity paragraphs from composeIdentity
  const identity = composeIdentity(probe);

  // Tool descriptions
  const toolsSection = toolSnippets.length > 0
    ? "\n\nAvailable tools:\n" + toolSnippets.map((s) => `- ${s}`).join("\n")
    : "";

  // Guidelines: input list + folded stock lines (deduplicated)
  const guidelines = [...promptGuidelines];
  for (const line of STOCK_GUIDELINES) {
    if (!guidelines.includes(line)) {
      guidelines.push(line);
    }
  }
  const guidelinesSection = guidelines.length > 0
    ? "\n\nGuidelines:\n" + guidelines.map((g) => `- ${g}`).join("\n")
    : "";

  const customPrompt = identity + toolsSection + guidelinesSection;

  return buildSystemPrompt({
    cwd,
    customPrompt,
  });
}
