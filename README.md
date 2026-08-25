# blueberry 🫐

This is my harness. There are many like it, but this one is mine.

A personal agentic coding harness.

This harness reflects my specific way of working. I had been a Principal Engineer at multiple tech companies before adopting AI tooling, so this harness reflects my experience, my desires, and my needs. It is not designed for vibe coding, and it is not designed to be generic. Using this harness requires advanced knowledge in engineering practices and it is designed for focused, long-horizon work. I encode my way of working into every aspect of this harness, from the system prompt to mid-conversation context to on-disk storage to built-in tooling.

You are welcome to read the source and use the harness for your own personal, noncommercial purposes. It is licensed under PolyForm Strict (no distribution, no sublicensing — see `LICENSE.md`, or run `blueberry --license`). Portions derived from pi-mono remain under MIT per its notice.

Pull requests are not accepted, and GitHub issues are not welcome. If you have a feature request, or you hit an obscure bug, you can send me an email about it; I will report your email as spam if I suspect it's written by AI.

You are welcome to tag me on Threads if you want to discuss it, I'm always happy to chat.

## Quick start

Install the latest release (macOS arm64/x86_64, Linux x86_64, Windows x86_64):

```bash
curl -fsSL https://raw.githubusercontent.com/siennathesane/blueberry/mainline/bin/install.sh | sh
```

Windows: release assets are pending — the suite carries unix assumptions. Darwin (arm64 + x86_64) and linux (x86_64)
publish normally, and the windows matrix job stays visible-but-failing until
that debt is paid.

Installs a checksum-verified binary to `~/.blueberry/bin` (override with
`BB_INSTALL_DIR`; `bb update` self-updates from then on). From a checkout
instead:

```bash
./bin/setup.sh        # one-time: create ~/.blueberry, write settings, install carried packages
alias bb='~/Development/blueberry/bin/blueberry'
bb                    # launch the agent in this project
```

`bin/blueberry` is one binary with two faces: the management CLI and the
agent itself. A launch resolves the project you're in, canonicalizes to its
root, and runs the agent **in-process** — the forked pi framework
(`pi/`) is loaded as a library, not spawned. State lives in
`~/.blueberry/blueberry.db` (override the directory with
`BLUEBERRY_AGENT_DIR`).

For a release artifact: `bash bin/compile.sh` type-checks, tests, compiles
the single binary, smoke-proves DB-only persistence, and emits
`dist/blueberry-<os>-<arch>` + `.sha256`. `bb update` then self-updates
from GitHub releases (checksum-verified, atomic swap).

First run: if `setup.sh` couldn't copy your existing `auth.json`, run `/login` once inside blueberry.

## Sessions are per-project, database-backed

No matter how deep in the tree you launch from, sessions land in the
project's store and resume correctly: launching from `extensions/todo/`
behaves identically to launching from the root. Identity travels with the
repo (`.git/blueberry-id`, `.lore/blueberry-id`), so moving or re-cloning a
project auto-reattaches its history — worst case is a split you can merge,
never lost sessions.

**Every session write lands in `blueberry.db`** (sessions, entries, FTS
index). No JSONL files are ever created; `bb restore` can rebuild the
pi-compatible resume files from the DB if you ever need them. Sessions
survive crashes — persistence doesn't wait for clean shutdown.

```bash
bb                          # launch (canonicalized to project root)
bb --here                   # launch with THIS dir as session cwd (may fragment — you opted in)
bb --project <slug>         # launch a registered project from anywhere

bb projects list            # what's registered, where sessions live
bb projects rename|merge|forget|nest|unnest   # identity surgery
bb projects sessions central|repo <slug>     # per-project store location

bb sessions list [--all]    # newest first; names, first prompts, message counts
bb sessions rename <sel> <name>   # rename (survives /tree)
bb sessions move <sel> <project>  # move a session between projects
bb sessions open <sel>      # resume a session in its project (from anywhere)
bb sessions trash <sel>     # trash, never delete

# §Library: cross-project session access (read-only; fork copies into YOUR store)
bb sessions show <[proj/]sel> [--view summary|tree|messages|message] [--message N]
bb sessions search <text> [--all]   # scan session text across projects
bb sessions fork <[proj/]sel>       # name@project copy in the current store
# the model gets the same powers via the bb_library tool (single tool, action enum)

bb adopt [dir] [--copy]       # import legacy ~/.pi/agent history (groups by header cwd, stamps gaps;
                              #   --copy leaves the old tree untouched, re-runs skip duplicates)
bb sync / bb restore          # manual DB reconcile / rebuild resume files from the DB
bb search <text> [--code]     # FTS5 search: session history + code, with context neighborhoods
bb fix / bb doctor            # reconcile orphans, stale cwds, dangling forks, split-brain
bb update [--check]           # self-update from GitHub releases (sha256-verified, atomic)
```

Session selectors: list index (1-based), UUID prefix, or exact name.

## What's in here

| Path | Purpose |
| ------ | --------- |
| `src/core/` | Session & project management, DB stores, todo DAG, search, LSP client/manager, design/plan lifecycle, context composer, updater |
| `src/cli/` | `bb` command dispatch + launch mode (dependency-injected, fully tested) |
| `pi/` | **The fork** (vendored for modification — see `pi/FORK.md`): DB-only session persistence, in-process library runtime |
| `extensions/core/` | Identity (branding, title guard, session-start guard) + §Context: zero-eviction system-prompt identity, per-turn state & datetime rail |
| `extensions/plan/` | Design → plan → implement lifecycle: `bb_design`/`bb_plan` tools, shift+tab mode ring, completeness gate |
| `extensions/todo/` | DAG todo store, `bb_todo` tool, ctrl+p kanban pane, checkpoint digests |
| `extensions/search/` | `bb_search` — history + code search (FTS5) |
| `extensions/lsp/` | `bb_lsp` — real servers, real protocol, 23 actions, diagnostics nudges |
| `extensions/library/` | `bb_library` — cross-project session access for the model |
| `themes/` | `blueberry` (default) and `orange-juice`; hot-reload when edited |
| `vendored/` | Source copies of other upstream packages, **reference only** — see `vendored/VENDORED.md` |

## Dev loop (Deno-only)

- Edit anything under `extensions/`, `themes/` → `/reload` in a blueberry session.
- `deno task check` — type-check the whole graph (including the fork).
- `deno task test` — the suite (470 tests). `deno task coverage` enforces ≥95%.
- `deno task compile` → `bash bin/compile.sh` for release artifacts.
- Fork changes: edit `pi/packages/**`, rebuild via `cd pi/packages/coding-agent && npm run build` when the bundle is needed; `deno compile` embeds sources directly.

## Conventions

- The default branch is **`mainline`**, never `main`.
- The DB is the log of record; JSONL is an export format.
- The system prompt is frozen per session (zero cache eviction); all volatile context rides the ephemeral message rail.
- Never point the extension manifest at `vendored/`. Vendored code is reading material for rewrites, not loadable code. Record provenance in `vendored/VENDORED.md`.
