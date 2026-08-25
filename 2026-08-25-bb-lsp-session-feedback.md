# bb_lsp — session feedback (Rust, sunbeam/crm)

Date: 2026-08-25
Session: stack-overflow forensics + codegen-emitter edits in `sunbeam/crm`
(25+ crates, ~280 generated GraphQL entities, 4–16 min `cargo check`/`build`
round-trips, strict context-budget rules — generated files must not be
bulk-read).

## Environment

- rust-analyzer, started on demand by the first `bb_lsp` call.
- Cold start was noticeable but one-time; subsequent calls were fast.

## What earned its keep

1. **`diagnostics` after edits — the standout.** In this repo a `cargo check`
   of a downstream crate takes 4–10 minutes. Being able to verify an edit to
   the codegen emitter (a file full of `quote!` token streams, where mistakes
   only surface in *generated* output crates minutes later) in ~1s changed how
   I iterated: edit → diagnostics → next edit, with `cargo` reserved for
   final confirmation. For heavyweight repos this alone justifies the LSP
   path.

2. **`documentSymbol`** — cheap, instant outline of an unfamiliar file.
   Used it to orient in `crm-server/src/lib.rs` before reading it. Output
   format (`name @kind` + line) is fine.

3. **`status`** — clear view of which servers exist / are running; the
   implicit "start on first use" behavior is good UX. I didn't have to think
   about booting rust-analyzer.

4. **`hover`** — returned type + layout (size/align) + doc snippet in one
   block. Adequate; nothing to complain about.

## What fell short

1. **`references` returns bare positions** (`lib.rs:46:5`, no source text).
   For navigation in unfamiliar code this forces a follow-up `read` of the
   file anyway, so `rg` strictly dominated it in practice — rg gives me the
   matching line, file, and I can bound the output. **Suggestion:** include
   the source line text (1–3 lines of context) in each reference hit.

2. **No "verify my recent edits" aggregate.** After touching N files (this
   session: workspace `Cargo.toml`, a hand-written loader impl, two emitter
   blocks), what I actually wanted was one action: *diagnostics across all
   files I changed since the last green state*. I approximated it with N
   `diagnostics` calls. **Suggestion:** a `diagnostics` mode that takes
   multiple paths, or auto-derives the changed-file set from the session's
   edit history / `git diff --name-only`.

3. **Coverage gaps I hit were real but fair** — the session's core work was
   outside LSP's domain: parsing macOS `.ips` crash reports, reading
   vendored crate sources under `~/.cargo/registry`, diffing generated files
   under `target/debug/build/*/out/`. No expectation that bb_lsp covers
   those; noting it so the scorecard is honest. (If rust-analyzer *can*
   index build-script `OUT_DIR` includes, a `documentSymbol` on a generated
   file would have been interesting — didn't think to try it mid-flow.)

4. **Unused but likely valuable here:** `definition`/`typeDefinition`/
   `implementation`/`workspaceSymbol`/`rename`. This session had few, small
   edits; the next emitter change with a rename ripple would be the real
   test for `rename` (preview→apply) against hand-maintained parallel
   `quote!` strings.

## Verdict

Marginal-to-positive this session, entirely on the strength of
`diagnostics`-on-edit in a slow-build repo. Navigation output needs line
text to beat `rg`. Will keep using it; expect the value to concentrate in
(diagnostics-after-edit, definition/hover while writing emitter code, rename
when a symbol crosses generated/hand-written seams).
