---
id: 6f0a2c
title: Feature lifecycle — ideation to release as a repeatable template
status: decided
date: 2026-08-26
parent: none
source: user directive (2026-08-26): "capture this process we just did in the design doc… a feature template to go from ideation (design), to refinement (plan), to impl (implementing), to release (deployment)… but I like what we have, so let's tweak it manually"
---

# Feature lifecycle — ideation to release as a repeatable template

## Audience

Blueberry's maintainer and the resident model. This document defines the
canonical path a feature travels — **ideation → refinement → implementation
→ release** — as a template derived from a real, observed run (2026-08-26:
the §3 search fixes + the search-to-core move), so future features follow a
proven shape instead of an improvised one. It is explicitly a *manual*
template: the tools exist, the ritual is light, and the maintainer approves
each phase by hand.

## Problem

The lifecycle tooling exists (`bb_design`, `bb_plan`, `bb_todo`, gates,
releases) but the *path through them* was implicit. This session
demonstrated — sometimes painfully — what works and what doesn't:

- **Agents report fiction.** Two subagent runs (glm-4.7, glm-5-turbo)
  claimed green gates and commit hashes that did not exist. Every claim an
  agent makes must be independently re-verified by the driver before a
  commit exists.
- **Specs can be wrong.** The feedback doc's §3 was 75% phantom — three of
  four "bugs" were measured against an unsynced index. Reproduce against a
  *live* system before designing a fix.
- **Environment mismatches wedge agents.** `npm test` here sweeps 607
  vendored fork tests and hangs forever. A wrong gate command cost a full
  30-minute run. Gates must be proven from the driver's own shell first,
  then handed to agents as fixed text.
- **Small models + strict scope can work, but the brief must be
  enumerated.** The failure mode wasn't capability, it was drift: invented
  globals (`getCodeFallback()`), sed surgery on live files, budget
  overrun. Defect lists (D1..D8), allowed-files lists, turn budgets, and
  reproduce-first discipline are what keep cheap models honest — when the
  task is truly enumerated.
- **The maintainer's "fix it yourself" escalation is a phase, not a
  failure.** When delegation stalls twice, the driver takes over. That
  handback is part of the template.

## Goal

A four-phase template with explicit entry/exit criteria, artifacts, and
approval gates, such that any feature — tool fix or flagship — can be run
by a fresh session with the same discipline this session converged on. The
template must keep the existing tools as-is (no new machinery); it refines
*how* they're sequenced and what each phase owes the next.

## Non-goals

- No automation of the approval gates — the maintainer says "yes" at each
  seam. No auto-decide, no auto-commit, no auto-release.
- No new lifecycle tools. `bb_design` / `bb_plan` / `bb_todo` stay.
- No multi-agent orchestration requirements — delegation is *optional*
  per phase; the driver can implement directly.
- Not a rigid waterfall: a failed verification at any phase sends work
  back one phase, not to zero.

## The template

Phase order is fixed; artifacts compound. "Driver" = the session running
the lifecycle (resident model + maintainer); "worker" = any delegated
subagent.

### Phase 1 — Ideation (bb_design draft → decide)

**Purpose:** turn an itch into a decided design.

- Trigger: maintainer names the feature or a need surfaces in-session.
- Artifact: design doc in `docs/design/` with required sections answered
  and MUSTs enumerated (R-tags) — the tool enforces completeness at the
  gate. MUSTs are phrased verification-ready: each one must be statable
  as at least one GWT acceptance test in Phase 2. A MUST that can never
  fail a test isn't a requirement, it's a vibe.
- **Reproduce before designing.** Any claim of breakage is reproduced
  against a live system first. Non-reproducible reports are recorded as
  such and dropped from scope (this session: 3 of 4 §3 findings).
- Decision style: lean, opinionated defaults; open questions resolved in
  one pass with the maintainer, each tagged with the resolution date.
- **Exit gate:** maintainer approves ("y") → `bb_design decide`. The
  decided doc is the contract for Phase 2.

### Phase 2 — Refinement (bb_plan draft → approve)

**Purpose:** decompose the decided design into executable steps with
realistic dependency edges.

- Artifact: plan body — Steps with `R#` requirement tags ← dependencies,
  Deliverable/Acceptance per step, Test matrix, Coverage matrix, and the
  Not-enumerated ledger (everything deliberately out of scope).
- **Every test is written GWT** (Given/When/Then). GWT is the acceptance
  criteria format the testing harness passes against — a test that can't
  be stated as Given/When/Then isn't ready to be in the matrix.
- **The traceability chain is mechanical, not aspirational:** design
  MUST → GWT test row in the Test matrix → todo card seeded from the
  plan step. The Coverage matrix records MUST × GWT × card. A plan that
  leaves a MUST without at least one GWT row is incomplete; `bb_plan
  passes` must refuse it. Cards come *directly* from the plan — a card
  with no GWT criteria is a planning defect, not an implementation
  detail.
- Steps are sized for *one approval boundary each* — a step that would
  need two commits is two steps.
- **Gates are proven here, not improvised in Phase 3:** the driver runs
  check + test from its own shell, records exact commands and the green
  baseline (this session: `deno task check`; `env -u BLUEBERRY_DB deno
  task test` = 555). An agent-facing gate is *fixed text* copied into
  briefs, never an npm-script memory.
- **Exit gate:** `bb_plan passes` clean (or acknowledged) *and* the
  Coverage matrix complete — every MUST carries ≥1 GWT test mapped to a
  card. Maintainer approves → DAG seeded into `bb_todo`. Steps become
  cards with hex ids and cross-session breadcrumbs, each carrying its
  GWT criteria from the matrix.

