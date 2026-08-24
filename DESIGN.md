# blueberry DESIGN

Design notes for the flagship builds. Each section lists the proposed shape,
the reasoning, and **open questions to resolve with the user before implementing**.
Reference implementations live in `vendored/` — read them, don't revive them.

---

## §Sessions — session & project management (SHIPPED 2025-08-24)

**Status: implemented and tested.** `src/core/` + `src/cli/` + `bin/blueberry`, 126 tests,
≥90% line/branch/function coverage enforced via `npm run coverage`. Verified live:
self-registration, marker resolution from subdirectories, trust pre-writing, doctor.
Notes below are the design as built; deviations none.

All pi internals below were verified against pi-mono@main (cloned at `~/Development/pi`),
files `packages/coding-agent/src/core/session-manager.ts` and `src/main.ts`.

### The problem

- pi keys sessions to the **exact launch directory** (header `cwd`), not the project.
  Working from a subdir fragments history; moving a project orphans it entirely.
- Resume (`-c`, `-r`, `/resume`) filters by **exact header-cwd equality** (`sessionCwdMatches`)
  whenever a custom session dir is active. The mangled storage dir name is irrelevant.
- Forks store absolute `parentSession` paths — dangle after moves.

### Verified pi behavior we build on

| Fact | Consequence |
| ----- | ------------- |
| Custom session dir is used verbatim (no mangled nesting) | Flat per-project stores are clean: `~/.blueberry/sessions/<slug>/` |
| `--session-dir` > env var > settings | Launcher env var always loses to explicit user flags — free escape hatch |
| `--session <id>` search does not recurse subdirs | pi never crosses project stores; cross-project browse is `bb open`'s job |
| Trust lives in `<agentDir>/trust.json`, cwd-keyed, batch-writable | Registry owns trust completely |
| Sessions with empty header cwd trigger an interactive prompt | `bb adopt` stamps cwds during import so the prompt never appears |

### Design: four layers

1. **Identity** — stable project ID (ULID) + human slug. Marker file travels with the
   repo: `.git/blueberry-id`, `.lore/blueberry-id` (both local-state dirs, never committed).
   Git *worktrees* have `.git` as a file → fall back to in-repo `.blueberry/id`.
2. **Registry** (`~/.blueberry/registry.json`) — `{ id, slug, canonicalPath, aliases[],
   gitRemote?, sessionStore: "central"|"in-repo", trusted }`. Rebuildable from session
   headers (`bb doctor` proves it). Registry is convenience; artifacts are truth.
3. **Launcher resolution** — resolve cwd → project, `cd` to project root (canonicalization,
   see below), rewrite path-like CLI args to absolute against the original cwd, set
   `PI_CODING_AGENT_SESSION_DIR`, exec pi. Resolution order: marker file → git/lore remote
   match (auto-reattach + registry update + notify) → exact path/alias → mint new project.
   `--here` opts out of canonicalization.
4. **CLI** — `blueberry sessions/projects …`, aliased `bb`:
   - `bb projects list | rename <slug> <new> | merge <a> <b> | forget <slug>`
   - `bb sessions list [--all] | rename <sel> <name> | move <sel> <project> | open <sel> | trash <sel>`
   - `bb adopt <dir>` — import `~/.pi/agent/sessions`, group by header cwd, stamp cwds
   - `bb fix` — reconcile orphans, stale cwds, splits, dangling `parentSession`
   - `bb project sessions central|repo` — toggle per-project store + migrate files

### Canonicalization (the load-bearing decision)

**Ratified requirement (2025-08-25): sessions are per-project, no matter how deep in
the tree you launch from.** Launching a new session from any subdirectory must land in
the same store and match resume filtering identically to a root launch. Both halves are
required together:

- **Store half:** one session dir per project regardless of launch subdir.
- **cwd half:** launcher `cd`s to project root so header `cwd` is always the root;
  without this, exact-equality resume filtering hides sessions from pi itself.

Known trade-off: launching from a subdir normally loads that subdir's `AGENTS.md`;
canonicalizing loses it. `--here` is the escape hatch. Path-like CLI args are rewritten
to absolute before the cd, so `bb @./notes.md` works from anywhere in the tree.

