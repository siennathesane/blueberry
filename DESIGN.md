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

## §Data — the formal data layout (DECIDED 2025-08-25)

> One file is the agent. Copy `blueberry.db` + clone the repos = take your
> agent with you. Auth included — by design.

### The rule: three formats, total

| Format | Contents | Status |
| --- | --- | --- |
| **`~/.blueberry/blueberry.db`** (SQLite, WAL, `0600`) | todos, deps, events, projects/aliases, sessions + entries, config, auth | THE state; source of truth |
| **pi interop files** | session JSONL (per-project stores), `settings.json`, `trust.json`, `auth.json` | materialized caches; rebuildable from the DB |
| **Marker files** | `.git/blueberry-id`, `.lore/blueberry-id`, `.blueberry/id` | one ULID string; live in repos by design |

Nothing else. No per-feature formats; new features get tables or die.

### Schema (v1)

```sql
CREATE TABLE meta     (key TEXT PRIMARY KEY, value TEXT);  -- schema_version, last_sync, …

CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT UNIQUE, canonical_path TEXT,
                       git_remote TEXT, session_store TEXT, merged_into TEXT,
                       trusted INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE aliases  (project_id TEXT, path TEXT, PRIMARY KEY (project_id, path));

CREATE TABLE todos    (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, track TEXT,
                       stage TEXT DEFAULT 'todo',  -- todo|doing|review|done|dropped
                       created_at TEXT, updated_at TEXT, done_at TEXT);
CREATE TABLE todo_deps (todo_id TEXT, dep_id TEXT, PRIMARY KEY (todo_id, dep_id));
CREATE TABLE todo_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, todo_id TEXT,
                       kind TEXT, ts TEXT, session_id TEXT, note TEXT);

-- session history (ingested; JSONL remains pi's live write-path)
CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT, file_path TEXT,
                       cwd TEXT, ts TEXT, parent_session TEXT, name TEXT,
                       file_mtime_ms INTEGER, size_bytes INTEGER, ingested_at TEXT);
CREATE TABLE session_entries (session_id TEXT, seq INTEGER, ts TEXT, type TEXT,
                       entry_id TEXT, parent_id TEXT, json TEXT,
                       PRIMARY KEY (session_id, seq));
CREATE VIRTUAL TABLE session_fts USING fts5(
  text, content='');  -- contentless: (session_id, seq, role, text) rows at ingest

-- pi configs, stored as the JSON pi consumes (no format translation)
CREATE TABLE config (key TEXT PRIMARY KEY, json TEXT);  -- 'settings', 'auth'
```

Deliberate simplicity: no tags table (a tag IS `slug + todo id` — derivable);
no separate sessions index (entries ARE it); config as JSON rows (pi's exact
serialization, zero translation loss). Goals/dreaming tables land here later.

### Sync model (decided: compaction + shutdown + bb sync)

- **Write path**: pi appends JSONL in stores, exactly as today. Never sqlite-live.
- **Materialize at launch**: DB → `settings.json` + `auth.json` before exec'ing pi.
- **Ingest**: on `session_compact` (post-success), on `session_shutdown`, and on
  `bb sync` (catch-up: walks stores, ingests by mtime). `bb fix` reconciles drift.
- **Two-way configs**: pi mutates `settings.json` (/settings, /model) and
  `auth.json` (/login, OAuth token refresh) mid-session → re-ingest at sync.
  Mtime rules: file newer → ingest wins; DB newer (written via bb) → materialize
  wins. Crash between change and sync loses that change to materialization —
  accepted v1 cost, `bb fix` is the escape hatch.
- **Restore**: `bb restore` materializes JSONL back out of `entries` into the
  right project store when a store is missing (or explicitly). Either side
  rebuilds the other; no truth ambiguity.

### Auth (decided: IN)

`auth.json` is already plaintext on the same disk — the DB changes nothing
> about the threat model, and `0600` on one file centralizes protection.
Portability includes credentials by design (that's the feature: no re-login on
machine B). Consequence: **the DB is a secret-bearing file** — never commit,
never share without scrubbing. Future option: keychain/SQLCipher, not v1.

### Portability story

Copy `blueberry.db` to a new machine, clone the repos: markers travel inside
repos, the DB carries identity + history + config + auth, and the resolution
ladder (marker → git-remote → alias) reattaches to new absolute paths.

### Convergence bonus

