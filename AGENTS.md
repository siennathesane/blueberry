# AGENTS.md — working ON blueberry

This repo is a personal pi **distribution**: stock `pi` plus everything that makes it mine.
You are almost always developing extensions here, not using them.

## Ground rules

- **The default branch is `mainline`** — always. Never `main`, never `master`.
  `git init` defaults to `main`, so rename immediately on new clones/checkouts.
- `vendored/` is **reference-only**. Read it, learn from it, rewrite from scratch —
  but never wire it into the `pi` manifest and never "fix" vendored code.
  Provenance lives in `vendored/VENDORED.md`.
- Extensions are plain TypeScript loaded by jiti — no compilation, no bundler.
  Keep them dependency-light; anything heavyweight needs a reason in `DESIGN.md`.

## Layout

- `extensions/core/` — branding, header, small behaviors
- `extensions/plan/` — plan mode rewrite (flagship)
- `extensions/todo/` — todo system rewrite (flagship)
- `extensions/search/` — embedded disk-based search engine (flagship)
- `themes/` — `orange-juice.json` and friends
- `bin/blueberry` — launcher: `PI_CODING_AGENT_DIR=~/.blueberry exec pi "$@"`
- `bin/setup.sh` — writes `~/.blueberry/settings.json`, carries auth + packages
- `DESIGN.md` — design notes for the flagship builds. Read before implementing.

## Dev loop

1. Edit extension/theme files in this repo (loaded live from disk — no install/copy step).
2. In a running blueberry session: `/reload`. Theme files hot-reload without `/reload`.
3. Type-check: `npm install && npm run typecheck` (vendored/ excluded).

## Testing a launcher change

`./bin/blueberry -p --no-session "reply with exactly: ok"` — fast smoke test that
exercises extension loading end to end.

## When implementing a flagship

Read `DESIGN.md` first, resolve its open questions with the user, then implement
inside the matching `extensions/<name>/` directory. Prefer small committed steps
on `mainline`.
