# blueberry 🫐🍊

A personal [pi](https://github.com/earendil-works/pi-mono) distribution.
Not a fork of pi — pi stays stock. This is everything *around* pi that makes it mine:
extensions, skills, prompts, a theme, and its own isolated agent directory.

Blueberry pi, served with orange juice.

## Quick start

```bash
./bin/setup.sh        # one-time: create ~/.blueberry, write settings, install carried packages
./bin/blueberry       # launch (alias this in your shell)
```

`bin/blueberry` runs stock `pi` with `PI_CODING_AGENT_DIR=~/.blueberry`, so blueberry has
its own settings, sessions, auth, and package list — completely separate from `~/.pi/agent`.
Override the directory with `BLUEBERRY_AGENT_DIR`.

First run: if `setup.sh` couldn't copy your existing `auth.json`, run `/login` once inside blueberry.

## What's in here

| Path | Purpose |
| ------ | --------- |
| `extensions/core/` | Identity: startup header, branding, misc behaviors |
| `extensions/plan/` | **Rewrite of plan mode** (in design — see `DESIGN.md`) |
| `extensions/todo/` | **Todos that are actually useful** (in design — see `DESIGN.md`) |
| `extensions/search/` | **Embedded disk-based code search** (in design — see `DESIGN.md`) |
| `themes/orange-juice.json` | The orange theme. Hot-reloads when edited. |
| `prompts/`, `skills/` | Curated prompt templates and skills |
| `vendored/` | Source copies of upstream packages, **reference only** — see `vendored/VENDORED.md` |

## Dev loop

- Edit anything under `extensions/`, `prompts/`, `skills/` → `/reload` in a blueberry session.
- Edit `themes/orange-juice.json` while it's active → applied immediately, no reload needed.
- `npm install` once, then `npm run typecheck` to type-check extensions (`vendored/` is excluded).

## Conventions

- The default branch is **`mainline`**, never `main`.
- Extensions are TypeScript, loaded directly via jiti — no build step for runtime.
- Never point the `pi` manifest at `vendored/`. Vendored code is reading material for rewrites,
  not loadable code. Record provenance in `vendored/VENDORED.md`.
