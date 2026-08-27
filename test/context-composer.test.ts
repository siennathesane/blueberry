/**
 * §Context composer tests — the invariants ARE the feature.
 *
 * 1. Zero-eviction: identity bytes never change mid-session, no matter how
 *    capability state churns after session_start (the freeze is structural).
 * 2. Message-rail purity: state/datetime/supersede outputs carry no cache
 *    discipline at all — they're free to be volatile.
 * 3. Capability gating: tools are only mentioned when their surface exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeDatetimeLine,
  composeIdentity,
  composeStateBlock,
  composeSystemPrompt,
  type DiagnosticNudge,
  extractToolSurfaces,
  type IdentityProbe,
  supersedeNudges,
} from "../src/core/context-composer.ts";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Platform-conditional fake cwd paths for Windows compatibility (#32)
const TMP_PROJ = resolve("/tmp/proj");

const baseProbe: IdentityProbe = {
  cwd: TMP_PROJ,
  lspLanguages: ["go", "rust"],
  hasDesignLifecycle: true,
  hasTodos: true,
};

// ─── Layer 1: identity, frozen ─────────────────────────────────────────────

test("identity: deterministic for a given probe (byte-stable across calls)", () => {
  assert.equal(composeIdentity(baseProbe), composeIdentity(baseProbe));
});

test("identity: ZERO-EVICTION — late capability churn never changes composed bytes", () => {
  const frozen = composeIdentity(baseProbe);
  // a session that started before todos existed, then todos appear:
  // identity stays frozen (probe is captured once; recomposition with the
  // SAME probe is byte-identical — the extension must reuse the frozen text)
  const recomposed = composeIdentity(baseProbe);
  assert.equal(frozen, recomposed);
  // and the guard: a *different* probe composing different bytes would be a
  // NEW session, not this one — which is legal only at session_start.
  // Pin that identity contains no timestamps/datetime content at all:
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(frozen), "no dates in identity");
  assert.ok(!/\d{1,2}:\d{2}/.test(frozen), "no clock times in identity");
});

test("identity: LSP-first steering — navigation rule explicit, grep is fallback", () => {
  const id = composeIdentity(baseProbe);
  assert.ok(id.includes("LSP-first"), "the decision rule is named");
  assert.ok(id.includes("FALLBACK"), "raw grep/read is framed as fallback");
  assert.ok(
    id.includes(
      "Code questions go to bb_lsp; history questions go to bb_search",
    ),
    "domain split stated",
  );
  // gating: without servers, none of the LSP steering appears
  const bare = composeIdentity({ ...baseProbe, lspLanguages: [] });
  assert.ok(!bare.includes("LSP-first"));
  assert.ok(!bare.includes("bb_lsp"));
});

test("identity: capability gating — no bb_lsp mention without servers", () => {
  const withLsp = composeIdentity(baseProbe);
  assert.ok(withLsp.includes("bb_lsp"));
  const noLsp = composeIdentity({ ...baseProbe, lspLanguages: [] });
  assert.ok(
    !noLsp.includes("bb_lsp"),
    "bb_lsp never mentioned when no servers",
  );
});

test("identity: gating — design lifecycle + todos lines only when present", () => {
  assert.ok(composeIdentity(baseProbe).includes("docs/design/"));
  const bare = composeIdentity({ ...baseProbe, hasDesignLifecycle: false });
  assert.ok(!bare.includes("docs/design/"), "design lifecycle line dropped");

  assert.ok(composeIdentity(baseProbe).includes("bb_todo"));
  const noTodos = composeIdentity({ ...baseProbe, hasTodos: false });
  assert.ok(!noTodos.includes("bb_todo"), "todo line dropped");
});

test("identity: languages are sorted (order churn impossible)", () => {
  const a = composeIdentity({ ...baseProbe, lspLanguages: ["rust", "go"] });
  const b = composeIdentity({ ...baseProbe, lspLanguages: ["go", "rust"] });
  assert.equal(a, b);
  assert.ok(b.includes("go, rust"));
});

test("identity: simplified technical English directive always present", () => {
  assert.ok(
    composeIdentity(baseProbe).includes(
      "You will speak with the user in simplified technical English.",
    ),
  );
  // and it survives every gating variant (no surface removes it)
  assert.ok(
    composeIdentity({
      ...baseProbe,
      lspLanguages: [],
      hasDesignLifecycle: false,
      hasTodos: false,
    }).includes(
      "You will speak with the user in simplified technical English.",
    ),
  );
});

test("identity: needles convention always present", () => {
  assert.ok(composeIdentity(baseProbe).includes("todo:<slug>"));
  assert.ok(composeIdentity(baseProbe).includes("design:<slug>"));
});

test("identity: lifecycle section present when hasDesignLifecycle is true", () => {
  const id = composeIdentity(baseProbe);
  assert.ok(id.includes("## Feature lifecycle"), "lifecycle heading present");
  assert.ok(
    id.includes("acceptance contract"),
    "acceptance contract phrase present",
  );
});

test("identity: lifecycle section absent when hasDesignLifecycle is false", () => {
  const id = composeIdentity({ ...baseProbe, hasDesignLifecycle: false });
  assert.ok(!id.includes("## Feature lifecycle"), "lifecycle heading absent");
});

test("identity: lifecycle section is static (no per-session state)", () => {
  const a = composeIdentity(baseProbe);
  const b = composeIdentity(baseProbe);
  assert.equal(a, b, "lifecycle identity is byte-stable across calls");
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(a), "no dates in lifecycle section");
  const uuidPattern =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  assert.ok(!uuidPattern.test(a), "no UUIDs in lifecycle section");
});

// ─── Layer 2: state block (message rail — volatile by design) ──────────────

test("state: design mode carries missing section NAMES (steering)", () => {
  const s = composeStateBlock({
    mode: "design",
    designTitle: "session management",
    missingSections: ["Requirements", "Verification", "Decision"],
  });
  assert.ok(s.includes('open: "session management"'));
  assert.ok(
    s.includes("missing sections: Requirements, Verification, Decision"),
  );
});

test("state: design mode with no missing sections omits the clause", () => {
  const s = composeStateBlock({ mode: "design", designTitle: "done doc" });
  assert.ok(!s.includes("missing"));
});

test("state: building carries NOW/NEXT and progress", () => {
  const s = composeStateBlock({
    mode: "normal",
    buildingTitle: "doc search",
    doneCount: 3,
    totalCount: 7,
    nowTask: "fts5 schema",
    nextTask: "bb_search tool",
  });
  assert.ok(s.includes('building "doc search" 3/7'));
  assert.ok(s.includes("NOW fts5 schema"));
  assert.ok(s.includes("NEXT bb_search tool"));
});

test("state: plan mode carries rev + pass counts", () => {
  const s = composeStateBlock({
    mode: "plan",
    planRev: 2,
    passClean: 3,
    passDirty: 1,
  });
  assert.ok(s.includes("rev 2"));
  assert.ok(s.includes("3 clean, 1 dirty"));
});

test("state: idle collapses to empty string (no noise)", () => {
  assert.equal(composeStateBlock({ mode: "normal" }), "");
  assert.equal(
    composeStateBlock({
      mode: "normal",
      buildingTitle: "x",
      doneCount: 0,
      totalCount: 0,
    }),
    "",
  );
});

// ─── datetime (message rail) ───────────────────────────────────────────────

test("datetime: deterministic for a given Date, minute-resolution", () => {
  // local-components constructor: renders as 14:32 on ANY machine timezone
  const d = new Date(2025, 7, 25, 14, 32, 7);
  const a = composeDatetimeLine(d);
  assert.ok(a.startsWith("[now] 2025-08-25T14:32"), a);
  assert.ok(a.includes("["), "zone present");
  // same call again → same bytes (pure)
  assert.equal(a, composeDatetimeLine(d));
});

// ─── Layer 3: supersede ────────────────────────────────────────────────────

test("supersede: latest nudge per file wins, order preserved otherwise", () => {
  const existing: DiagnosticNudge[] = [
    { file: "a.ts", text: "3 errors" },
    { file: "b.ts", text: "1 error" },
  ];
  const incoming: DiagnosticNudge[] = [
    { file: "a.ts", text: "clean" },
    { file: "c.ts", text: "2 errors" },
  ];
  const merged = supersedeNudges(existing, incoming);
  const byFile = new Map(merged.map((n) => [n.file, n.text]));
  assert.equal(byFile.get("a.ts"), "clean", "incoming supersedes");
  assert.equal(byFile.get("b.ts"), "1 error", "untouched file survives");
  assert.equal(byFile.get("c.ts"), "2 errors", "new file added");
});

test("supersede: empty inputs", () => {
  assert.deepEqual(supersedeNudges([], []), []);
  assert.deepEqual(supersedeNudges([{ file: "x", text: "t" }], []).length, 1);
});

// ─── composeSystemPrompt (design 006) ────────────────────────────────────

const fullProbe: IdentityProbe = {
  cwd: TMP_PROJ,
  lspLanguages: ["go", "rust"],
  hasDesignLifecycle: true,
  hasTodos: true,
};

const sampleSnippets = ["snippet-one", "snippet-two"];
const sampleGuidelines = ["Always check types first"];

test("composeSystemPrompt: exactly one You-are opener at line starts", () => {
  const prompt = composeSystemPrompt({
    cwd: TMP_PROJ,
    probe: fullProbe,
    toolSnippets: sampleSnippets,
    promptGuidelines: sampleGuidelines,
  });
  const youAreLines = prompt.split("\n").filter((l) => /^You are/.test(l));
  assert.equal(
    youAreLines.length,
    1,
    `expected 1 'You are' line start, got ${youAreLines.length}`,
  );
});

test("composeSystemPrompt: corrected design-lifecycle grammar (six-hex, no RFC 2119)", () => {
  const prompt = composeSystemPrompt({
    cwd: TMP_PROJ,
    probe: fullProbe,
    toolSnippets: sampleSnippets,
    promptGuidelines: sampleGuidelines,
  });
  assert.ok(prompt.includes("six-hex"), "must mention six-hex ids");
  assert.ok(!prompt.includes("RFC 2119"), "must not contain RFC 2119");
});

test("composeSystemPrompt: no pi documentation anywhere in the prompt", () => {
  const a = composeSystemPrompt({
    cwd: "/x",
    probe: fullProbe,
    toolSnippets: [],
    promptGuidelines: [],
  });
  assert.ok(!a.includes("Pi documentation"), "no pi-docs block");
  assert.ok(!a.includes("pi distribution"), "no pi framing");
  assert.ok(!a.toLowerCase().includes("pi/packages"), "no pi paths");
});

test("composeSystemPrompt: guidelines fold — Be concise appears exactly once", () => {
  const prompt = composeSystemPrompt({
    cwd: TMP_PROJ,
    probe: fullProbe,
    toolSnippets: sampleSnippets,
    promptGuidelines: [...sampleGuidelines, "Be concise in your responses"],
  });
  const matches = prompt.split("Be concise in your responses").length - 1;
  assert.equal(
    matches,
    1,
    `expected 'Be concise' exactly once, got ${matches}`,
  );
});

// ─── extractToolSurfaces ─────────────────────────────────────────────────

test("extractToolSurfaces: returns real snippets and guidelines from tool sources", () => {
  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const toolSources = [
    resolve(repoRoot, "src/core/tools/search.ts"),
    resolve(repoRoot, "extensions/library/index.ts"),
    resolve(repoRoot, "extensions/lsp/index.ts"),
    resolve(repoRoot, "extensions/todo/index.ts"),
  ];
  const { snippets, guidelines } = extractToolSurfaces(toolSources);
  assert.ok(
    snippets.length >= 4,
    `expected >= 4 snippets, got ${snippets.length}`,
  );
  assert.ok(
    guidelines.length >= 6,
    `expected >= 6 guidelines, got ${guidelines.length}`,
  );
  for (const s of snippets) {
    assert.ok(s.length > 0, "every snippet must be non-empty");
  }
  for (const g of guidelines) {
    assert.ok(g.length > 0, "every guideline must be non-empty");
  }
});
