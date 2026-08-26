# Blueberry Harness Feedback

- Date: 2026-08-26
- From: the agent (kimi-coding, via blueberry), after a full reorientation + tool-testing session
- Test environment: `~/Development/aspen/engine` (Rust workspace, two crates, Lore VCS, Bevy 0.19 + Vulkano)
- Historical corpus: two prior `engine` sessions — `01a02dc2` (86 msgs, skill authoring + sire design scoping) and `01a02de4` (844 msgs, 2 compactions, sire implementation + task graph design + council review)
- What this document is: everything I observed about the harness from the agent's side, with specific asks. Nothing is too small to be listed. Ranked where ranking matters.

---

## 0. Executive summary

The harness made a genuinely hard task — reorienting into an 844-message session I had never seen — tractable. The four changes that would move the needle most, in order:

1. Fix `bb_lsp` rename preview (returns `0 files` for symbols with live references — actively misleading at the exact moment correctness matters most).
2. Session summaries at the index level + a conclusions view (ends transcript paging entirely).
3. Hyphen tokenization + softened AND semantics in `bb_search` sessions (long natural-language queries silently fail today).
4. A managed test-runner tool (`bb_test`) that encodes per-project test profiles, runs backgrounded with timeout, and reaps its own children.

And the meta-ask: restructure the system prompt around a task-first routing table instead of tool-by-tool endorsements. Details in section 4.

---

## 1. Reorientation (`bb_library`) — what it's like to come back blind

### What worked well

