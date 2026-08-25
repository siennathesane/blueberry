---
id: 8d4d99
title: Command graph — parallel bash execution with dependencies
status: decided
date: 2026-08-25
parent: none
source: user spec (2025-08-25): a COMMAND graph for running bash commands (unrelated to todos); named TEMPLATES replace hook managers (lefthook/husky et al.); output retention is TTL-bound to session compactions
---

# Command graph — parallel bash execution with dependencies

## Audience

Blueberry's maintainer and the resident model: this defines a graph of bash
commands with dependency edges that blueberry can run — parallel where the
graph allows, ordered where it chains. "Temporary scripts" are ad-hoc graphs
sketched, run, and kept in history.

## Problem

Long-running or big jobs (builds, test sweeps, regenerations, migrations)
need to run in parallel or in chains. Today that means hand-rolled shell
backgrounding, `&&` chains, or a Makefile you didn't want to write — none of
which carry state blueberry can see: no history, no output retention, no
dependency gating, no way for the model to define and drive the choreography
from inside a session.

## Goal

A command graph: nodes are bash commands (string, cwd, env), edges are
dependencies. A runner executes the ready set with bounded parallelism,
records output and exit codes per node, and the whole thing is inspectable
(`bb cmd` surface) and drivable by both the human and the model. Graphs are
lightweight to define imperatively — a temporary script — and persist as
runnable history when wanted. Named TEMPLATES (parameterized stored graphs)
are invocable on demand — replacing hook managers (lefthook, husky et al.):
the trigger is judgment (model or human at the right moment), not events.
Node output is retained under a TTL keyed to session compactions.

## Non-goals

- Any coupling to the todo DAG or the design→plan lifecycle. Todos track
  work; the command graph runs commands. Separate substrates, separate
  tables, no shared state beyond blueberry.db itself.
- Replacing the shell, make, or just. No globbing, no variable substitution
  beyond what the shell itself does. Commands are bash strings, verbatim.
- Scheduling/cron. A graph runs when told.
- Remote execution. This machine, in the node's cwd.
- Event/hook wiring of any kind — no git hooks, no file watchers, no
  "on event X run Y" config. Templates are invoked when they're needed by
  whoever notices it's needed; this deliberately replaces lefthook/husky.

## Approaches considered

- **Approach A — reuse the todo DAG** (add command payloads to tasks).
  Rejected (user correction): todos are work tracking; conflating execution
  state with stage truth muddies both, and the interfaces (pane, needles,
  checkpoints) would drag along execution semantics they don't need.
- **Approach B — generate just/Makefile.** Rejected: state and output live
  outside blueberry.db; no history, no model surface.
- **Approach C (chosen) — first-class command graph.** Own tables
  (cmd_graphs, cmd_nodes, cmd_edges, cmd_runs), a small runner
  (spawn + dependency walk, bounded concurrency), output logs retained per
  node. The graph is the unit: define → run → inspect → (keep or forget).

## Decision

Approach C. `bb cmd` (and a model-facing tool of the same shape) defines
nodes and edges imperatively — `bb cmd new`, `bb cmd dep`, `bb cmd run`
(background by default for long jobs), `bb cmd ls/ps/logs/fg/kill`. A
running graph detaches cleanly (executor survives the session that started
it); `bb cmd fg <graph>` reattaches — status rail, live tail. Exit codes
set node state (0 → ok, nonzero → failed); downstream of a failed node
stays blocked and visible. Graphs are rows: cheap to mint, kept as history,
re-runnable.

TEMPLATES: a template is a stored graph definition (name, parameter list,
nodes, edges). `bb cmd template add/save`, `bb cmd run <template> --args…`
mints a runnable graph instance from it. Arguments pass as environment
variables (BB_ARG_<NAME>) — zero templating syntax; the shell and the
commands themselves do the substitution. Templates are the hook-manager
replacement: "pre-commit checks" is a template the model runs before it
commits, not a git hook wired to an event.

OUTPUT TTL: node output (stdout/stderr) is stored, not kept forever. Each
session compaction bumps a generation counter in blueberry.db; output rows
carry their generation; a purge pass (run at compaction and on `bb cmd`
invocation — same reaper-on-invocation posture) drops output older than 3
generations. Detached/sessionless runs get a wall-clock floor (default 168h — one week)
so output doesn't vanish before anyone looked, plus the per-node byte cap.

## Risks & open questions

- Executor lifetime: detached graphs outlive the session — supervision
  strategy (a blueberry daemon vs reaper-on-next-invocation) is an open
  question; lean: reaper-on-invocation first (no daemon), daemon later if
  it hurts.
- Model-authored commands: no approval gate (todos/tools already run shell);
  visibility = commands echoed as they start. The human is watching.
- Output TTL calibration (open, user: "hard to know for sure"): 3
  compactions is the starting default, not a law — tune by observed
  retrieval patterns. Byte cap per node (512KB, tail-kept) bounds the
  worst case regardless of generations.
- Parallelism default: lean 4 concurrent ready nodes, graph-level override.

## Requirements

- R1. The store MUST persist command graphs as first-class rows (graphs,
  nodes with command/cwd/env, dependency edges) independent of todos.
  - Verification: store round-trip tests; todo tables untouched by graph ops.
- R2. The runner MUST execute ready nodes in dependency order with bounded
  parallelism, and MUST NOT start a node whose deps are unmet.
  - Verification: diamond-graph integration test with fake commands;
    start-order and blocking assertions.
- R3. Node completion MUST record exit code and output; nonzero exit marks
  the node failed and its downstream blocked.
  - Verification: fixtures exiting 0/1/2; state + log assertions.
- R4. Running graphs MUST detach from the defining session and remain
  inspectable/controllable (`ls/ps/logs/fg/kill`) from a fresh invocation.
  - Verification: bg a slow fixture, new process lists/tails/kills it.
- R5. The human (`bb cmd …`) and model (matching tool actions) surfaces
  MUST drive the same runner and state.
  - Verification: tool action tests mirroring the CLI verbs.
- R6. Templates MUST be storable, named, parameterized graph definitions,
  invocable by both surfaces, with arguments passed as environment
  variables (no templating syntax).
  - Verification: template save → run-with-args round-trip test; the
    invoked graph carries substituted env into a fixture command that
    echoes it.
- R7. Node output MUST expire: purged when older than N compaction
  generations (default 3) of the defining session, with a wall-clock floor
  (default 168h) for sessionless runs; expiry runs at compaction and on
  invocation.
  - Verification: generation-bump simulation asserts purge at 4, survival
    at 3; wall-clock floor honored for detached runs.

## Verification

Per-requirement inline above. Overall: `deno task test` green with new
suites; an end-to-end demo graph (build → [test ∥ lint] → bundle diamond)
run via `bb cmd` in a scratch project; completeness gate passes on this doc.

## Session context

Shares blueberry.db (own tables), the trust posture of existing shell tools,
and nothing else. Todos, the kanban pane, and the planning lifecycle are
untouched by this design.
