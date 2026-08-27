---
id: c74f80
title: Skills — curation, authoring, and the skills mode
status: abandoned
date: 2026-08-25
---
# Skills — curation, profiles, and the slash purge

## Summary

Blueberry today inherits stock pi skill behavior wholesale: every skill on disk
(~/.agents/skills, 101 of them — 29 sunbeam, 8 deno, a marketing pile, obsidian,
plasmic…) is advertised into every session's system prompt (~44.8k chars ≈ 11.2k
tokens of descriptions per prompt) and every one registers a `/skill:*` command,
flooding the slash palette the user needs for harness control. This design
inverts that: **slash commands are the human's harness controls; skills are
model capabilities.** We purge skill commands from the palette entirely,
advertise only a curated per-project set in the prompt, and make the full corpus
searchable by the model on demand (stage-zero progressive disclosure), with
named profiles as the curation unit and a consent-gated suggestion flow for the
model to propose enablement.

## Audience            <!-- REQUIRED (PRFAQ) -->

- **Sienna (the user)** — today: zero per-project control over skills, a `/`
  palette buried under 101 `/skill:*` entries, and every prompt carrying ~11.2k
  tokens of irrelevant descriptions (marketing skill ads while debugging a Rust
  renderer). Gets: a clean palette, per-project and per-session profiles, CLI
  curation (`bb skills …`), and the final say on every enablement — all of it
  feed-quiet.
- **The model (in any session)** — today: an undifferentiated wall of
  trigger-rich descriptions competing for attention, and no way to find a skill
  whose description isn't currently advertised. Gets: a small curated visible
  set, a `bb_skills` search tool over the whole corpus, the ability to read and
  use any skill immediately without ceremony, and a suggestion channel to ask
  the user for promotion.
- **The skills corpus itself** — untouched. Other harnesses (claude code,
  codex) share `~/.agents/skills`; blueberry curates *views* over it, never
  edits other tools' files.

## Problem             <!-- REQUIRED (Gerrit) -->

Two problems, one root cause. **User experience:** pi registers every skill as
a `/skill:<name>` command; with 101 skills the slash palette — the primary
control surface for the harness (`/model`, `/settings`, `/design`, `/todo`,
mode ring adjacent commands) — is clogged to the point of being unusable. There
is no per-project say in which skills load; the only lever is filesystem
surgery. **Model experience:** skill descriptions are always-in-context
(stage-one progressive disclosure, ~11.2k tokens measured), so descriptions for
sunbeam CLI, Deno, and ad copywriting compete for the model's trigger
attention in every session of every project — misfires cost attention even
when they don't fire. The root cause: pi's skill surface treats "advertised in
prompt", "invocable via slash", and "present on disk" as one all-or-nothing
switch per skill. Blueberry needs these three concerns separated.

## Goal                <!-- REQUIRED -->