- Session search with message neighborhoods is the killer feature. Two queries ("aspen") surfaced the two pivotal decision messages (#421 "we need a task graph... N-frame-ahead... ring buffer thing" — the entire current direction of the project lives in that message). User intent concentrates into a handful of messages and neighborhoods land directly on them. The `▶` hit marker is exactly right; keep it.
- Session metadata at index level (message counts, sizes, modified dates, compaction counts) gave me scale/recency sense before any drill-down. Cheap and useful.
- The messages view showing inline write/edit one-liners let me reconstruct the artifact map (which design docs were written where, which files were touched) without reading any file contents. That's a real capability.
- Cross-project search surfaced context from unrelated projects when relevant terms matched. Good recall.

### Gaps, ranked by cost to me

1. No session summaries. Both sessions display as `(unnamed)` with their first-message snippet. The first message of session `01a02de4` is "Plan mode is now disabled. Full tool access is restored." — zero reorientation value. I had to page ~90 messages at three offsets to rebuild the narrative. Ask: LLM-generated title + summary at index level. Even a mediocre summary would have saved most of the paging.
2. No conclusions view. Message #844 of that session is a complete recap with a dangling question ("Do you want me to start implementing, or would you like to inspect the recovered design doc first?"). That is the reorientation payload, and it sits at the end of every session. Ask: a `conclusions` view = last 2–3 assistant text messages. This would have been one call instead of three offset-paged reads.
3. Assistant messages that contain tool calls render as opaque tool one-liners. Most of a long transcript is invisible to me by construction. Ask: a conversation-only view (user + assistant text, tool noise collapsed). This is the fastest manual path when search doesn't quite hit.
4. The todo DAG is empty. The prior session created ~10 tasks (I saw the `todo` tool calls in the transcript), moved them through stages, and today `bb_todo list` returns nothing. The breadcrumbs are searchable (`todo:engine/<hex6>`) but the DAG surfaces no history. The todo chain "sire v0 ✓ → task graph design ✓ → task graph implementation (never started)" would have reoriented me instantly. Ask: keep done/dropped tasks visible in `list` (collapsed by default), or add a `history` view. Also see the handoff-notes ask in section 5.
5. Decisions and preferences live only in transcripts. "No-name branding" (`SireRenderer` → `Renderer`), "5-slot readback ring," "least expensive option," "remote rendering is a possibility only" — I re-derived each of these because I happened to read those exact messages. Without a decisions ledger, a future session can drift (e.g., re-suggest `SireRenderer`).
6. Tree view is low signal for big sessions — deep single-child nesting of `read → ok`. I abandoned it for offset-paged messages.
7. Compaction summaries: session `01a02de4` has 2 compactions. Those summaries were written precisely to preserve context, but I found no way to surface them. Ask: expose them in `show` (a `compactions` view or inline markers).

### What the project itself got right (keep encouraging this)

The AGENTS.md + external design vault carried all structural context, so sessions only had to carry narrative. That split is healthy. The session-start recipe in section 4 should lean on AGENTS.md first, transcripts second.

---

## 2. `bb_lsp` — full test results

Tested against rust-analyzer (lazy-started) on a two-crate Rust workspace (root `aspen` + `sire`).

### Feature status matrix

| Action | Status | Notes |
|---|---|---|
| status | works | shows lazy servers per-language |
| hover | works, best-in-class | type signature + memory layout (`size = 8, align = 0x8, offset = 0x0`) + rendered doc comments |
| references | works, accurate | 8 hits for `Renderer` across lib.rs, integration tests, renderer.rs incl. definition site |
| definition | works | cross-file jumps fine (tests → src) |
| typeDefinition | (not explicitly tested; same plumbing as definition) | |
| implementation | works, aim-sensitive | `trait RenderTarget` → impl at `render_target.rs:142` when aimed exactly |
| diagnostics (file) | works | |
| diagnostics (project) | works, excellent | found 4 real warnings in `generation.rs` in one call |
| completion | works | full candidate list with aliases (`Vec(alias list, vector)`) |
| codeAction | works | real assists ("Generate impl", "Convert to tuple struct", "Generate new") |
| codeActionExecute | (not tested — did not want to mutate) | |
| foldingRange | works, 0-based output | see trap #5 |
| documentHighlight | works, 0-based output | |
| rename | BROKEN — release-blocking | preview returns `0 files` for live symbols; see bug #1 |
| documentSymbol | BUGGY | wrong line numbers + truncated outline; see bug #2 |
| signatureHelp | appears broken | empty inside call parens; see bug #3 |
| workspaceSymbol | works with caveats | needs `path` for language inference; see trap #4 |
| callHierarchy | works (incoming tested) | returned correct item shape |
| typeHierarchy | unsupported by rust-analyzer | `-32601: unknown request` |

### Bugs

1. rename preview returns `0 files` for symbols with live references. Repro: `sire/src/renderer.rs`, `RenderContext` at its exact definition site (grep-verified line 22; hover/references both resolve it; references found 8 sites for the sibling symbol `Renderer`). Preview: `rename preview (0 files)`. Same for `Triangle` at its definition in `sire/src/vertex.rs`. If I trusted the preview and applied, I'd massively understate blast radius. This is the one finding I'd treat as release-blocking. (Tested preview only — I did not dare `apply: true`, so it's possible preview is broken while apply is fine; either way the preview lies.)
2. documentSymbol reports wrong line numbers and a truncated outline. Repro: `sire/src/renderer.rs`. Reported: `impl Renderer` @ 19, `Renderer` @ 23, `RenderContext` @ 23, and no methods at all. Truth (grep): `RenderContext` @ 22, `Renderer` @ 27, `impl Renderer` @ 35, plus `new_headless` @ 38, `render_frame` @ 65, `read_pixels` @ 112 — all missing from the outline. Navigation actions (hover/references/definition) use true 1-based lines, so the outline and the navigation actively disagree with each other.
3. signatureHelp returned empty with the cursor inside call parentheses at multiple columns (tested `Renderer.rs:45` at chars 60 and 80, inside a `HeadlessReadbackTarget::new(` argument list). Possibly a rust-analyzer interaction; worth verifying before advertising the action.
4. Silent cold start. First-ever documentSymbol returned `(none)` — indistinguishable from "no symbols" while rust-analyzer booted. Second identical call ~seconds later returned symbols. Early-session false negatives train the agent to avoid the tool permanently. Ask: one automatic retry with backoff, or a "server warming up" result marker.
5. `(none)` is ambiguous. A one-character aim miss returns the same `(none)` as a genuine empty result. I hit this twice in testing (implementation aimed at a doc comment; definition on a bevy symbol). Ask: when the position has no identifier under it, say "no symbol at position" instead of a bare none.
6. Line-base mismatch. Input params are 1-based; foldingRange and documentHighlight return raw 0-based protocol lines. Off-by-one minefield unless you already know. Ask: normalize everything to 1-based at the tool boundary.
7. workspaceSymbol errors without a `path` ("no lsp language for <project root>"). Passing any file works. Ask: the error message should say "pass a path for language inference," or infer from project-dominant language.
8. External-crate resolution came up empty on first try (`WireframePlugin` in root crate → definition none, hover empty) while crate-local symbols resolved; likely bevy still background-indexing. Related ask: an "indexing complete" / "workspace ready" signal, or auto-retry (same fix as #4).
9. typeHierarchy is dead weight for rust-analyzer (`-32601`). Ask: per-server capability table — hide or annotate unsupported actions so I don't rediscover this every project.
10. Root crate (`aspen`) resolved hover fine after warm-up; bevy symbols stayed empty. Unclear if that's warm-up or a cargo-workspace boundary issue. Worth a targeted test: cross-crate jump into a dependency's source on a cold server vs. warm.

### What I actually used, ranked by value

references + hover + project diagnostics covered ~80% of my needs. That trio being rock solid matters more than breadth. Then: definition, implementation, completion, codeAction. Everything else was exploration.

---

## 3. `bb_search` — test results

### code search

- Accurate with real context. `read_pixels` → 7 hits spanning the public method, trait method, impl, renderer call site, and integration tests, each with a useful line snippet. `HeadlessReadbackTarget` → 7 hits including `sire/README.md` prose.
- Markdown in the index is a feature, not an accident: `todo.md` and `sire/README.md` hits meant one query covered docs + code. Keep this.
- Bootstrap gap: the first-ever `code` query returned "no matches" until I ran a manual `index` (then: "indexed 12483 lines"). A brand-new project starts with an empty index and nothing distinguishes "index empty" from "term absent." Ask: auto-index on first code query, or return "index empty for this project — run index" instead of "no matches."
- Boolean-ish queries aren't parsed: `FrameRing OR TaskGraphBuilder OR Scheduler` → no matches. (Those symbols only exist in the design doc, not code, so the empty result was *correct* — but I can't tell parsed-OR-failed from genuinely-absent. Either parse OR or say "query contains unrecognized operator.")

### sessions search

- Neighborhoods: excellent. Roles + timestamps + `▶` marker. This format reoriented me better than any snippet search I've used.
- Global scope by default: hits arrived from unrelated projects (gitserv, sonnets, a Scaleway-cleanup agent, plus this current session). Cross-project memory is a feature, but reorientation wants project priority. The current behavior partially groups by project; ask: hard-group by project with current project first, or add a `scope` parameter.
- Live self-indexing: my own tool results quoting search text became hits within one turn. Neat, but it pollutes reorientation queries with self-echo. Ask: suppress or down-rank hits from the *current live session* when the query text itself came from that session's results, or add an "exclude current session" flag.

Recall failures (these matter most):

1. Hyphenated terms match nothing. Repro: query `N-frame-ahead` → zero hits, while the literal string exists in session `01a02de4` message #421 ("plan for N-frame-ahead"). `ring buffer` (no hyphen) hits the same message fine. Domain language is full of hyphens (`N-frame-ahead`, `5-slot`, `single-buffered`, `task-graph`); this is a real blind spot. Suspect the tokenizer discards hyphen-delimited tokens or fails to split them. Ask: split on hyphens into constituent tokens AND keep the joined form; search both.
2. More terms = fewer results (strict AND over the corpus). Repro: `ring buffer` hits; `engine ring buffer streaming` → no matches. Long natural-language queries — the kind users actually type — silently fail. Ask: fallback strategy when strict AND returns nothing: drop the lowest-IDF term and retry, or rank by match count (soft AND / OR ordering). At minimum, say "no docs matched all terms; 3 docs matched subsets" and offer them.
3. (Related to #1/#2) No fuzzy or stemmed matching observed: `task-graph` vs `task graph`, plurals, etc. FTS5 offers trigram/prefix options; worth exposing.

---

## 4. System prompt feedback

### The core problem: it's organized tool-by-tool, but I route task-first

The current prompt lists tools and their uses; I choose tools by the *task* in front of me. Worse, two lines actively endorse the legacy path:

- "Use bash for file operations like `ls`, `rg`, `find`" — this sends me to `rg` before `bb_search code` ever crosses my mind.
- There is no "prefer bb_search code over rg" anywhere, so the cheaper, more capable indexed path loses to the endorsed one.

Steering isn't listing tools — it's the choosing rule. Proposal: a compact routing table in the prompt (each row is cheaper/faster than its fallback, which is the actual reason I'll follow it):

```
Finding where a symbol lives or is used  → bb_lsp references/definition; bb_search code; rg only as fallback
Finding text in repo or docs             → bb_search code (indexes .md too); grep only outside index roots
Past decisions / "what did we do about"  → bb_search sessions, then bb_library drill-down
Unfamiliar repo or returning project     → AGENTS.md → bb_todo list → bb_library sessions (summary) → bb_search code on key symbols
Multi-step work starting                 → bb_todo create before editing
After every edit                         → bb_lsp diagnostics
```

### Specific additions

1. Empty-result protocol. Given the ambiguous `(none)`s I hit today: "If a harness tool returns empty, retry once (LSP/index cold-start), then fall back to bash and note it." Without this, early-session failures permanently train the agent away from the tool.
2. Project-override rule. `bb_design` writes to `docs/design/` by default; this project's AGENTS.md mandates design docs live in an Obsidian vault, and it carries its own design skill. One line prevents a real future mistake: "When a harness tool's default artifact location or workflow conflicts with project instructions, the project wins."
3. Session-end hygiene ritual. "Before ending a session: make the todo DAG reflect reality; record open questions and the single next step." This is where handoff notes come from (see section 5). Cheap, high value — it's the difference between the next session paging 844 messages and reading one card.
4. Session-start recipe, conditional. A short ordered list (AGENTS.md → bb_todo → session summaries) is fine, but keep it conditional on the task actually being non-trivial. Unconditional rituals ("always call 5 tools") burn the tokens the harness is supposed to save.
5. LSP trust tier. I know hover/references/definition/diagnostics are reliable and rename/foldingRange are not *because I tested them today*. The next session knows nothing. Either fix the bugs (preferred) or encode the tier in the prompt until then.
6. Tool descriptions are prompt surface. Half the steering budget lives in tool schemas, not the prompt. `bb_library`'s description says what it does; the best descriptions say when I'd want it ("user references past work" / "user says 'what were we doing'"). Keep descriptions trigger-first and the prompt stays short.

---

## 5. Tool wishlist (new tools)

### 5.1 `bb_test` — managed test runner (highest value for Aspen specifically)

This repo's testing rules are elaborate, and session history records a real incident: five stray root-crate test binaries pinned CPU for ~43 minutes because a workspace-wide test command was left dangling. Current AGENTS.md encodes three nextest profiles (default skips GPU-dependent proptest/wgpu tests; `sire` for the Vulkan renderer; `heavy` for full GPU math), "run long tests in background with timeout," and "never run a compilation more than once."

A `bb_test` tool that encodes all of this would convert my most dangerous bash usage into a safe one-liner:

- Actions: `run` (suite/profile/test-filter), `status`, `stop`, `results` (structured pass/fail/skip + last output).
- Reads `.config/nextest.toml` (or a `bb_test.toml`) for named profiles so per-project rules travel with the repo.
- Runs managed-background with a default timeout; reports duration; **always reaps its own children** (the 43-minute incident).
- Serializes builds/tests behind a project lock so two agents don't double-compile or race.
- Structured failure output (test name → assertion → stderr) instead of me parsing cargo/nextest stdout.
- Skips nothing silently: a profile that filters tests should report "N skipped by profile" so I don't mistake a green run for coverage.

### 5.2 Handoff notes + decisions ledger

The single highest-value artifact from section 1. Two options, either works:

- Extend bb_todo: a `handoff` task type (or convention) holding "where we left off / open questions / next step," plus done/dropped tasks remaining queryable in `list`.
- Or a tiny append-only decisions ledger per project: date, decision, one-line rationale. ("2026-08-24: renamed `SireRenderer` → `Renderer` — no-name branding." / "2026-08-24: 5-slot readback ring — no renderer-side blocking." / "vulkano-taskgraph rejected — experimental; writing custom scheduler.")

Both should be searchable via bb_search so a reorientation query hits them.

### 5.3 Multi-root code index

`bb_search code` indexes the repo root — but in this project the design truth lives outside it (`../notes/Aspen/Core/Technical Design/`, an Obsidian vault). Today the vault is searchable only via bash. Ask: configurable extra index roots per project (AGENTS.md directive or bb config), folding design docs + code + README into the one search surface. For Aspen this is uniquely important: the task graph exists *only* as a design doc today, and a code-only search for `TaskGraphBuilder` returns nothing, which reads as "doesn't exist" when it actually means "not implemented yet."

### 5.4 Session summaries + conclusions view

(Repeat from section 1 because it belongs on the tool list too.)

- `bb_library sessions` index: generated title + 2–3 sentence summary per session.
- `show` view `conclusions`: last 2–3 assistant text messages.
- Bonus: view `conversation` (user + assistant text only) for fast manual skims.

### 5.5 Smaller asks (nothing too unimportant)

- bb_todo: surface task history (done/dropped) in `list`, collapsed; expose creation/completion timestamps.
- bb_library: auto-title sessions from the first real user-intent message (skip system prompts, plan-mode banners, "please continue").
- bb_library: expose compaction summaries in `show`.
- bb_search sessions: `scope: project|global` parameter; suppress/down-rank current-session self-echo.
- bb_search code: auto-index on first query or an explicit "index empty" result; parse or reject `OR`.
- bb_lsp: per-server capability filtering; "warming up" result marker; one auto-retry on cold start; normalized 1-based lines; "no symbol at position" vs "no results."
- Rename preview + documentSymbol fixes (bugs #1/#2 in section 2) — listed again here so the tool list is complete.
- Consider a `bb_diagnostics`-style one-shot "project health" call: diagnostics + test status + todo state + uncommitted VCS state in one result. That's my true session-start desire: one call that says "here's where things stand."

---

## 6. General principles (what actually made me more effective)

- Fewer false negatives beat more surface. Every ambiguous empty result costs a verification detour; I can distinguish "tool broken / aim missed / still warming / genuinely nothing" only by testing, and most sessions won't test.
- The cheapest path must also be the default path. bb_search code is better than rg for me, but the prompt endorses rg, so rg wins. Fix the endorsement, not just the tool.
- Intent concentrates in user messages; conclusions concentrate at session ends. Both ends of the transcript are worth special treatment (neighborhoods already exploit the first; conclusions views would exploit the second).
- Structural context belongs in the repo (AGENTS.md, docs); narrative context belongs in sessions. Keep encouraging the split — it's working.
- History is context. An empty todo DAG and vanishing done-tasks erase the cheapest reorientation surface the harness has.

## Areas not tested this session (for completeness)

subagent/workflowScript delegation, bb_design/bb_plan lifecycle, bb_todo mutations (only `list` observed, empty), mcpScript/mcp, web tools (pi-native), skills, Lore integration. No feedback offered on those; not evidence they're fine, just untested.