Ingested entries + `session_fts` = FTS5 over session history — the substrate
§Search wanted and the thing `todo:<slug>/<hex6>` reorientation queries want;
`--context 3–5` neighborhoods become SQL, not file scans.

### Migration

`registry.json` → `projects` table on first run (backup kept, then retired).
Existing JSONL stores ingest via `bb sync`. `trust.json` stays a pi interop
file (rewritten by blueberry as today — it's keyed by absolute path, not
portable, so it belongs to the machine, not the agent).

---

## §Design — design → plan → implement (round 2, 2025-08-25; supersedes §Plan)

Upstream reference: `vendored/pi-plan-mode/` — superseded by this design.
Prior art mined: `~/Development/sunbeam/sunbeam-memory` (fused search, provenance
URNs, tracked-files indexing).

### The three-stage lifecycle

Design answers "what are we building and for whom"; planning answers "how do
we build it"; the DAG executes. Two gates, two artifacts:

```
design mode ──(approve)──▶ plan mode ──(approve)──▶ implement
 what/why/scope             how/steps/deps            DAG executes
     └── design doc (docs/) ─┘└── plan (blueberry.db) ┘
         forever: consumer-facing        runtime: consumed into DAG
```

Three entry weights: direct (bb_todo, zero ceremony) → plan-only (/plan, no
design needed for "fix the typo") → design→plan (feature work).

### Two artifacts, two homes (DECIDED 2025-08-25)

**Design doc = a FILE in the repo.** `docs/design/<yyyy-mm-dd>-<slug>.md`.
Git-versioned, human/consumer-facing, reviewable in PRs, readable without
blueberry. **The filename is for humans; frontmatter is the machine truth** —
id lives in frontmatter only, never in the filename. A rename never orphans
the needle: the next ingest re-links `designs.path` by frontmatter id.
Frontmatter carries machine state:

```yaml
---
id: <hex6>            # uuid-6, house style; needle design:<slug>/<hex6>
title: <title>
status: open|decided|superseded|abandoned
date: <yyyy-mm-dd>
supersedes: <hex6>?   # genealogy
superseded-by: <hex6>?
---
```

Body = the REQUIRED-SECTIONS TEMPLATE (researched 2025-08-25 from Amazon
PRFAQ, Google Gerrit design-doc, TensorFlow/HashiCorp RFCs, product-brief
patterns). Entering design mode scaffolds the file with the template; each
section embeds its questions; **the approval gate refuses until every
required section contains non-scaffold content** (TensorFlow rule: skipping
requires justification — "not applicable because…" counts as an answer).

### The design-doc template

```markdown
---
id: <hex6>
title: <title>
status: open
date: <yyyy-mm-dd>
---

# <title>

## Summary
<!-- 3-5 sentences, the commit message for this design: what, for whom,
     why now. A reader decides whether to keep reading here. -->

## Audience            <!-- REQUIRED (PRFAQ) -->
<!-- Precisely who this is for — "if it's for everyone, it's for no one."
     What do they have today? What will they get? Write from their side. -->

## Problem             <!-- REQUIRED (Gerrit) -->
<!-- What's broken or missing, and why does it matter NOW? Write for a
     reader who has never thought about this problem. Context only —
     this is NOT where the design goes. -->

## Goal                <!-- REQUIRED -->
<!-- What will be true when this ships? One paragraph, testable. -->

## Non-goals           <!-- REQUIRED (Gerrit) -->
<!-- What we are explicitly NOT doing. Scope fences; leaving this blank
     is how scope creep wins. -->

## Approaches considered   <!-- REQUIRED (TensorFlow): ≥2, each with a verdict.
                              Rejected ones KEEP their rejection reasons —
                              this is the gold in six months. -->
### Approach A: <name>
- Pros: ...
- Cons: ...
- Verdict: chosen | rejected — because ...

## Decision            <!-- REQUIRED -->
<!-- Which approach won and why. Reference the verdicts above. -->

## Risks & open questions   <!-- REQUIRED (Atlassian); "none identified"
                               is a valid answer — but say it explicitly -->

## Requirements        <!-- REQUIRED (RFC 2119) — the normative inventory.
                              Numbered, keyworded, testable. This is the
                              contract section: the plan's steps satisfy
                              these, the retro audits against them. -->
<!-- R1. The system MUST ...        (absolute; violating = the design failed)
     R2. The system SHOULD ...      (strong default; ignoring needs a reason)
     R3. The system MAY ...         (truly optional; both choices interoperate)
     R4. The system MUST NOT ...    (absolute prohibition; scope fence)
     Write each as one testable statement. "The system SHOULD BE fast"
     is not testable; "sync MUST complete under 2s for 100k sessions"
     is. Sparing use per RFC 2119 §6: imperatives only where
     interoperability or harm-limitation demands them. -->

## Verification        <!-- REQUIRED (PRFAQ: written from the future)
<!-- "When this ships, ..." — commands, tests, bb_lsp diagnostics,
     user-visible signals. The plan's steps must satisfy this section.
     Each MUST requirement needs ≥1 matching verification line. -->
```