**Nested projects:** nearest marker wins. The upward walk stops at the first
`.git`/`.lore/blueberry-id`/`.blueberry/id`, so a subdir that is its own repo registers as
its own project; unmarked subdirs belong to the outer project. `bb --project <slug>` overrides.

**Bare-`pi` bypass:** canonicalization lives in the launcher, so typing `pi` from a
subdir re-fragments. Mitigations: document `bb` as the entry point, plus a guard in the
core extension — on `session_start`, if a marker-walk from cwd finds a project root ≠ cwd,
notify loudly ("history is fragmenting; use bb"). Verified: pi pushes `--session-dir`
into child pi processes (interactive-mode.ts:263), so in-session spawns inherit the store.

### Session moves (`bb sessions move`)

Copy JSONL to target store + rewrite header `cwd`; rewrite `parentSession` only when the
parent moved too, else clear it. **Never rewrite message/tool content** — old paths in
history are inert; content surgery is where JSONLs go to die. Renames append
`session_info` entries (pi's native mechanism, survives `/tree`).

### Per-project store location

- `central` (default): `~/.blueberry/sessions/<slug>/` — private, survives repo deletion.
- `in-repo`: `<root>/.blueberry/sessions/` (gitignored) — travels with clones, dies with
  the clone. The reason to choose it.

### Trust

Registry writes `~/.blueberry/trust.json` on register/move/adopt. After `bb move A→B`
not even the one-time trust prompt appears.

### Deployability constraint (kimi-code direction)

One state root (`~/.blueberry`), one command surface (`blueberry <subcommand>`), no
runtime dependency on this dev checkout — at distribution time the local-path package
entry becomes a published npm/git source. CLI-first, generic naming, from day one.

### Implementation order (when we build)

1. Registry + marker + launcher resolution (canonicalization) — the foundation
2. `bb` read commands: `projects list`, `sessions list`
3. `bb adopt` (imports existing pi history)
4. Mutations: `rename`, `move`, `merge`, `forget`, `trash`
5. `bb fix` / `bb doctor`

---

## §Library — cross-project session access (SHIPPED 2025-08-25)

**Status: implemented.** `src/core/library.ts` + `extensions/library/` (bb_library tool) +
CLI `sessions show|search|fork`. 160 tests, coverage ≥90% on all metrics.

Decisions recorded (user, 2025-08-25):

- Single tool with action enum — confirmed; `bb_library` actions: projects, sessions, show, search.
- Everything inspectable — confirmed; the `message` view is the full drill-down (thinking, tool
  arguments, tool results with details blocks, images noted).
- Fork naming: `name@project` (not `fork:` prefix). Slashes stripped; empty base falls back
  to `session@project`.
- Replay/eval: NOT near-term. Fork stays simple — information + future merging are the use;
  provenance travels in the name itself.

### The problem

Multi-session, multi-project work: while in a session for project A, the work
often needs the history of project B — "what did we decide in webmail?",
"how did the pi-clone spike go?" Today each project's store is an island.
The model *could* read raw JSONL via bash/read, but that is token-hostile
(tool results, thinking blocks, images), has no discovery, and no identity.
Sessions must be first-class: addressable, inspectable, and loadable from
any session in any project.

### Principles

1. **Read-only across boundaries by default.** Reading another project's
   store never writes anything — not their sessions, not the registry, not
   trust. The only cross-store write is an explicit `fork` that lands in
   YOUR store (never theirs).
2. **No new state.** The registry and stores already exist. This layer is a
   query vocabulary on top (`src/core/library.ts` + an extension). Nothing
   to migrate, nothing to sync, nothing to corrupt.
3. **Extracts, not dumps.** Session files are context bombs. Every read is a
   rendered view (summary/tree/messages) with byte budgets, never raw JSONL.
4. **Symmetric.** If project A can read B, B can read A. No per-project
   visibility config (single-user distribution; revisit if that changes).

### Addressing

`<project>/<selector>` where selector keeps the existing grammar:
index (1-based, newest first), uuid prefix (≥4), exact name.
Examples: `webmail/3`, `blueberry/api-redesign`, `aspen/01a02d`.
A bare selector defaults to the current project (back-compat with `bb sessions`).
Ambiguity (duplicate names across projects) resolves by refusing and listing candidates.

### Views (the read contract)

- **summary**: header (name, id, dates, msg count, model history from
  model_change entries) — a few hundred bytes.
- **tree**: entry tree with labels, compaction markers, branch points — the
  /tree view in text form.
- **messages**: rendered conversation, paginated (`offset`/`limit` on message
  index). User text verbatim; assistant text verbatim; thinking omitted;
  toolCalls → one line (`tool bash → ok`); toolResults → one line with size;
  images → `[image]`; bashExecution `!!` (`excludeFromContext`) omitted.
  Budget: pi conventions (50KB / 2000 lines, truncateTail, sidecar file).

### Surfaces

**CLI (humans):**

- `bb sessions show <addr> [--view summary|tree|messages] [--offset --limit]`
- `bb sessions search <text> [--all]` — streaming scan v1 (no index); the
  §Search SQLite engine can host a sessions FTS table later without API change.

**Extension `extensions/library/` (the model — this is the first-class part):**

- Tool `bb_library` with actions: `projects` (list), `sessions` (list per
  project), `show` (any view, paginated). One tool, not three — keeps the
  prompt small and the model chooses granularity.
- `promptGuidelines`: prefer bb_library over raw file reads when the user
  references other projects' work; always start with `summary`, drill down
  only as needed.

**Fork (the only write):**

- `bb sessions fork <addr>` — copies the source into the CURRENT project's
  store via the existing `moveSession` copy mode: header cwd rewritten to the
  current canonical, `parentSession` cleared per surgery rules (it would be
  dangling), name gets `fork:` prefix via pi-native session_info append.
  Source store untouched. Resulting session opens with `bb sessions open`.

### Explicitly deferred

- **@session: editor expansion** (input-event sugar over the same views) —
  nice, later; tool surface covers the need first.
- **Replay/eval harness** ("test" in the load-and-test sense: re-running a
  session's prompts against a model) — separate feature, its own design doc;
  the fork primitive is its natural input, which is why fork ships here.
- **Cross-index** (FTS over all sessions) — v2, inside §Search's engine.
- **Remote/multi-machine federation** — violates single-root; out of scope.

### Open questions

- [x] bb_library tool shape: single tool with `action` enum — DECIDED (single)
- [x] Should `messages` view include tool RESULTS on demand — DECIDED (yes: `message` view
      is the full-content drill-down)
- [x] Fork naming — DECIDED (`name@project`)
- [x] Is replay/eval actually wanted soon — DECIDED (no; information + maybe merging later)

---

## §Plan — plan mode, rewritten

Upstream reference: `vendored/pi-plan-mode/` (@narumitw/pi-plan-mode v0.52.0)

### What's wrong with the stock one (hypotheses — confirm with user)

- Plan state is ephemeral extension state, not a durable artifact you can
  diff, keep, or reuse across sessions.
- The read-only restriction is blunt (kills the tools you'd want for
  *investigation*, like running tests or grepping history).
- No explicit approval moment — transitions feel mushy.

### Proposed shape

1. **Plan is a file.** `PLAN.md` in the repo (or session-scoped under the
   agent dir for throwaway work — TBD). Versioned by git like everything else.
2. **Planning phase = restricted tools, not zero tools.** Allow read/grep/
   find/bash; block edit/write. Enforced via `tool_call` gate.
3. **Approval gate.** Leaving planning requires explicit user confirmation
   (`ctx.ui.confirm` or a custom component). The plan is presented as a
   checklist that becomes the seed of the todo list.
4. **Execution tracking.** Plan steps flow into blueberry-todo (see §Todo);
   plan file gets progress annotations so `PLAN.md` stays truthful.
5. **Entry points:** `/plan` command, `--plan` flag, and a shortcut.
   Widget shows current mode (like the vendored one's status line, but ours).

### Open questions

- [ ] What specifically burned you on the current plan-mode? (workflow, UX, model behavior?)
- [ ] Where do plans live — repo `PLAN.md`, `.blueberry/plans/`, or session storage?
- [ ] Should steering mid-execution be allowed to amend the plan without leaving execute mode?
- [ ] Do we want a plan *history* (previous plans per project)?

---

## §Todo — attention manager for long-horizon work (design round 2, 2025-08-25)

Upstream reference: `vendored/rpiv-todo/` (@juicesharp/rpiv-todo v2.7.0) — superseded by this design.

### The reframe

Not a to-do list — an **attention manager** shaped like how principal engineers
actually work: small working set, explicit waits, deferred trust, re-orientation
rituals. Loops (agentic hype) have no waits and no memory; principals work in
**episodes** — re-orient, act, checkpoint — and the tool must serve the episode.

### Storage (decided 2025-08-25)

- **SQLite per project** (`todos.db`), not JSON. Reason: the event log is the
  point — `events(task_id, kind, ts, session_id, note)` alongside `tasks` and
  `deps` tables enables replay, WIP age, cycle time, stuck detection, and the
  future "dreaming" consolidation pass. Current-state JSON can't do any of that.
- **Never in git.** Central store under the agent dir (consistent with session
  store policy): `~/.blueberry/todos/<slug>.db` (location open, see questions).
- **Session log as audit trail:** `bb_todo` tool calls land in session JSONL as
  normal tool entries (automatic); tool-result `details` carry a state digest so
  `/tree` navigation stays renderable. **Todo state is project truth in SQLite**;
  session loading (`bb sessions open`, resume) rehydrates the pane from the DB.

### Model: DAG is truth, kanban is the lens

- Node: `id`, `title`, `track?`, `stage` (todo|doing|review|done), `deps[]`, ages.
- **Stage is stored** (kanban lifecycle); **ready/blocked is derived** from
  `deps ∪ done`. No drift: the DAG constrains legality (can't enter doing with
  incomplete deps; can't complete with incomplete deps; cycles rejected at write).
- Two lenses over one DAG: **kanban** (default — lifecycle/attention) and
  **closure graph** (`g` on a node — dependency reasoning, ≤15 nodes).

### Rendering (researched 2025-08-25)

No turnkey JS library renders a DAG pane inside a host TUI. Composition:
- **pi-tui** for components (we live inside pi; ink/blessed would fight the host).
- **Kanban mode needs no graph layout** — columns are stage, cards are one line.
- **Closure mode layout math**: `d3-dag` (maintained TS Sugiyama layering; ranks
  map to terminal rows) or `@dagrejs/dagre` (older, same idea). Layout only — we
  render the characters. Reference impls: `terminal-graphs` (JS, closest),
  `ascii-dag` (Rust, zero-dep — candidate for the future binary distribution).
- Cycle detection/topo sort: hand-rolled (deps sets, <1k nodes, ~30 lines) —
  graphlib optional later.

### The pane (mini-kanban, bounded height)

Four columns: `todo · doing · review · done`. **Height is bounded (~10 rows)
regardless of task count** — density is managed by focus+fringe: TODO shows the
ready frontier + blocked summary (backlog collapsed to counts), DOING is capped
(WIP limit — principals hold 3–5), REVIEW is the waiting-on-human queue with age
oldest-first, DONE shows recent + count. Mockups in the conversation log;
final polish happens live against a real terminal.

- Strip (always on, above editor): `⬡ 3/15 · ◉ t1 dag core 4h · review ◧2 · next ▣ s1`
- Pane (`/todo` overlay): 4 columns, one-line cards, ~10 rows total
- Detail card (enter): why/waiting-on/unlocks/context links (session id, DESIGN §)
- Closure graph (g): box-drawing edges over the node's dependency closure only

### Lifecycle integration (the core fix)

- **Session start** = re-orientation: strip + pane state are the "where was I".
- **During**: `bb_todo` tool (single tool, action enum — house style), stage
  moves legality-checked against the DAG.
- **Session end** = checkpoint: auto-append an event (what moved, notes) —
  sqlite row + session log entry. No ceremony, always captured.
- **Dreaming (future §Goals)**: idle/nightly consolidation over the event log +
  session library: refresh priorities, surface rot ("s3 ready for 12 days"),
  distill context, propose splits/merges. The event log is shaped for this now.

### Open questions

- [ ] REVIEW semantics: model-work awaiting user verification, external waits
      (PRs, sleep-on-it), or both under one gate?
- [ ] WIP limit on DOING: hard cap (5?) or soft warn?
- [ ] todos.db location: central `~/.blueberry/todos/<slug>.db` vs in-repo
      gitignored `<root>/.blueberry/todos.db`?
- [ ] DONE column: recent-N or count-only?

---

## §Search — embedded disk-based search engine

Upstream reference: `vendored/pi-fff/` (@ff-labs/pi-fff v0.10.5)

### The constraint that shapes everything

**Near-zero resident memory.** So: no in-memory inverted index of the repo,
no JS object holding every file's tokens. The index is a file on disk and
queries stream over it.

### Key insight: Node ships SQLite now

Node ≥22.5 has `node:sqlite` built in (no npm dep, jiti loads it fine).
FTS5 gives us:

- **On-disk inverted index** with page cache managed by SQLite, not us
- **BM25 ranking** for free (`bm25()` auxiliary function)
- Incremental updates via upsert — no full rebuilds
- Proven concurrent read behavior; memory bounded by SQLite page cache
  (default a few MB, configurable via `PRAGMA cache_size`)

This is almost embarrassingly the right tool. The design work is in the
schema and the update policy, not the ranking math.

### Proposed shape

- **Index location:** `~/.blueberry/index/<project-slug>.db` (or in-repo
  `.blueberry/cache/` — TBD; must respect .gitignore either way).
- **Schema sketch:**
  - `files(path TEXT PRIMARY KEY, mtime INTEGER, size INTEGER, lang TEXT)`
  - `fts_content(path, line, text)` — FTS5 table, one row per line
  - later: `fts_paths(path)` for fuzzy path search, `symbols(name, kind, path, line)`
    for symbol search (parse via tree-sitter or regex fallback)
- **Update policy:** incremental walk by mtime on `bb_search` invocation if
  stale (>N seconds or unknown file), full walk on first use. Deleted files
  pruned. Walk respects .gitignore + default excludes (node_modules, .git, dist).
- **Tools:**
  - `bb_search` (content, BM25, line results with snippets) — the grep replacement
  - `bb_find` (paths, fuzzy/ranked) — the find replacement
  - `bb_symbols` (defs, ranked) — later
- **Prompt guidelines** steer the model to prefer `bb_*` over bash grep/find.

### Open questions

- [ ] Is a ~2–5 MB SQLite page cache acceptable as "basically no memory", or do we need mmap-style streaming (read-only queries, `PRAGMA mmap_size`)?
- [ ] Index per project (slug from path) vs one DB with project column?
- [ ] Auto-index on session_start in background, or strictly lazy on first query?
- [ ] Do we replace fff entirely (uninstall) or keep both during migration?
- [ ] Symbol index in v1 or defer?

---

## §Theme — blueberry + orange-juice (shipped)

Shipped: `themes/blueberry.json` (default) and `themes/orange-juice.json`.
orange-juice's core palette came from the user's swatch image (2025-08-24):
orange ramp `#e85f2e → #f9db4a`, neutrals `#1f1f1f/#2a2a2a/#7f7f7f`, brown
`#3e3324`, creams; supporting colors (moss success, warm red, warm grays)
were deliberate additions — core palette stays dominant.

blueberry (2025-08-24) is the default: indigo-violet base (`#1e1b2e`),
periwinkle accent `#8f8ff0`, lavender/lilac text ramp, citrine `#e8d44d` as
the citrus wink (numbers, inline code, search matches), sage strings,
cool-shifted diff red `#e06c75` so errors don't clash with the base, and the
signature move: **thinking-level borders run cool → warm** (umber → indigo →
violet → periwinkle → citrine → orange → amber) — thinking heats from
contemplation to computation. Orange survives as bash-mode/warning/accent-
edge color: the juice stays in the pairing. All hues are `vars` for live
tweaking. Known judgment call: sage strings sit near diff-green by design
(desaturated to coexist); swap candidate if it reads wrong: dusty rose.

## §Distribution — what "blueberry" installs (updated 2025-08-25)

Session/project management is in-repo (`extensions/core`-adjacent CLI code, see §Sessions),
not a carried package. Carried from the old setup: `pi-subagents`, `pi-web-access`,
`pi-lens`, `pi-mcp-adapter`. Rewritten in-repo (old packages dropped): plan-mode,
rpiv-todo, fff. Still dropped pending confirmation: `pi-background-tasks`, `pi-goal`.
For distribution: package source flips from local path to published npm/git name; the
launcher, registry, and CLI are the product surface.
