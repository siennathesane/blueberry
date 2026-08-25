---
id: 88ec3b
title: Task built-ins — full lifecycle, bg/fg contexts, executable DAG
status: open
date: 2026-08-25
parent: none
source: user spec (2025-08-25): full lifecycle + background/foreground tasks + DAGs and queued commands
---

# Task built-ins — lifecycle, bg/fg, and the executable DAG

## Audience

Blueberry's maintainer and the resident model: this defines the task system
both sides drive — the human via `bb tasks`, the model via `bb_todo` — and
the executor that runs command-bearing task trees.

## Problem

Tasks today are bookkeeping: titles, stages, deps — the DAG exists but nodes
only *describe* work. The user manages them solely through the model or the
ctrl+p pane, can't park one context and work another, and nothing in a task
tree can execute. Repetitive or ordered work (build, verify, fix, re-verify)
is re-typed every session as ad-hoc shell invocations with no shared state,
no history, no dependency gating.

## Goal

One task system, both surfaces: full lifecycle verbs from the CLI, bg/fg
context switching for parallel work, and command-bearing nodes executed by a
queued DAG runner — without changing the interface's shape (same tasks,
same pane, same needles; tasks gain a command payload and an executor).

## Non-goals

- Replacing the shell or becoming a build system (no file-watching, no
  transpilers — commands are shell strings, executed as-is).
- Cron/scheduling — a tree runs when told, not on a clock.
- Remote execution — commands run on this machine, in the task's cwd.
- Reworking the kanban pane beyond what execution state requires.

## Approaches considered

- **Approach A — external runner:** generate a just/Makefile from the DAG.
  Rejected: state lives outside blueberry.db (breaks needles/search/checkpoint
  integration), and stage truth forks between runner and DAG.
- **Approach B — tmux-backed:** each tree runs in a tmux session; attach =
  fg. Rejected as the core (hard dependency, opaque state) — but retained as
  a possible attach UX for streaming output.
- **Approach C (chosen) — native executor:** a bounded-concurrency runner
  inside blueberry (spawn, cwd, env), driven by the existing DAG's derived
  ready/blocked set; exit codes drive stage transitions; all state in
  blueberry.db; output streamed to a per-task log. The DAG was always the
  hard part — the executor is small against it.

## Decision

Approach C. Tasks gain an optional `command` payload (shell string, cwd,
env). The executor walks the ready set topologically, runs commands with a
bounded parallelism, records exit codes + output logs, and transitions
stages: exit 0 → done; nonzero → review (blocked visible, human/model
decides fix vs re-run). bg/fg: a RUNNING tree keeps executing detached;
`bb tasks fg` reattaches the context (state rail, strip, live tail);
backgrounded-but-not-running tasks are parked contexts — NOW pointer and
breadcrumbs preserved, resumed where left.

## Risks & open questions

- **Trust boundary (open):** commands authored by the model. Options:
  blessed-at-plan-approve (the plan lists commands; approving seeds a
  runnable tree) vs confirm-per-first-run. Lean: bless at approve — matches
  the lifecycle's existing gate.
- **Parallelism cap (open):** ready siblings run concurrently, bounded.
  Reuse WIP cap 5? Make it a tree-level knob?
- **Log growth (open):** per-task output logs in the DB could bloat —
  cap/truncate policy needed.
- **Re-run semantics (open):** re-running a done task = new attempt or
  idempotent skip? Checkpoint digest interplay.

## Requirements

- R1. The task store MUST support an optional command payload per task
  (command string, cwd, env map) without schema breakage for
  command-less tasks.
  - Verification: store round-trip test; existing 477-suite stays green.
- R2. The executor MUST walk the derived ready set in dependency order,
  run command-bearing tasks, and MUST NOT start a task whose deps are
  unmet.
  - Verification: fake-command integration test with a diamond DAG;
    assert start order and blocking.
- R3. Exit codes MUST drive stage transitions (0 → done; nonzero → review)
  and be recorded with output.
  - Verification: fixture commands exiting 0/1/2; stage + log assertions.
- R4. `bb tasks` MUST cover the full lifecycle (list/add/rename/stage/dep/
  checkpoint/close/bg/fg/run/logs) with slug/hex6 selectors.
  - Verification: CLI integration tests per verb.
- R5. `bb_todo` MUST gain matching actions (run/bg/fg semantics) so the
  model drives the same executor.
  - Verification: tool action tests mirroring R4.
- R6. A backgrounded running tree MUST continue executing; `bb tasks fg`
  MUST restore its context (state rail shows it; live tail available).
  - Verification: slow-fixture bg → fg mid-run; assert continuation + rail.

## Verification

Per-requirement inline above. Overall: `deno task test` green with new
suites; a demo tree (build → test → lint diamond) executed end-to-end via
`bb tasks run` in a scratch project; completeness gate passes on this doc
before any plan consumes it.

## Session context

Built on the shipped DAG (todos, todo_deps, derived ready/blocked), kanban
pane, breadcrumb needles, and checkpoint digests. First design drafted
under the plan-mode use gate: planning this work is blocked until this
document exists — as designed.
