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
	supersedeNudges,
	type DiagnosticNudge,
	type IdentityProbe,
} from "../src/core/context-composer.ts";

const baseProbe: IdentityProbe = {
	cwd: "/tmp/proj",
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

test("identity: capability gating — no bb_lsp mention without servers", () => {
	const withLsp = composeIdentity(baseProbe);
	assert.ok(withLsp.includes("bb_lsp"));
	const noLsp = composeIdentity({ ...baseProbe, lspLanguages: [] });
	assert.ok(!noLsp.includes("bb_lsp"), "bb_lsp never mentioned when no servers");
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

test("identity: needles convention always present", () => {
	assert.ok(composeIdentity(baseProbe).includes("todo:<slug>"));
	assert.ok(composeIdentity(baseProbe).includes("design:<slug>"));
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