When this ships: no blueberry session shows any `/skill:*` command in the
palette; the system prompt advertises only the active profile's skills; the
model can search, read, and use any skill in the corpus mid-session without
feed ceremony; the model can propose promoting a skill to the visible set and
only explicit user consent makes it so; skill activation is invisible in the
feed beyond the ordinary tool exchange; and switching a project's profile is
one command whose effect is honestly reported ("live next session" vs "used
now").

## Non-goals           <!-- REQUIRED -->

- **Skill authoring** (`bb skills new`, scaffolding, session-to-skill
  distillation) — out of v1. `skillify` skill already covers ad-hoc
  authoring; a native flow can be its own design later.
- **Auto-inference of profiles from project stack** — deferred by decision
  (2025-08-26). Explicit-first; inference may return as a *suggestion* later.
- **Editing or re-homing the corpus** — no mass `disable-model-invocation`
  frontmatter edits, no moving directories; other harnesses share these files.
- **Live mid-session prompt mutation** — pi loads skills at startup only; we
  do not fight this. In-session use works by reading; promotion is config.
- **A `/skills` interactive pane** — CLI + tool first, pane later if wanted
  (it would be one command, not 101 — legitimate palette use).
- **A statusline segment** — DECIDED NO (2025-08-26): humans have tools;
  `bb skills` reports the active profile.

## Approaches considered   <!-- REQUIRED: ≥2, verdicts kept -->

### Approach A: settings-only (stock pi knobs)
Set `enableSkillCommands: false` + hand-maintain `skills: [...]` path lists in
settings.json.
- Pros: zero code; both keys already exist in pi.
- Cons: settings lists are absolute paths, global (not per-project), no
  patterns/globs, no search over the un-advertised corpus, and hand-listing
  30-skill collections is unsustainable. Keeps the curation burden on the user
  with no model-side relief.
- Verdict: **rejected** — the two settings are *necessary* (we use both) but
  *nowhere near sufficient*; this is one input, not a design.

### Approach B: per-project `.pi/settings.json` skills arrays
Write the visible set into each repo's `.pi/settings.json`.
- Cons: config truth leaves `blueberry.db` (violates §Data's
  DB-is-truth/files-are-materialized), lives in repos (commits, drift,
  per-clone divergence), still no patterns, no corpus search, no suggestion flow.
- Verdict: **rejected** — wrong home for truth.

### Approach C: DB profiles + launcher materialization + corpus index (chosen)
Profiles in `blueberry.db` (include/exclude patterns over skill names), the
launcher materializes the visible set (exec pi with `--no-skills` +
`--skill <visible-dir>` + `--skill <blueberry core skills>`), corpus indexed
into the unified FTS (`source: 'skill'`), `bb_skills` tool for search/suggest.
- Pros: per-project + per-session granularity; patterns make collections
  one-line (`sunbeam-*`); corpus stays fully reachable; honest about startup
  loading; zero edits to foreign files; settings materialization already
  exists for `enableSkillCommands: false`.
- Cons: more machinery (materialized dir, index rows, launcher flags);
  symlink semantics need verification; profile changes are next-launch.
- Verdict: **chosen** — the only shape that serves both audiences without
  fighting pi's mechanics.

### Approach D: keep discovery, mass-edit frontmatter to hide skills
Walk the corpus adding `disable-model-invocation: true` to everything not wanted.
- Cons: edits other harnesses' shared files, re-broken on every skill update,
  still doesn't remove `/skill:*` commands (that flag *requires* them), whack-a-mole forever.
- Verdict: **rejected** — hostile to the corpus and doesn't even work.

## Decision            <!-- REQUIRED -->

Approach C. Concretely:

1. **Slash purge.** Launcher materializes `enableSkillCommands: false` into
   settings (existing §Data materialization path). `/skill:*` never registers;
   the palette is harness controls only. The `/` palette is the user's control
   surface; skill invocation is the model's job, via prompt advertising and
   `bb_skills`.
2. **Stage-zero progressive disclosure.** Three tiers replace two:
   (0) curated visible set — profile-resolved skills, descriptions in the
   system prompt (materialized dir, `--no-skills` + `--skill`);
   (0.5) the corpus — every skill on disk, FTS-searchable via `bb_skills`,
   readable by the model at will (a skill is a file; using one ≠ enabling one);
   (1) full SKILL.md content — read on demand, as today.
3. **Profiles.** Named include/exclude pattern sets stored in blueberry.db
   (`config['skills']`): `profiles`, `project_defaults: {slug → profile}`,
   `session_overrides: {session-id → profile/extra}`. Resolution expands
   patterns against the indexed corpus. Blueberry's own package skills dir
   (`./skills`, currently empty) is always included as a core set. **Default
   profile for unconfigured projects: `minimal` (core only)** — DECIDED
   (2025-08-26); the unconfigured state must be cheap, not a backslide to 101
   descriptions.
4. **The suggestion flow.** `bb_skills` actions: `search` (FTS over corpus),
   `show` (frontmatter + summary), `suggest` (queue a promotion proposal).
   The model uses a corpus skill immediately by reading it — no ceremony, no
   consent needed for *use*. Promotion (pin to project profile) is a config
   write requiring explicit user consent in-conversation; suggestions never
   self-apply.
5. **Feed-quiet activation** (DECIDED 2025-08-26). Skill activation is
   invisible in the feed: the model using a skill surfaces only as the
   ordinary read tool call (no announcements, no toasts); pin/suggest state
   changes log `skill:` breadcrumbs with `display: false` (context for search
   and reorientation, not for the human); the consent exchange itself is the
   only user-visible artifact, and it's conversation, not UI noise.
6. **"Skills mode" resolved:** skills are ambient capability, not a lifecycle
   phase — **no mode-ring change** (the ring is design→plan→normal work
   phases). The name refers to this subsystem.

## Risks & open questions   <!-- REQUIRED -->

- **Symlinked materialization dir** — DECIDED: symlinks (2025-08-26). Whether
  `loadSkills` follows symlinked skill dirs stays a step-1 implementation
  check; fallback is copies (cheap) or N `--skill` flags — cosmetic, not
  architectural.
- **`/reload` semantics** — skills almost certainly aren't re-read on reload;
  profile switching mid-session therefore means "next session". Document,
  don't fight.
- **Name collisions** at materialization (two corpus skills, same name — pi
  warns and keeps first): resolution should detect and refuse with the list,
  not silently drop.
- **Index staleness** — new skills on disk must appear in `bb_skills` search
  promptly (mtime walk, same policy as code_fts; stale-by-N-seconds acceptable).
- **Prompt injection via skill content** — a read skill can instruct anything.
  Accepted (reading is the point of skills); the trust boundary is *promotion*:
  consent-gated, logged, and reversible (`bb skills unpin`).
- **pi upgrades** changing `--no-skills`/`--skill` semantics: launcher pins to
  verified behavior; `bb doctor` gains a skills check.
- **[x] Default profile for unconfigured projects** — DECIDED (2025-08-26):
  `minimal` (core skills only).
- **[x] Statusline segment** — DECIDED NO (2025-08-26): humans have tools.

## Requirements        <!-- REQUIRED (RFC 2119) -->

- R1. Blueberry sessions MUST NOT register `/skill:*` commands in the slash
  palette (`enableSkillCommands: false` materialized at launch).
- R2. The system prompt MUST advertise only the resolved visible set
  (profile + session override + core skills); corpus-wide advertising MUST NOT
  occur (launcher runs pi with `--no-skills` plus explicit `--skill` paths).
- R3. The full corpus MUST be searchable mid-session via `bb_skills search`
  (BM25 over name+description) without the skill being advertised.
- R4. The model MUST be able to read and use any corpus skill mid-session by
  path, with no enablement step.
- R5. Profile/promotion writes MUST NOT alter a running session's prompt;
  their results MUST state when the change takes effect (next session).
- R6. Pinning a skill to a profile MUST require explicit user consent; every
  pin/suggestion MUST log a breadcrumb (`skill:` needle) to the session log.
- R7. Profiles SHOULD support include/exclude patterns (globs) over skill
  names, and every project SHOULD have a default profile (fallback: minimal).
- R8. Session overrides SHOULD compose with the project profile (extra skills
  in addition to, not instead of, the profile set).
- R9. Blueberry's own package skills dir MUST always be in the visible set.
- R10. The system MUST NOT auto-infer profiles from project contents (deferred).
- R11. The corpus MUST NOT be modified by blueberry (read/index/curate only).
- R12. Skill activation MUST be feed-quiet: no toasts, no announcements; the
  model's use of a skill surfaces only as the ordinary read tool call; and
  pin/suggest breadcrumbs MUST carry `display: false`.

## Verification        <!-- REQUIRED -->

- V1 (R1): launch `./bin/blueberry` in a test project; enumerate palette/commands —
  zero `/skill:*` entries; `grep enableSkillCommands ~/.blueberry/settings.json` is false.
- V2 (R2): with profile `minimal`, `bb_skills`-visible prompt check (pi's
  rendered system prompt via debug flag or a probe skill description) contains
  no corpus skill descriptions; with `sunbeam` profile, exactly the expanded
  set appears. Unit: pattern expansion (`sunbeam-*` minus excludes) matches
  the resolved list.
- V3 (R3, R4): in a session whose profile excludes marketing skills,
  `bb_skills search "cold email"` returns the cold-email skill with its path;
  `read` of that SKILL.md succeeds.
- V4 (R5): `bb_skills` pin mid-session returns "pinned — live next session";
  the running session's advertised set is unchanged (same probe as V2).
- V5 (R6): pin without user consent refuses (tool contract + guideline
  enforcement in review); pin with consent writes config + emits a
  `skill:<project>/<name>` breadcrumb findable in session search.
- V6 (R7–R9): unit tests — glob include/exclude resolution, project default
  fallback (minimal), session-override composition, core-skills always-present.
- V7 (R11): corpus tree hash before/after any blueberry operation is identical.
- V8: launcher smoke test (`./bin/blueberry -p --no-session "reply ok"`) green
  with materialization on; `bb doctor` skills check green.
- V9 (R12): pin/use a skill mid-session — zero `ctx.ui.notify` calls for
  activation; JSONL shows the `skill:` breadcrumb with `display: false`; the
  only feed-visible artifact is the ordinary read tool call.