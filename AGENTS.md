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
- `src/core/search.ts` + `src/core/tools/search.ts` — embedded disk-based search engine (flagship): logic in core, tool registration under tools/
- `themes/` — `orange-juice.json` and friends
- `bin/blueberry` — launcher: prefers the compiled binary (`deno task compile` → `dist/blueberry`), falls back to `deno run`
- `bin/setup.sh` — writes `~/.blueberry/settings.json`, carries auth + packages
- `DESIGN.md` — design notes for the flagship builds. Read before implementing.

## Dev loop

This repo is **Deno-native**. The toolchain is `deno.json` tasks; `package.json`
exists only for the `pi` manifest, the version source of truth, and npm deps
(typescript-language-server) — it is not the build system.

1. Edit extension/theme files in this repo (loaded live from disk — no install/copy step).
2. In a running blueberry session: `/reload`. Theme files hot-reload without `/reload`.
3. Type-check: `deno task check`
4. Test: `env -u BLUEBERRY_DB deno task test` — the `env -u` matters when testing
   from inside a live blueberry session (the launcher exports `BLUEBERRY_DB`, which
   breaks one launcher handover test that asserts it's unset).
5. Inspect the composed system prompt:
   `env -u BLUEBERRY_DB deno run -A --config deno.json scripts/dump-prompt.ts`
   renders the exact prompt a session boots with (all probe options enabled:
   lsp, design lifecycle, todos). Use it before and after any prompt-surface
   change — it composes from live sources, so it doubles as a preview canvas
   for proposed prompt edits.

**Never run bare `node --test`** — it sweeps 607 vendored test files under the
in-tree `pi/` fork source and wedges. The npm `test` script delegates to deno for
this reason.

## Testing a launcher change

`./bin/blueberry -p --no-session "reply with exactly: ok"` — fast smoke test that
exercises extension loading end to end.

## When implementing a flagship

Read `DESIGN.md` first, resolve its open questions with the user, then implement
inside the matching `extensions/<name>/` directory. Prefer small committed steps
on `mainline`.
