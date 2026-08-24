# blueberry 🫐🍊

A personal [pi](https://github.com/earendil-works/pi-mono) distribution.
Not a fork of pi — pi stays stock. This is everything *around* pi that makes it mine:
extensions, skills, prompts, a theme, and its own isolated agent directory.

Blueberry pi, served with orange juice.

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

bb adopt [dir]              # import ~/.pi/agent history (groups by header cwd, stamps gaps)
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
| `themes/orange-juice.json` | The orange theme. Hot-reloads when edited. |
| `prompts/`, `skills/` | Curated prompt templates and skills |
| `vendored/` | Source copies of upstream packages, **reference only** — see `vendored/VENDORED.md` |

## Dev loop

- Edit anything under `extensions/`, `prompts/`, `skills/` → `/reload` in a blueberry session.
- Edit `themes/orange-juice.json` while it's active → applied immediately, no reload needed.
- `npm install` once, then `npm run typecheck` to type-check everything (`vendored/` excluded).
- `npm test` runs the suite; `npm run coverage` enforces ≥90% line/branch/function coverage on `src/`.

## Conventions

- The default branch is **`mainline`**, never `main`.
- Extensions are TypeScript, loaded directly via jiti — no build step for runtime.
- Never point the `pi` manifest at `vendored/`. Vendored code is reading material for rewrites,
  not loadable code. Record provenance in `vendored/VENDORED.md`.
