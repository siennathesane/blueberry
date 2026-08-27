---
id: f42cac
title: Project root resolution: explicit capture via blueberry init, plain-marker scoping, session adoption
status: decided
date: 2026-08-27
---
# Project root resolution: explicit capture via blueberry init, plain-marker scoping, session adoption

## Summary
Plain project markers are minted wherever a session happens to start without VCS, and the boundary walk lets any plain-marked ancestor adopt every unmarked directory below it — the launcher then chdirs the session there and design docs follow. The 2026-08-27 incident (session in ~/Development/sunbeam/site adopted ~, docs written to ~/docs/design) was this rule plus HOME as the one ancestor every walk shares; the emergency fix excluded HOME specifically. This design generalizes: implicit mints never capture descendants, subtree ownership requires an explicit `blueberry init`, and init surfaces the session-adoption commands so misfiled history can be repaired.

## Audience
blueberry users launching sessions in workspace trees whose roots have no VCS (~/Development/sunbeam and friends). Today they get silent project hijack: the wrong project resolves, the session relocates, and design docs land in the wrong tree. After this ships: the launch directory is the project unless they explicitly claim a subtree, and one command both mints and explains how to adopt existing sessions.

## Problem
`boundaryAt()` treats a `.blueberry/id` marker as a plain boundary, and `findProjectBoundary()` walks up with nearest-boundary-wins — so a plain marker minted accidentally (a session once launched in ~, or in ~/Development, or in ~/Development/sunbeam) captures every unmarked directory beneath it. `prepareLaunch()` then chdirs the session to the adopted root (correct in itself — pi's resume filtering is exact-cwd-equality), and `scaffoldDesign(proj.root, ...)` writes docs under that root. The user sees: wrong cwd, wrong header, docs in the wrong tree, and no command that says "this directory is a project, on purpose."

The registry already carries latent traps: `development` and `sunbeam` rows exist (imported, no markers on disk yet); the first session launched at either root would mint a marker and re-arm the descendant capture. And sessions misfiled under the wrong project (the incident's sessions under the home project) need a documented adoption path — the commands exist (`sessions move`, `projects merge`) but are undiscoverable.

## Goal
When this ships: a session launched in an unmarked directory resolves to a project rooted exactly at that directory; no ancestor's plain marker can adopt it; `blueberry init [<path>]` mints a project whose explicit claim DOES capture unmarked descendants (VCS boundaries still win nearest-first); and init prints how to adopt existing sessions.

## Non-goals
- Changing git/lore/worktree walk semantics — a repo owns its subtree, nearest wins, unchanged.
- Changing the launcher's chdir-to-project-root — resume filtering depends on it; project root now equals launch dir for unmarked trees, so the chdir becomes invisible there.
- Changing where design docs are written — `scaffoldDesign` stays at project root; this design fixes what "project root" is.
- Any fork (pi/) changes.
- Auto-migration or deletion of existing trap markers/rows (`~/.blueberry/id`, the imported `development`/`sunbeam` rows stay inert; `init` supersedes them if the user chooses).

## Approaches considered
### Approach A: implicit never captures; explicit init claims subtrees
Plain markers resolve only the directory they mark; the walk skips plain-marked ancestors. New `blueberry init [<path>]` mints a project recorded in the registry as an explicit claim, and the walk honors plain ancestors only when their marker resolves to an explicit project.
- Pros: accident-proof by construction (implicit mint = own dir only); workspace semantics available where wanted; one rule subsumes the HOME special case; init becomes the discoverability surface for adoption.
- Cons: every unmarked launch dir mints its own project (registry growth); the walk needs a registry-aware predicate, so markers.ts grows a seam.
- Verdict: chosen — because capture must be intentional, and this is the only approach where that's structural rather than behavioral.

### Approach B: keep subtree capture, document it
- Pros: zero code change; workspace roots "just work" after one session.
- Cons: the incident IS this behavior; accidental mint = silent hijack with chdir; documentation does not defend against a marker written by a session you forgot about.
- Verdict: rejected — because the failure mode is silent relocation, which no doc fixes.

### Approach C: registry relationships only (nest), capture never
Drop ancestor capture entirely; group workspace sessions with `projects nest`.
- Pros: simplest walk; no new command semantics.
- Cons: nest governs session ownership, not boundary identity — an unmarked subdir still needs a project, and the workspace root has no way to claim it; every scratch dir becomes a standalone project with no escape hatch.
- Verdict: rejected — because it removes the workspace use case instead of making it explicit (but nest remains complementary for session grouping).

## Decision
Approach A. `boundaryAt()` keeps detecting plain markers (a session launched AT a marked dir still resolves it — preserves the home project and any existing plain root), but `findProjectBoundary()` treats plain ancestors as non-boundaries by default and accepts an optional predicate `capturesSubtree(boundary)` supplied by registry-aware callers (resolution.ts): a plain ancestor captures only when its marker id resolves to a project whose registry record marks the claim explicit. The HOME exception from the emergency fix is subsumed and removed as a special case. `blueberry init [<path>]` (default cwd) mints id + marker + registry row with the explicit flag, is idempotent (re-run reports the existing project, exits 0), refuses to mint inside a VCS boundary of a different root (git/lore/worktree already claim that tree — it tells you which project owns it instead), and prints the adoption commands.

## Risks & open questions
- Project proliferation: every unmarked launch dir mints a project. Mitigated: `projects merge`/`forget` exist; `init` gives the explicit-claim path for trees that want one identity. Accept the growth.
- Predicate seam couples markers.ts to registry semantics. Contained: default behavior (no predicate) is the safe non-capturing rule; only resolution.ts passes the predicate.
- Marker files cannot distinguish explicit from implicit claims on disk alone (same `.blueberry/id`); the distinction lives in the registry. A wiped registry loses explicitness — init re-run restores it. Acceptable; noted here.
- Open: should `init --capture/--no-capture` exist to mint a non-capturing explicit project? Not now — YAGNI until a case appears.

## Requirements
R1. The boundary walk MUST NOT resolve a session's project to a plain-marked ancestor when the session was launched in a different directory; a plain marker resolves only the directory it marks, unless the ancestor's marker resolves to a project with an explicit capture claim.
R2. `blueberry init [<path>]` MUST mint a project at the given path (default: current directory) — writing the marker, registering the row with an explicit claim, and reporting the slug and root — and MUST be idempotent: re-running against an already-registered root reports the existing project and exits 0 without duplicating rows or rewriting the marker.
R3. A project minted by `blueberry init` MUST capture unmarked descendant directories — a session launched in an unmarked subdir resolves to the init'd project — while git, lore, and worktree boundaries MUST still win by nearest-boundary-wins inside the claimed subtree.
R4. `blueberry init` MUST print, on every successful mint, the commands for adopting existing sessions: `blueberry sessions move <sel> <slug>` for per-session moves and `blueberry projects merge <from> --into <to>` for folding a whole project in.
R5. The HOME special-case exception added to `boundaryAt()` in the emergency fix SHOULD be removed in favor of R1's general rule, preserving identical observable behavior for HOME (walk-through never adopts; launch-at-home still resolves the home project).
R6. The launcher MUST NOT change its canonicalize-and-chdir behavior; sessions continue to run at the resolved project root so resume filtering keeps working. [34c2b4]

## Verification
When this ships:
- `deno test -A test/markers.test.ts`: walk from an unmarked subdir of a plain-marked ancestor returns null (mints at cwd via resolution); walk starting AT the marked dir resolves it; with a capturing predicate the ancestor resolves from the subdir; HOME tests from the emergency fix still pass unchanged (R1, R5).
- `deno test -A test/resolution.test.ts`: resolution with an explicit-capture ancestor adopts it for unmarked descendants; without the flag it mints at cwd (R1, R3).
- CLI test: `blueberry init` in a fresh dir mints, reports slug+root, prints the two adoption commands (R4); re-run is a no-op reporting the same slug (R2); `blueberry init` inside a git repo with a different root refuses and names the owning project (R2).
- Full harness instantiation: empty dir under a plain-marked (non-capturing) parent instantiates at the launch dir; after `blueberry init <parent>`, a session in the same subdir resolves and chdirs to the parent root (R3, R6) — verified live with `bin/blueberry -p --no-session 'run pwd'` from both states.