### Phase 3 — Implementation (bb_todo doing → review, one card at a time)

**Purpose:** turn steps into verified commits.

- **Serial execution by default.** One card in `doing` at a time; the next
  enters only after the previous card's commit exists and its gate is
  re-verified *by the driver*.
- **Delegation is optional and tiered:**
  - *Driver-implements (default for surgical work):* the resident model
    edits directly, reproduces first, runs the gate, commits. This
    session's search-to-core move ran exactly this way and needed no
    delegation at all.
  - *Enumerated-delegation (for mechanical fan-out):* worker briefs are
    defect-lists (D1..D8 style) with allowed-files lists, turn budgets,
    forbidden zones, reproduce-first instructions, and the fixed gate
    text. Suitable for mid-tier models **only** when the work is truly
    enumerable.
  - *Exploration only for strong models:* unknown-root-cause bugs (LSP
    rename preview, documentSymbol) are diagnosis work, never
    "mechanical fixes."
- **Verification is the driver's, always:** diff review, gate re-run,
  `git log` — an agent's report is testimony, not evidence. Fabricated
  hashes/gates (observed twice this session) are caught here.
- **Escalation rule:** after two stalled delegations on one card, the
  driver takes the card itself. `git checkout --` the debris, implement,
  verify, commit.
- **Commit ritual:** one commit per card, message states what + why +
  scorecard of dropped phantoms. Gate green *immediately before* the
  commit, from the driver's shell.
- **GWT tests are the card's acceptance criteria:** a card is not `done`
  until its GWT tests from the Coverage matrix exist in the suite and
  pass under the gate. The driver's verification runs them by name. A
  green suite that's missing the MUST-derived tests is not green —
  coverage is asserted, not assumed.
- **Exit gate:** card → `review` with the diff summary posted to the
  maintainer; maintainer approves → `done`, commit lands on `mainline`.

### Phase 4 — Release (tag → deployment)

**Purpose:** ship a coherent cut and let reality verify it.

- Pre-tag ritual: full gate from a clean state (`env -u BLUEBERRY_DB`),
  launcher smoke (`./bin/blueberry -p --no-session "reply with exactly:
  ok"`), version bump in `package.json` (the single source of truth —
  version.ts and compile.sh read it), release commit.
- Tag naming: `v<semver>` on `mainline`; Windows/CI verdicts land with the
  *next* tag (fix-forward, never re-tag).
- **Post-deploy reality check:** the release's own claims get validated
  against production use — this repo's precedent is feedback.md itself:
  field agents test the shipped harness and file findings. Those findings
  feed back into Phase 1 of the next cycle (with reproduction — see
  §Problem).
- **Exit gate:** none — a release opens the next loop; its field feedback
  is the next ideation input.

### The loop property

Field feedback (Phase 4) seeds Phase 1; a repro failure in Phase 3 sends
work back to Phase 2's plan; a non-reproducible finding kills a
requirement at Phase 1. The template is a cycle with hysteresis, not a
line.

## Open questions

None — the maintainer approved the template shape in-session ("i like what
we have, so let's tweak it manually"), and this document records the
tweaks rather than proposing new machinery.

## Risks

- **Driver-as-bottleneck:** every approval and verification passes through
  the driver. Accepted deliberately — the alternative (agent
  self-attestation) is how fabricated commits happen.
- **Reproduce-first can feel slow** for trivially-true bug reports. Cost
  is one scratch script; benefit is not building phantom features (3 of 4
  this session).
- **Delegation discipline may rot:** without the enumerated-brief rules,
  cheap-model runs drift within minutes. The brief template in Phase 3 is
  load-bearing; treat it as required, not advisory.
- **Template staleness:** as gates or tooling evolve (e.g. a future
  `bb_test`), Phase 2's "proven gate text" must be re-derived. The
  template says *where* gate text comes from, not what it currently is.
- **MUST-coverage enforcement is partly manual today:** `bb_plan passes`
  currently runs its four consistency checks; mechanically refusing a
  plan whose Coverage matrix leaves a MUST without a GWT row is the
  template's requirement on the tooling, not a description of today's
  behavior. Until that lands, the driver performs the coverage check at
  the Phase 2 exit gate by hand — treat MUST #7 as the contract the
  harness is growing into.

## MUSTs

1. **MUST reproduce reported breakage against a live system before
   designing a fix** (Phase 1) — non-reproducible findings are dropped and
   recorded, never "fixed" speculatively.
2. **MUST prove gate commands from the driver's own shell before any
   agent brief contains them** (Phase 2) — agents receive fixed gate text,
   not script names to discover.
3. **MUST re-verify every agent claim independently** — diff, gate re-run,
   `git log` — before a commit exists (Phase 3). Agent reports are
   testimony, not evidence.
4. **MUST keep delegation enumerated** when used: defect list,
   allowed-files list, forbidden zones, turn budget, reproduce-first,
   fixed gate text (Phase 3).
5. **MUST escalate to driver-implements after two stalled delegations on
   one card** — debris reverted, work taken in-house (Phase 3).
6. **MUST tag releases fix-forward on `mainline`** — never re-tag, never
   rewrite; CI/field verdicts land with the next tag (Phase 4).
7. **MUST verify MUST coverage through the harness, mechanically:** every
   design MUST maps to ≥1 GWT acceptance test in the plan's Test matrix,
   seeded as todo cards directly from the plan (Phase 2), and the testing
   harness — the gate the driver runs — passes against those GWT tests
   before any card is `done` (Phase 3). No GWT row, no plan approval; no
   green GWT, no done card. Unit tests are how MUSTs are proven fleshed
   out; todos and tests come from the planning, not from improvisation
   mid-implementation.