**Completeness mechanics:** the scaffold ships with the question comments in
place; the parser strips comments and checks each REQUIRED section for ≥1
line of real content. `bb_design status` reports un-answered sections by
name; the y-gate refuses with the list until all pass. (Summary is the only
non-required section.) Source discipline: questions stay as comments in the
final doc — future readers see what the section was asking for.

**RFC 2119 discipline (added 2025-08-25):** the keyword language is
normative, not decorative —

- **MUST / MUST NOT** — absolute; a violated MUST means the design failed.
  Gate check: every MUST in Requirements has ≥1 matching Verification line.
- **SHOULD / SHOULD NOT** — strong default; deviations are *allowed but must
  be justified in writing* (in the doc or the deviation's design needle).
- **MAY** — truly optional; both choices MUST interoperate.
- Uppercase only (RFC 8174): lowercase "must" is prose, not a requirement.
- Sparing use (2119 §6): imperatives only where interop or harm demands —
  requirements inflation is scope creep wearing a badge.
- Scope is bilateral: Non-goals MUST NOT entries and Requirements MUST
  entries together draw the fence; neither alone is the whole scope.
- The retro audits actual behavior against these keywords: unmet MUST =
honest failure, unmet SHOULD = recorded deviation with reason.

**Plan = a ROW in blueberry.db.** `plans` table: id (uuid-6), design_id (FK
nullable — plan-only work), project_id, status draft|approved|building|done|
abandoned, rev counter, body (markdown: Steps with authored deps via `⟵`,
Verification), seeded_at, seeded_count. Working state, not consumer-facing.
At approval, Steps parse → DAG creates with `design:<slug>/<hex6>` backlinks;
lineage runs doc → tasks → sessions forever.

**Why the split:** design docs are for *readers* — they belong where readers
are (the repo, the review, the docs site). Plans are for *execution* — they
belong where the runtime is (the DB, beside the DAG they seed). Files-for-
consumers + DB-for-runtime mirrors §Data's materialization philosophy.

### Modes

Project-wide DB state (not session state): any bb session sees the same mode.

- **design mode**: investigation tools fully available (read, bash, bb_search,
  bb_lsp, bb_library); doc drafted via bb_design actions. Strip: `◈ designing <title>`.
- **plan mode**: entered on design approval (or /plan directly); decompose
  into steps+deps via bb_plan actions. Strip: `⬡ planning <title>`.
- **implement**: full tools; strip: `⬡ building <title> 3/7` with drift
  detection (seeded vs actual DAG) at checkpoints.

Gates: rendered-doc keys (y approve / e revise / esc keep drafting) at both
transitions. Approval seeds atomically.

Amendments: decomposition amends bump rev (recorded, no re-lock); scope
changes require supersede (new doc, genealogy link, old unfinished tasks
dropped-with-events). Scope is the contract; decomposition is the schedule.

### Indexing (the sunbeam-memory pull)

Design docs and plans are first-class searchable citizens beside code and
sessions — one unified index per project with a source discriminator:

```sql
CREATE TABLE designs (           -- metadata + pointer; file is content truth
  id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, path TEXT NOT NULL,
  title TEXT, status TEXT, supersedes TEXT, superseded_by TEXT,
  file_mtime_ms INTEGER, ingested_at TEXT);
CREATE TABLE plans (
  id TEXT PRIMARY KEY, design_id TEXT, project_id TEXT,
  status TEXT, rev INTEGER DEFAULT 1, body TEXT,
  created_at TEXT, updated_at TEXT, seeded_at TEXT, seeded_count INTEGER);
CREATE VIRTUAL TABLE doc_fts USING fts5(   -- unified: docs + plans
  text, source UNINDEXED, uri UNINDEXED);  -- source: design|plan
```

Pulled from sunbeam-memory (attributed):

- **Fused search via RRF (k=60)** — adopted as prior art reference only.
  DECIDED (2025-08-25): **BM25 alone** — no embedding columns, no vector
  index, no model dependency. Design docs and plans are keyword-rich prose;
  BM25 over doc_fts is the whole search story. If dreaming later wants
  semantic recall, the RRF recipe is documented in sunbeam-memory and can be
  added then — without schema reservations.
- **Provenance URNs** — sunbeam's `source` URN pattern formalized as
  `blueberry://design/<slug>/<hex6>` / `blueberry://plan/<slug>/<hex6>` in
  the uri column; future memory facts point back through these.
- **Tracked files** — the mtime-indexing walk (§Search) already covers .md;
  the design-doc ingest is the same pattern scoped to docs/design/, plus a
  designs metadata row with genealogy.
- **Namespaces** — the `source` discriminator (design|plan|code|session)
  over one index gives sunbeam's namespace filtering per source type.

Drift + retro: checkpoint compares plan steps vs linked DAG tasks (N/M done,
unplanned count); completion logs a `bb-design` breadcrumb digest (planned vs
actual: added, dropped, reordered) — dreaming substrate.

### Surfaces

- bb_design tool: draft/revise/status/abandon/supersede
- bb_plan tool: draft/revise/status/approve/abandon (decomposition actions)
- /design + /plan commands: rendered doc view, gate keys, history subcommand
- strip segments per mode; design:/plan: needles in §Library search

### Open questions

- [x] Plan-only work: **DB-invisible** — no docs/ stub; the ingest stays
      scoped to docs/design/ and plan-only rows simply have design_id NULL.
- [x] Supersede: auto-drops old unfinished tasks (with events) **plus a
      supersede checkpoint digest** — a logged bb-design breadcrumb recording
      what was dropped and why, searchable forever. Drops are never silent.
- [ ] /design history render: full life view (rounds, decisions, drift, retro)?

---

## §Todo — attention manager for long-horizon work (design round 2, 2025-08-25)

Upstream reference: `vendored/rpiv-todo/` (@juicesharp/rpiv-todo v2.7.0) — superseded by this design.

### The reframe

Not a to-do list — an **attention manager** shaped like how principal engineers
actually work: small working set, explicit waits, deferred trust, re-orientation
rituals. Loops (agentic hype) have no waits and no memory; principals work in
**episodes** — re-orient, act, checkpoint — and the tool must serve the episode.

### Storage (decided 2025-08-25, amended: shared DB)

- **SQLite in the shared `~/.blueberry/blueberry.db`** — todos are a table,
  not a database (see §Data). Reason: the event log is the point —
  `todo_events` enables replay, WIP age, cycle time, stuck detection, and the
  future "dreaming" consolidation pass. Current-state JSON can't do any of that.
- **Never in git.** The DB lives in the agent dir with the rest of blueberry's
  state; one file, one backup story, one thing to carry to another machine.
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

### Todo ↔ session log integration (DECIDED 2025-08-25)

Cross-session reorientation must be **zero-effort**: searching a todo's tag
from any session surfaces every session that touched it, with full context.

- **Identifiers (internal, not for humans)**: uuidgen, last 6 hex + project
  slug — `blueberry/9f3a2c`. Full uuid stored in sqlite; short form is the
  address/tag. Humans read titles; ids are for data mapping and search
  needles. Consistent with §Library's existing selector grammar (uuid
  prefix). 6 hex = 16.7M space per project; birthday bound ~4.8k tasks —
  single-user per project, non-issue. Log tag form: `todo:<slug>/<hex6>`.
