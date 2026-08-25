# blueberry 🫐

This is my harness. There are many like it, but this one is mine.

A personal agentic coding harness based on [pi](https://github.com/earendil-works/pi-mono). 

Pull requests are not accepted, and issues are not welcome. If you have a feature request, you can send me an email about it, but if I will report your email as spam if I suspect it's written by AI.

This harness reflects my specific way of working. I had been a Principal Engineer at multiple tech companies before adopting AI tooling, so this harness reflects my experience, my desires, and my needs. It is not designed for vibe coding, and it is not designed to be generic. Using this harness requires advanced knowledge in engineering practices and it designed for focused, long-horizon work. I encode my way of working into every aspect of this harness, from the system prompt to mid-conversation context to on-disk storage to built-in tooling.

You are welcome to use this harness as much as you'd like, you can clone it, fork it, or use it as a reference. However it is mine, and I will not accept contributions. You are also welcome to tag me on Threads if you want to discuss it, I'm always happy to chat.

## Quick start

```bash
./bin/setup.sh        # one-time: create ~/.blueberry, write settings, install carried packages
alias bb='~/Development/blueberry/bin/blueberry'
bb                    # launch pi in this project (alias this in your shell)
```

`bin/blueberry` is both the launcher and the management CLI. As a launcher it resolves the
project you're in, canonicalizes to its root, and runs stock `pi` with
`PI_CODING_AGENT_DIR=~/.blueberry` and a per-project session store — completely separate from
`~/.pi/agent`. Override the directory with `BLUEBERRY_AGENT_DIR`.

First run: if `setup.sh` couldn't copy your existing `auth.json`, run `/login` once inside blueberry.

## Sessions are per-project

No matter how deep in the tree you launch from, sessions land in the project's store and
resume correctly: launching from `extensions/todo/` behaves identically to launching from
the root. Identity travels with the repo (`.git/blueberry-id`, `.lore/blueberry-id`), so
moving or re-cloning a project auto-reattaches its history — worst case is a split you can
merge, never lost sessions.

```bash
bb                          # launch (canonicalized to project root)
bb --here                   # launch with THIS dir as session cwd (may fragment — you opted in)
bb --project <slug>         # launch a registered project from anywhere

bb projects list            # what's registered, where sessions live
bb projects rename|merge|forget|nest|unnest   # identity surgery
bb projects sessions central|repo <slug>     # per-project store location

bb sessions list [--all]    # newest first; names, first prompts, message counts
bb sessions rename <sel> <name>   # pi-native rename (survives /tree)
bb sessions move <sel> <project>  # move a session between projects
bb sessions open <sel>      # resume a session in its project (from anywhere)
bb sessions trash <sel>     # trash, never delete

# §Library: cross-project session access (read-only; fork copies into YOUR store)
bb sessions show <[proj/]sel> [--view summary|tree|messages|message] [--message N]
bb sessions search <text> [--all]   # scan session text across projects
bb sessions fork <[proj/]sel>       # name@project copy in the current store
# the model gets the same powers via the bb_library tool (single tool, action enum)

bb adopt [dir] [--copy]       # import ~/.pi/agent history (groups by header cwd, stamps gaps;
                              #   --copy leaves the pi tree untouched, re-runs skip duplicates)
bb fix / bb doctor          # reconcile orphans, stale cwds, dangling forks, split-brain
```

Session selectors: list index (1-based), UUID prefix, or exact name.

## What's in here

| Path | Purpose |
| ------ | --------- |
| `src/core/` | Session & project management: registry, markers, resolution, trust, JSONL surgery, adopt, fix |
| `src/cli/` | `blueberry`/`bb` command dispatch + launch mode (dependency-injected, fully tested) |
| `extensions/core/` | Branding + session-start guard (warns when a launch would fragment history) |
| `extensions/plan/` | **Rewrite of plan mode** (in design — see `DESIGN.md`) |
| `extensions/todo/` | **Todos that are actually useful** (in design — see `DESIGN.md`) |
| `extensions/search/` | **Embedded disk-based code search** (in design — see `DESIGN.md`) |
| `themes/blueberry.json` | The blueberry theme (default). `themes/orange-juice.json` too. Both hot-reload when edited. |
| `prompts/`, `skills/` | Curated prompt templates and skills |
| `vendored/` | Source copies of upstream packages, **reference only** — see `vendored/VENDORED.md` |

## Dev loop

- Edit anything under `extensions/`, `prompts/`, `skills/` → `/reload` in a blueberry session.
- Edit the active theme file (`themes/blueberry.json` by default) → applied immediately, no reload needed.
- `npm install` once, then `npm run typecheck` to type-check everything (`vendored/` excluded).
- `npm test` runs the suite; `npm run coverage` enforces ≥90% line/branch/function coverage on `src/`.

## Conventions

- The default branch is **`mainline`**, never `main`.
- Extensions are TypeScript, loaded directly via jiti — no build step for runtime.
- Never point the `pi` manifest at `vendored/`. Vendored code is reading material for rewrites,
  not loadable code. Record provenance in `vendored/VENDORED.md`.
