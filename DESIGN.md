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

## §Todo — todos that are actually useful

Upstream reference: `vendored/rpiv-todo/` (@juicesharp/rpiv-todo v2.7.0)

### What "useful" has to mean

- **The model calls it.** One tool, flat API, zero ceremony. If the tool
  signature is annoying the model stops using it and todos rot.
- **The user sees it.** Always-visible surface while work is in flight,
  not a command you run to check.
- **Branch-correct.** State reconstructed from tool-result `details` on the
  session branch (pi's documented pattern), so `/tree` navigation and forks
  don't corrupt the list.
- **It drives behavior, not just tracks it.** Next-action semantics: exactly
  one task in_progress, the model is nudged toward it via prompt guidelines.

### Proposed shape

- Tool `todo` with `action: list|create|update|complete|delete` (StringEnum),
  minimal fields: `subject`, `description?`, `status`, `blockedBy?` (ids).
- Rendering: `renderResult` compact list with markers; persistent widget
  above editor while any task is pending (TUI only, guarded by `ctx.mode`).
- Status line segment (e.g. `▢ 2/7 done · 1 blocked`) always.
- Session persistence via `details` reconstruction + `appendEntry` for
  TUI-only snapshots.
- Integration: `/plan` approval seeds the todo list from plan steps.

### Open questions

- [ ] Where should the live list live — widget above editor, status line, or overlay (rpiv-todo uses an overlay)?
- [ ] Do todos persist across sessions for the same project (a `.blueberry/todos.json`), or per-session only?
- [ ] Should blockedBy support chains and cycle detection? (pi's subagent todo tool does this; worth copying?)

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

## §Theme — orange-juice (shipped)

Shipped: `themes/orange-juice.json`. Core palette extracted from the user's
swatch image (2025-08-24): orange ramp `#e85f2e → #f9db4a`, neutrals
`#1f1f1f/#2a2a2a/#7f7f7f`, brown `#3e3324`, creams. Supporting colors
(moss green success, warm red error, warm grays) added deliberately —
core palette stays dominant. Thinking borders heat up the ramp; search
matches are yellow-on-brown.

## §Distribution — what "blueberry" installs (updated 2025-08-25)

Session/project management is in-repo (`extensions/core`-adjacent CLI code, see §Sessions),
not a carried package. Carried from the old setup: `pi-subagents`, `pi-web-access`,
`pi-lens`, `pi-mcp-adapter`. Rewritten in-repo (old packages dropped): plan-mode,
rpiv-todo, fff. Still dropped pending confirmation: `pi-background-tasks`, `pi-goal`.
For distribution: package source flips from local path to published npm/git name; the
launcher, registry, and CLI are the product surface.