- **Breadcrumb custom messages (DECIDED)**: every create / stage-move /
  dep-change / completion emits a compact custom message (customType
  `bb-todo`, one line: `todo:<slug>/<hex6> · title · transition · deps`).
  Custom messages participate in LLM context → resumed/forked sessions
  reorient natively, and §Library search scans custom-role text today.
  **The internal identifier MUST appear in every breadcrumb** — that's what
  makes it a search needle. `display: false` for routine moves (quiet
  context), `display: true` for create/complete. Raw entries survive
  compaction (context building only; the file keeps everything).
- **Tool calls are the audit spine**: bb_todo calls (arguments + state digest
  in the result) land in the JSONL automatically.
- **Reorientation digest — LOGGED, not ephemeral (DECIDED)**: the digest is
  for the MODEL, not the user; it exists to survive multi-compaction sessions
  and be findable in search. At session end (checkpoint), a digest breadcrumb
  is appended: `bb-checkpoint` custom message carrying `todo:` tags of every
  task touched this session, NOW/NEXT/review-queue state, and notable notes.
  A future session searching a tag finds: breadcrumbs (per-change) +
  checkpoints (per-session) + tool digest — layered reorientation with zero
  human effort.
- **Discovery split (DECIDED)**: DB-first for discovery AND payload (the
  event log's `session_id` column answers "which sessions touched t9f3a2c"
  exactly — no scan); logs for context (once found, §Library serves the
  surrounding conversation).

