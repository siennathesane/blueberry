---
id: 06d1a2
title: Reference grammar — plain-English links, bb:// deep links, registered at install
status: decided
id_note: 12 ids registered in lifecycle_ids at decide 2026-08-26
date: 2026-08-26
parent: 005-lifecycle-coverage-map.md
source: user directives (2026-08-26): every reference in plain English with markdown links; todos link via a real scheme, registered as part of install (macOS + Linux, Windows if easy); fallback chain A → B → in-line; nothing written to disk for state — the database stays the only surface
---

# Reference grammar

## Audience

Blueberry's maintainer and the resident model. This defines how references
to documents, sections, plans, todos, and cards are written and linked in
every surface the harness produces — replies, commit messages, todo
titles, breadcrumbs, failure blocks, docs.

## Problem

References today are sigil soup: `§2 #4–#7`, bare doc numbers, naked
codenames, parenthetical source tags. They compress insider knowledge into
strings that cannot be read aloud, cannot be clicked, and decay the moment
context is lost. A todo title like "cosmetics cluster — 1-based
normalization, (none) disambiguation, workspaceSymbol error, cold-start
retry (feedback §2 #4–#7)" is four references deep with nothing clickable.
Todos live in the database, so "click the todo" has no target at all
today. [1f0c11]

## Goal

Every reference is a short plain-English name plus a working link. For
files, the link is a repo-relative markdown path. For todos and cards,
the link is a `bb://` deep link backed by a registered URL scheme with a
new-tab handler, installed as part of blueberry's setup, with a tested
fallback chain that ends in the referenced content rendered in-line.
[2e1d22]

## Non-goals

- No new state on disk: the database remains the only data surface. The
  scheme registration writes system-integration artifacts (a shim app, a
  desktop entry) — never blueberry data.
- No Windows commitment beyond the easy registry path; anything harder
  is ledgered.
- No reformatting of historical artifacts; the grammar governs new text.
- OSC 8 emission stays out of markdown code blocks and machine-joined
  lines (the design-id grammar owns line ends).

## The reference grammar

A reference is a plain-English name plus a markdown link: `[name](target)`.
The name must be readable aloud; the target must be real. For documents:
repo-relative paths with optional `#section` anchors. For todos and
cards: `bb://` deep links. Sigils are banned from prose: no `§`, no `R#`,
no bare document numbers, no codenames standing alone — a codename may
follow a name and link, never replace them. Structural surfaces (todo
titles, breadcrumbs) carry plain English with no parenthetical source
tags; their linkage lives in metadata, not in the title text. The
design-id grammar of 005 is untouched: `[hex6]` at line ends is a machine
join key, and prose mentioning a requirement still links the document.
[3d2f33]

## The deep link scheme

Canonical form: `bb://todo/<project-slug>/<hex6>` (extensible to other
object kinds later). The CLI gains `blueberry todo show <slug> <hex6>`
which reads the database and prints the card, its stage, its dependency
edges, and its event history. Rendered surfaces emit `bb://` links as
OSC 8 hyperlinks when stdout is a terminal, so the links display
correctly even before any registration exists. [4c3a44]

## Registration at install

`blueberry deeplink register` runs as part of install (setup script and
doctor both call it) and is idempotent. macOS: writes a minimal shim
application (an AppleScript wrapper under ~/Applications) declaring the
`bb` scheme via CFBundleURLTypes, plus the LaunchServices handler entry;
clicking routes through NSWorkspace. Linux: writes a .desktop entry to
the user applications directory declaring `x-scheme-handler/bb` and sets
the default via xdg-mime. Windows: writes the per-user registry classes
key with `URL Protocol` when the platform allows it easily; otherwise it
reports unsupported and does nothing else. `deeplink unregister` reverses
all of it; `deeplink status` reports what is live without mutating
anything. [5b4b55]

## Handler behavior

The registered shim receives `bb://todo/<slug>/<hex6>` and opens a new
terminal tab running `blueberry todo show <slug> <hex6>` — via
`ghostty +new-tab -e` when Ghostty is the terminal, else via a
configurable terminal command in settings, else a plain new-window
invocation of the default terminal. The tab is the display; the database
is the read; nothing persists from the click. [6a5c66]

## The fallback chain

At render time the harness resolves capabilities once per session:
scheme registered (the A path) → emit the `bb://` link as a live
hyperlink; scheme absent but Ghostty's link matcher is the active
terminal (the B path, detected by environment and config) → emit the
`bb://` URL as plain text the matcher will catch; neither → load the
reference in-line: the todo renders as its own card summary (title,
stage, breadcrumb) instead of a pointer, and the document reference
renders as its path plus section title. The same probe feeds the
renderer, the doctor, and `deeplink status` — one source of truth. The
chain never fails closed: worst case, the content is already on screen.
[796d77]

## Plan enforcement

`bb_plan passes` gains a sixth check: reference hygiene. Design and plan
bodies are scanned for sigil patterns — `§`, bare `R\d+`, document
numbers standing alone, `todo:` needles in prose — and offenders fail
with the line named. The check refuses, it does not advise. [887e88]

## Failure blocks

The lifecycle failure block upgrades its references: the design document
path becomes a markdown link, and open cards render as `bb://` deep
links (falling back per the chain). The block remains plain text in
shape; only its references become load-bearing. [9a8f99]

## System prompt ownership

The fork composes the stock system prompt (base text, tool list,
guidelines, pi-docs routing) and blueberry appends its identity after it —
stacking two identities and duplicating routing lines. Blueberry takes
ownership of the composed prompt: its own base text replaces the stock
intro through the fork's customPrompt seam, the pi-docs routing block
shortens and gates on the project actually being pi-internals work, and
the stock guidelines fold into blueberry's single guideline list. The
fork's buildSystemPrompt remains the assembler; the bytes become
blueberry's. The Rail-1 append in the core extension becomes a replace.
Result: one identity, one guideline source, no stale grammar (the design
lifecycle paragraph still describing RFC 2119 MUSTs is corrected here
too). [ce0dcc]

## System prompt

The prompt contract (landing with the prompt-update card) carries one
paragraph: references are spoken names with links; sigils belong to
machines at line ends only; when no link can live, put the content
in-line. [ab9aaa]

## The id minter

The harness exposes a visible tool that mints design ids on demand:
`bb_mint_id` draws a collision-free `[hex6]` from the registry (the same
mintId core, checked against every live card, registered id, and retired
id) and registers it immediately with an optional note. It is listed in
the tool surface with a trigger-first description — "mint a design id
when writing an acceptance test or a requirement patch" — so the model
reaches for it instead of hand-picking hex strings (which is exactly how
provisional-id drift happens). Minting outside decide remains
exceptional; the tool's result text says so, reminding the caller that a
requirement paragraph should normally be minted at decide time and that
this id now exists in the registry. [bcd8bb]

## Risks

- **Scheme squatting:** `bb://` is short; another tool could claim it.
  Registration is per-user and reversible; doctor reports conflicts.
- **Shim maintenance:** the AppleScript wrapper is a second code path;
  it stays under 400 bytes and does nothing but exec the CLI.
- **Matcher drift:** Ghostty's link rules are config surface we do not
  own; the B path is detected, not assumed, and degrades to in-line.
- **In-line bloat:** loading references in-line can grow messages; the
  in-line form is the card summary, never the full event history.

## Requirements

Every reference the harness or model writes is a plain-English name plus
a markdown link to a real target, or the content itself in-line when no
link can live. [1f0c11]

Prose carries no sigils: section marks, requirement numbers, bare
document numbers, and lone codenames are refused in generated text.
[3d2f33]

Todo and card references use the canonical `bb://todo/<slug>/<hex6>`
deep link, served by `blueberry todo show` reading only the database.
[4c3a44]

Scheme registration is part of install on macOS and Linux (and Windows
when the easy path holds), is idempotent, reversible, and writes no
blueberry data — only system-integration entries. [5b4b55]

Clicking a deep link opens a new tab (Ghostty first, configurable
terminal command as fallback) that displays the referenced card.
[6a5c66]

Render-time resolution follows the chain: registered scheme, then
terminal link-matcher, then in-line content — probed once per session
and never failing closed. [796d77]

A harness tool mints and registers design ids on demand — visible in
the tool surface, trigger-first description, result carrying the
decide-time rule. [bcd8bb]

Plan bodies are enforced: a sixth pass refuses sigil patterns in design
and plan text, naming the offending lines. [887e88]

Lifecycle failure blocks render their references as links per the same
grammar and chain. [9a8f99]

Blueberry owns its system prompt end to end: base text, guidelines, and
routing compose through the fork's assembler with blueberry bytes — one
identity, no stock duplication, no stale grammar. [ce0dcc]

## Open questions

None blocking. The plan owns: the exact Ghostty detection env/config
keys, the shim's AppleScript content, and whether `todo show` grows a
`--json` flag for future surfaces.
