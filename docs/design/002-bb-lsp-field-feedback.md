---
id: 26d07c
title: bb_lsp — field feedback incorporation (Rust, sunbeam/crm)
status: abandoned
date: 2026-08-25
parent: none
source: session retro, sunbeam/crm stack-overflow forensics + codegen-emitter edits
---

# bb_lsp — field feedback incorporation

## Audience

The blueberry maintainer (me) deciding which LSP surface improvements ship
next; future sessions resuming this work via `bb search design:bb-lsp-field`.

## Problem

The first real field session of bb_lsp (Rust, 25+ crates, 4–16 min builds)
returned a split verdict: diagnostics-on-edit proved high-value, but
navigation via `references` lost to `rg` because it returns bare positions,
and multi-file verification required N manual diagnostics calls. The feedback
exists as a session retro; it is not yet in the design corpus, so the
improvements it implies live nowhere actionable.

## Goal

Incorporate the field feedback as design requirements so the next bb_lsp
revision is driven by observed usage, not speculation: references-with-text,
aggregate diagnostics, and an honest coverage scorecard.

## Non-goals

- Re-litigating the LSP architecture (server lifecycle, wire protocol —
  those held up fine in the field).
- Covering non-LSP domains the session hit (`.ips` parsing, vendored crate
  sources, build-out dirs) — R3 records them as out of scope.
- The skills-mode work (separate open design).

## Session context: 25+ crates, ~280 generated GraphQL entities, 4–16 min
`cargo check`/`build` round-trips, strict context-budget rules (generated files
must not be bulk-read). rust-analyzer, started on demand by the first `bb_lsp`
call; cold start noticeable but one-time, subsequent calls fast.

## What earned its keep

- **diagnostics after edits — the standout.** A `cargo check` of a downstream
  crate takes 4–10 minutes; verifying an edit to the codegen emitter (a file
  full of `quote!` token streams, where mistakes only surface in *generated*
  output crates minutes later) in ~1s changed iteration shape: edit →
  diagnostics → next edit, cargo reserved for final confirmation. In
  heavyweight repos this alone justifies the LSP path.
- **documentSymbol** — cheap, instant outline of an unfamiliar file; used to
  orient before reading. Output format (`name @kind` + line) is fine.
- **status** — clear server view; implicit start-on-first-use is good UX.
- **hover** — type + layout (size/align) + doc snippet in one block.

## Approaches considered

- **Approach A — retro only:** keep the feedback as a blog-post-style doc.
  Rejected: doc_fts never indexes root-level files; the lifecycle can't gate
  what isn't in the corpus.
- **Approach B — full redesign doc:** rewrite the LSP design top-to-bottom
  with feedback merged. Rejected for now: the LSP design's core held; only
  the navigation output and diagnostics aggregation are contested. A
  revision-level incorporation keeps the original intact as history.
- **Approach C (chosen) — incorporation doc:** a design-corpus record whose
  Requirements section pins the deltas R1–R3; the next LSP design revision
  supersedes this doc by absorbing them.

## What fell short → requirements

## Requirements

- R1. The `references` action MUST include the source line text (1–3
  context lines) per hit. Bare positions (`lib.rs:46:5`) force a follow-up
  read; `rg` strictly dominated navigation without it.
  - Verification: unit test asserting each rendered hit carries non-empty
    line text; field check — next Rust navigation round uses no follow-up read.
- R2. The `diagnostics` action MUST support an aggregate mode: multiple
  paths in one call, or an auto-derived changed-file set (session edit
  history / `git diff --name-only`) — "verify my recent edits" as one action.
  - Verification: unit test over a fake server with N paths; field check —
    the emitter-edit loop collapses to one call per batch.
- R3 (observational, no action). Coverage gaps hit (`.ips` parsing,
  `~/.cargo/registry` vendored sources, `target/**/out/` diffs) are outside
  bb_lsp's domain — recorded for an honest scorecard.

## Verification

Each MUST above carries its verification inline; overall: `deno task test`
green including the new tests, and doc_fts returns this doc for the query
`design:bb-lsp-field`.

## Unused-but-likely-valuable

`definition` / `typeDefinition` / `implementation` / `workspaceSymbol` /
`rename`. The next rename crossing generated/hand-written seams is the real
test for `rename` preview→apply against parallel `quote!` strings.

## Decision

Incorporate per Approach C. Ship R1 (references include 1–3 context lines)
and R2 (diagnostics accepts multiple paths; auto-derived changed-set as a
mode) in the next bb_lsp revision. R3 stays observational — no action.

## Risks & open questions

- Context-budget: R1's per-hit line text could bloat large reference sets —
  bound output (head/tail the hit list) the way rg does.
- R2's changed-set derivation: session edit history vs `git diff --name-only`
  — which source of truth for "files I touched"? Open.
- Rename across generated/hand-written seams remains untested in the field;
  the next emitter change is the real trial.

## Verdict

Marginal-to-positive, entirely on diagnostics-on-edit in a slow-build repo.
Navigation output needs line text to beat `rg`. Expected value concentration:
diagnostics-after-edit, definition/hover while writing emitter code, rename
across generated/hand-written seams.