> **Design note (applies to §Library search generally):** search results must
> include **3–5 contextual messages above and below** each hit — with
> timestamps and other contextually relevant information (session id, todo
> tags, adjacent transitions). A bare snippet is not reorientation; the
> neighborhood is. §Library's `renderMessages` pagination already gives the
> mechanism; search needs a `--context N` mode that renders the hit's
> surrounding window, not just the matching line.

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

## §LSP — native language servers (design 2025-08-25; fulfills the

pi-lens replacement promised in §Search's roadmap)

### Why not pi-lens's approach

pi-lens shipped tree-sitter grammars + heuristic rules + **cached findings
that lied** (the stale-advisory cascade that plagued this whole session) + an
"LSP Inactive" banner because it *bundled* its own half-LSP. blueberry runs
**real language servers speaking the real protocol**: no cached diagnostics,
ever — the live server is the only truth.

### Ground truth (2025-08-25 machine survey)

Installed: `rust-analyzer`, `gopls`, `clangd`, `deno` (built-in `deno lsp`).
**Missing: any TypeScript server** — and blueberry's own repo is TS. See open
questions.

### Principles

1. **Filesystem truth sync.** A watcher pushes didOpen/didChange driven by
   DISK state. Catches every edit source — pi tools, bash, git checkout,
   formatters — without intercepting anything. Debounced ~200ms; full-text
   sync (`TextDocumentSyncKind.Full`) for v1 simplicity; incremental later
   only if profiling demands it.
2. **On-demand surfaces, token discipline.** Diagnostics are FETCHED (tool/
   command), never auto-injected into context. The model's loop becomes:
   edit → `bb_lsp diagnostics` → fix. promptGuidelines nudge exactly that
   ("after edits, check bb_lsp diagnostics before claiming done").
3. **Bounded resources.** Servers spawn per-language on FIRST touch (not
   session start), idle-reap (default 10m), hard cap 3 concurrent, killed at
   session_shutdown. rust-analyzer's appetite is respected, not fed blindly.
4. **Degrade, never block.** No server installed → "no lsp for <lang>" and
   bb_search/code_fts remains the fallback. Crash → restart w/ backoff →
   honest "server down" answers.
5. **House style.** Single `bb_lsp` tool, action enum. CLI mirror `bb lsp`.

### Architecture

```
src/core/lsp-client.ts   pure protocol: JSON-RPC framing (Content-Length
                          headers), request/response correlation, timeouts.
                          Unit-testable against in-memory duplex streams.
src/core/lsp-manager.ts  lifecycle: server registry (lang→cmd from config),
                          spawn + initialize handshake (rootUri = project
                          root), open-doc set, watcher-driven sync, idle
                          reaper, crash restart w/ backoff.
extensions/lsp/          the shell: session_start boots the watcher (deferred
                          per pi's extension rules; session_shutdown kills),
                          registers bb_lsp + /lsp + statusline segment.
```

**Config** lives in blueberry.db's config table (key `lsp`) — default server
map + per-language overrides + idle timeout; `bb lsp list/status` surfaces
it. Adding a language = adding a row, not code.

**Language detection:** extension → languageId map. First file of a language
seen (watcher event or bb_lsp call) spawns that server. No proactive scans.

### The tool — FULL LSP surface (user decision 2025-08-25: completionists)

Single `bb_lsp` tool, action enum — every surface the protocol offers,
layered by build priority:

**Tier 1 — the agent's daily loop (v1):**

- `status` — servers, health, uptime, restart counts
- `diagnostics` — file or project-wide; severity-mapped readable lines with
  ranges; includes publishDiagnostics pushed by servers (hover-free truth)
- `definition` / `typeDefinition` / `implementation` — file/line/char →
  uri:line:char lists (all three: cheap once definition exists)
