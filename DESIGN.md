# blueberry DESIGN

Design notes for the flagship builds. Each section lists the proposed shape,
the reasoning, and **open questions to resolve with the user before implementing**.
Reference implementations live in `vendored/` — read them, don't revive them.

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

## §Theme — orange-juice

Shipped: `themes/orange-juice.json`. Core palette extracted from the user's
swatch image (2025-08-24): orange ramp `#e85f2e → #f9db4a`, neutrals
`#1f1f1f/#2a2a2a/#7f7f7f`, brown `#3e3324`, creams. Supporting colors
(moss green success, warm red error, warm grays) added deliberately —
core palette stays dominant. Thinking borders heat up the ramp; search
matches are yellow-on-brown.

## §Distribution — what "blueberry" installs

Carried from the old setup: `pi-subagents`, `pi-web-access`, `pi-lens`,
`pi-mcp-adapter`. Deliberately dropped (being rewritten): plan-mode,
rpiv-todo, fff. `pi-background-tasks` and `pi-goal` currently dropped —
confirm whether to carry.