- `references` — call sites, with context lines
- `hover` — types + docs on demand (the model's "what IS this")
- `documentSymbol` / `workspaceSymbol` — outline + symbol query (feeds a
  future bb_search symbol join)

**Tier 2 — registered, exposed, used on demand (v1.x):**

- `completion` — YES, even though the model doesn't type: completion items
  carry signatures/docs the model can request deliberately ("what methods
  does this value have") — a discovery surface, not typing aid
- `signatureHelp` — argument lists at call sites; genuinely useful when the
  model half-remembers an API
- `codeAction` — quickfixes LISTED; applying them is execute-one (see gates)
- `formatting` / `rangeFormatting` — server-formatted diffs, applied via the
  same file-mutation queue as edit/write (withFileMutationQueue)
- `callHierarchy` — incoming/outgoing; "who calls this" beyond flat
  references (recursion, overrides)
- `typeHierarchy` — supertypes/subtypes; the Rust trait/TS interface walk
- `selectionRange` — semantic range expansion (statement→block→function)
- `semanticTokens` — full legend/range fetch (rendering use later; the
  data's there for §Search symbol joins)
- `linkedEditingRange` / `foldingRange` / `documentHighlight` /
  `documentLink` / `documentColor` — the long tail; cheap to expose once
  the client exists, listed for completeness, used rarely

**Tier 3 — WRITE paths, gated (v1.x, behind §Plan-style approval):**

- `rename` — symbol-wide rename via server edits; preview → confirm; runs
  through withFileMutationQueue; result reports files+touched ranges
- `codeAction execute` — apply a chosen quickfix (organize imports,
  auto-fix); same gate + queue
- `codeLens` — registered client capability; resolve-on-demand (lens
  commands can carry server-side writes → treated as Tier 3)

**Explicitly OUT (with reasons, so future-us doesn't relitigate):**

- `willSave/waitUntil` save-advice hooks — no save concept to hook
- workspace edits from server-initiated `applyEdit` — accepted + reported,
  never auto-applied (same gate as Tier 3)
- `moniker` / `callHierarchy`-supersets / experimental/* — no consumer yet;
  capability-registered, ignored until one exists

The rule that keeps this sane: **capabilities are cheap to register, actions
are explicit.** The client advertises nearly everything (servers unlock their
best behavior), but every surface is one bb_lsp action away — nothing writes,
nothing spams context, nothing auto-runs.

### Relation to §Search

Complementary, not competing: FTS = text recall ("where did we talk about
X"), LSP = semantic precision ("what IS X, who calls it, why is it wrong").
code_fts stays the no-server fallback; later, bb_search symbol hits can
link into bb_lsp definition lookups.

### Testing

- Unit: framing codec round-trips, correlation IDs, timeout paths — against
  in-memory streams, no processes.
- Integration: a **fake LSP server** — small Node script speaking real
  protocol over stdio, scripted to emit diagnostics/definitions — full
  lifecycle/sync/restart tests deterministic and dependency-free.
- e2e (opt-in tier): real rust-analyzer / deno lsp under the tmux harness,
  gated on `BB_E2E_LSP=1` + server presence, so CI never needs them.

### Open questions

- [x] **TypeScript server sourcing** — DECIDED: bundle. `typescript-language-server`
      + `typescript` as runtime dependencies of blueberry. Dogfooding is the demo.
- [x] Post-edit nudge — DECIDED: lightweight MODEL-ONLY context clues. After
      edit/write tool results, a `display: false` custom message carries the
      diagnostics delta ("2 errors in src/foo.ts since your edit") — context
      the model can act on, invisible to the human. Humans have `bb lsp status`.
- [x] Statusline segment — DROPPED (same decision: humans have tools).
- [x] Daemon mode — DECIDED NO for v1: plain spawned child processes, stdio,
      per-session lifecycle. Lightest sustainable thing; reap at shutdown.
- [x] v1 language set — FINAL: rust-analyzer, gopls, deno lsp, clangd
      (installed) + typescript-language-server (bundled). Python/zig deferred.
- [x] Tier-3 — DECIDED: rename, codeAction execute, and codeLens resolve are
      first-class actions. Apply policy (the "idk" → decided): **edits that
      fulfill a requested action apply** through the file-mutation queue with
      a reported summary (files + ranges); **spontaneous applyEdit** (no
      in-flight user action) is accepted + reported as a preview, never
      applied. Surprise-writes are structurally impossible; requested ones
      don't pay a confirmation tax.
- [x] Embedding — DECIDED: lsp-client + lsp-manager live in `src/core/`
      (the framework), the pi extension stays a thin shell. Not optional,
      not deferred — core subsystem, same standing as sync/search.

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
