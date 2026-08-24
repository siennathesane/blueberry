# 🧭 pi-plan-mode — Plan Before Pi Edits Code

[![npm](https://img.shields.io/npm/v/@narumitw/pi-plan-mode)](https://www.npmjs.com/package/@narumitw/pi-plan-mode) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Explore a codebase, resolve important questions, and produce an implementation-ready plan before Pi is allowed to edit files.

This independently installable extension adds a Codex-like `/plan` collaboration mode that Pi core does not provide.

## ✨ Features

- Starts and manages Plan mode through `/plan`, `/plan <prompt>`, or the `--plan` startup flag.
- Enables read-only exploration tools while blocking mutating tools and unsafe shell forms by default.
- Requires structured questions for important ambiguity and explicit completion for a decision-ready plan.
- Reviews the complete plan before implementation, export, save, continued planning, or discard.
- Starts implementation in the planning session or a fresh linked session with the exact approved plan.
- Persists Plan state and one saved plan across resume and compaction.
- Exposes statusline state and configurable tool visibility, export destination, handoff behavior, shortcut, and thinking level.
- Cooperates anonymously with Workflow Mutex Protocol v1 participants so only one agent workflow starts in a session.

## 📦 Install

This release requires Pi 0.80.6 or newer.

```bash
pi install npm:@narumitw/pi-plan-mode
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-plan-mode
```

Build and try this package locally from the repository root:

```bash
npm --workspace @narumitw/pi-plan-mode run build
pi -e ./packages/pi-plan-mode
```

The package declares `dist/index.ts`, so an unbuilt local checkout must run the build before Pi loads the package directory.

## 🚀 Quick start

Run `/plan` to open the state-aware menu, then start Plan mode and ask the agent to inspect and design the change.
Run `/plan <prompt>` when the first planning request is already known.

## 💬 Commands

```text
/plan
/plan start
/plan <prompt>
/plan tools
/plan show
/plan finalize
/plan implement
/plan save
/plan export [path]
/plan exit
```

In TUI and RPC, use bare `/plan` to open the menu for the current Plan state.
When Plan mode is off and no plan is stored, the launch menu shows the effective next-start tools and offers **Start Plan mode**, **Choose tools, then start…**, **Settings**, and **How Plan mode works**.
Settings edits the persistent defaults for later workflows.
Launch-menu tool changes remain a draft until **Done — start Plan mode** is selected; Back, Escape, Ctrl+C, disposal, session replacement, and shutdown discard the draft without changing Plan state, active tools, thinking, or the stored selection.

Use `/plan start` when you want to enter Plan mode directly without sending a model message.
Use `/plan <prompt>` to enter Plan mode and immediately submit `<prompt>` as the first Plan-mode user message.
The exact argument `start` is reserved for direct activation; longer text such as `/plan start a migration` remains an inline planning prompt.
`--plan` also remains a direct activation path.

Use **Choose tools, then start…** or the `/plan tools` compatibility shortcut to choose a session-specific override before Planning starts.
Both routes use the same draft selector: **Done — start Plan mode** stores the selection and starts the workflow, while cancellation leaves Plan mode off and changes nothing.
The bounded multi-select shows 10 rows at a time, supports viewport paging, descriptions, and explicit unavailable rows for blocked tools.
In TUI mode, type to fuzzy-search tool names, descriptions, policy, and source metadata; RPC keeps the complete unfiltered list.
Once Plan mode is active, tools are locked: `/plan` no longer offers tool or Settings actions, and `/plan tools` rejects the request.
Exit and start a new workflow if a different tool set is required.
The `plan_mode_question` tool keeps a dedicated model-requested questionnaire instead of using command-menu navigation.
`/plan show` displays the stored plan without starting a model turn, including the accepted plan while implementation is active.
`/plan finalize` explicitly asks the agent to complete the plan or ask one remaining material question, `/plan save` stores a completed ready plan for later and leaves Plan mode, and `/plan export [path]` writes a ready, saved, or active implementation plan to Markdown.
Completed and saved plan menus offer **Implement here**, which continues with the planning conversation, and **Start fresh and implement**, which opens a new session and transfers only the approved plan.
The direct `/plan implement` compatibility route remains equivalent to **Implement here** and never opens a selector.
A successful ready-plan export also leaves Plan mode; saved and active implementation exports retain their existing state.
`show`, `save`, `export`, and `implement` fail closed when no applicable plan is stored; `finalize` requires active Plan mode.

`/plan export` uses the configured **Export destination**, which defaults to `PLAN.md`.
Supply a path to override that default for one export.
Relative paths resolve from the command's current `ctx.cwd` at export time, absolute paths remain absolute, a leading `@` is accepted for Pi path compatibility, and missing parent directories are created.
Explicit `/plan export <path>` input always wins over the setting.
Export never overwrites an existing file, directory, or symbolic link: choose another path or remove the existing target first.
A successful export adds one trailing newline but otherwise preserves the accepted Markdown exactly.
After a ready plan is written, Plan mode ends, its tools and thinking level are restored, and the ready state is cleared without starting a model turn.
Exporting a saved or active implementation plan leaves that state unchanged.
Failed or cancelled exports leave every Plan-mode state unchanged.
The resulting file is available to the agent through its normal file-reading tools.
Export is an explicit user-requested file mutation.
Model-initiated Plan-mode writes remain blocked.

In TUI and RPC, **Export plan…** opens a single-line path input from every ready, saved, or active plan menu.
The input shows both the configured value and its currently resolved path.
Submit an empty value to use the configured destination, or enter a relative or absolute one-off path.
A failed TUI export retains the draft for correction; RPC reopens its input dialog.
Escape returns to the owning menu without writing a file.
A successful ready-plan export closes the menu and ends Plan mode; saved and active implementation menus close without changing their stored state.

When Plan mode is active, ask the agent to design the change.
The agent may inspect files and run read-only commands, but it should not edit files or execute the implementation.
It should explore first, then use structured questions when your preference or a tradeoff materially changes the plan.
Configure persistent defaults or a one-workflow tool override before activation; Planning and ready menus deliberately keep those controls locked.

By default, Plan mode manages only Pi's built-in tools: `read`, limited `bash`, available read-only built-ins such as `grep`, `find`, and `ls`, plus the required `plan_mode_question` and `plan_mode_complete` tools.
Built-in `edit` and `write` are blocked.
`update_plan` is also blocked because it tracks execution progress rather than conversational planning.
Extension and custom tools are disabled by default because Pi tools do not expose standardized mutability metadata; enable them before starting from Settings or the staged workflow selector only when you accept the risk.
For example, you can opt into `firecrawl_scrape`, `firecrawl_search`, or `lsp_diagnostics` if those extensions are loaded and you want to use them during planning.

Limited `bash` uses a fail-closed policy, including when an extension overrides the canonical `bash` tool name.
It accepts common inspection commands, read-only Git and npm queries, pipelines and command lists composed entirely of accepted commands, plus selected checks such as `npm test`, `npm run typecheck`, and `cargo test`.
It rejects output/input redirects, shell expansion, substitutions, subshells, background jobs, mutating flags, dependency changes, editors, and unknown commands.
A rejected parsed command list or pipeline identifies its first blocked command segment; malformed or unsupported shell syntax reports the complete submitted input instead.
Tests and builds may still write ignored caches or build artifacts and may execute project-defined hooks; enable or invoke them only when the repository is trusted.
This is extension-level risk reduction, not an OS sandbox.

`plan_mode_question` follows Codex's `request_user_input` pattern: the agent can ask 1-3 concise questions, each with meaningful options and a free-form Other path.
In TUI mode, a single question shows its header as plain muted text, submits as soon as its preset or custom answer is confirmed, and does not show tabs, Review, or question-navigation controls.
Add an optional note with `n` before confirming a single preset answer.
With two or three questions, one question appears at a time with question tabs and a final Review tab.
Use Tab, Shift+Tab, left, or right to visit any question or Review, including unanswered future questions.
Use up and down to choose an option, Enter to record it and advance, or `n` to record the highlighted option and open its optional note editor.
Press `n` again on an answered item to edit or clear its note.
Revisit a question to replace its answer; changing the chosen option clears its prior note.
Review lists every answer and note, blocks incomplete submission, and requires returning to a question to edit its answer or note.
Custom answers and notes retain their raw submitted text in the tool result, while terminal rendering is sanitized.
The TUI rejects either field above 4,000 characters instead of truncating it.
RPC keeps the existing sequential `select` and `editor` dialogs because Pi RPC cannot render custom TUI components.
If you cancel or no interactive UI is available, the agent should ask a concise plain-text question or proceed only with a clearly stated low-risk assumption instead of prematurely producing a final plan.

Pi activates tools by tool name.
The pre-start selector stores accepted session selections by name and shows each effective tool's source from Pi metadata, such as `built-in`, a user extension path, or a project extension path.
If an extension overrides a built-in tool with the same name, Pi exposes the effective tool for that name and the selector shows that source.

A complete Plan mode answer should appear only after the agent has resolved discoverable facts and high-impact user decisions.
The agent must call `plan_mode_complete({ plan })` alone as its final action, passing the complete Markdown plan.
The tool rejects empty or whitespace-only plans and plans longer than 50,000 JavaScript characters; it does not truncate.
Its visible result contains the full plan, and versioned result details let the extension restore it safely from the active session branch.

`plan_mode_complete` uses Pi's `terminate: true` hint.
Termination is best effort: if a model puts it in a parallel tool batch, Pi terminates the batch early only when every finalized sibling tool also terminates.
The prompt therefore requires the completion call to be standalone and last.
The extension deliberately does not infer completion from phrases such as “I will present the plan,” and it does not automatically retry a turn with no plan because research and clarification turns may legitimately remain unfinished.
If a turn ends without a plan, Plan mode stays active; use `/plan finalize` for explicit recovery.

Legacy sessions and models may still submit one non-empty `<proposed_plan>` block with tags on their own lines.
That compatibility path remains accepted, but it is not the primary workflow.
Empty, malformed, unclosed, or multiple legacy blocks keep Plan mode active and produce a warning.

After completion, `/plan` opens the ready actions when interactive UI is available.
The same flat menu shows **Implement here** and **Start fresh and implement**, explains which conversation context each choice uses, and previews how long the approved plan will remain active.
**Implement here**—and the compatibility route `/plan implement`—disables Plan mode, restores full tool access, captures the current **After Implement** policy, and starts implementation in the current session with its planning conversation.
**Start fresh and implement** waits for the source session to become idle, verifies the selected model and authentication, creates a new session linked to the persisted source as its parent, and transfers the exact approved plan without copying planning messages, tool results, or compaction/branch summaries.
The destination still loads its normal `AGENTS.md`, skills, project resources, and extensions.
Choosing **Export plan…** asks for a destination, writes the plan, restores normal tools and thinking, and leaves Plan mode without starting a model turn.
Choosing **Save for later**—or running `/plan save`—instead stores one plan in the current Pi session before leaving Plan mode.

When a workflow was started only with `--plan` and no `/plan` command has run in that session, the automatic menu cannot obtain Pi's command-only session replacement capability; choosing fresh asks you to reopen `/plan`, where the same action is available.
A successful fresh handoff does not delete or consume the source planning session.
Resume it later to inspect or hand off the ready/saved plan again; this deliberate duplication is the recovery path if the destination work is abandoned.
In-memory sessions create an unlinked fresh session because no parent file exists.
Escape, Ctrl+C, menu disposal, source replacement/shutdown, model/auth failure, or cancellation by another extension before replacement leaves the source plan unchanged.
Once replacement succeeds, the destination persists active-plan state before kickoff.
If persistence fails, the complete request is placed in the destination editor and the source remains resumable.
If kickoff fails, the destination retains the active plan; send a message to continue, use `/plan exit` to clear it, or resume the parent planning session.

A saved plan appears as `plan saved` and remains available after reload, resume, branch-local fork, and compaction in that session.
It does not expire automatically, cross into a new session, or participate in ordinary model context.
Open `/plan` to Show, Implement here, Start fresh and implement, Export, open Settings, or Clear it; `/plan show`, `/plan implement`, `/plan export [path]`, and `/plan exit`/`off` retain their direct routes in TUI and RPC.
Fresh implementation checks idle state, the selected model, and authentication before session replacement; Implement here keeps its established preflight behavior.
Starting another workflow with `/plan start`, `/plan <prompt>`, or `/plan tools` is blocked until the saved plan is implemented or cleared, so the single saved slot is never silently overwritten.
Resuming that session with `--plan` moves the saved plan back to ready Plan mode.
Cancellation or failed implementation preflight leaves it unchanged.

Text print and JSON modes cannot display the bare `/plan` menu and reject that route before changing state; use `/plan start` for direct no-prompt activation or `/plan <prompt>` to start planning with a prompt.
`/plan tools` also rejects before changing state because its staged selector requires TUI or RPC.
These modes can export any stored plan with `/plan export [path]`, save a ready plan with `/plan save`, and clear it with `/plan exit` or `/plan off`.
Successful export is observable through the created file; exporting a ready plan also leaves Plan mode, while saved and active implementation state remains unchanged.
An existing target or missing plan fails the command without changing state.
These modes reject saved-plan display and implementation before changing state because Pi provides neither printable custom-message output nor acknowledged extension-triggered turns; resume the session in TUI or RPC to show or implement it.

Both implementation paths apply the current **After Implement** policy in their destination; the fresh-session choice does not change retention semantics.
With the default **Keep plan active** policy, the exact accepted plan remains active across later turns, session resume, and manual or automatic compaction without depending on the compaction summary.
Plan mode avoids a duplicate context block while the original implementation handoff remains available and injects one hidden canonical copy after that handoff is compacted away.
This can consume up to the existing 50,000-character plan limit in model context when reinjection is needed.
**Use plan for handoff only** clears retained state immediately after the first implementation request receives the complete plan.
**Clear after first implementation run** keeps the plan through that run, including retries, compaction retries, and queued continuation, then clears it at `agent_settled`.
Cleanup is bound to the matching implementation, so an older run settling cannot clear a newer handoff.

While implementation is active, `/plan show` displays the accepted plan.
Interactive `/plan` offers Show, Export plan…, Settings, Start a new plan, and Clear; `/plan exit` and `/plan off` are the direct clear routes.
Settings changes never alter the policy already captured by the active implementation.
Automatic cleanup has the same observable result as clearing: its active status and future injected plan context disappear, while the implementation request that triggered cleanup still receives the complete plan.
Starting a new Plan-mode workflow or implementing a replacement plan supersedes the previous active plan.
The extension deliberately does not infer completion from assistant prose or agent settlement, so clear the active plan when the implementation no longer applies.
Choosing Stay before implementation keeps the plan ready.
Revision feedback starts another Plan-mode turn and clears the previous implementable plan until an updated completion arrives.
For clarification-only follow-ups, the agent answers and resubmits the complete unchanged plan so it remains implementable.
Before saving or implementation, exit/off discards the ready plan and removes its completion result from later non-Plan model context.

While Plan mode is enabled, the extension also publishes a compact status for Pi statuslines.
With `@narumitw/pi-statusline`, this appears in the extension status area:

- `plan active`: Plan mode is enabled and still gathering context or drafting a plan.
- `plan ready`: A completed plan is stored until you implement it, export it, save it, continue planning, or exit Plan mode.
- `plan saved`: One completed plan is stored outside model context in the current session until you implement or clear it.
- `plan implementing`: The exact accepted plan is currently retained under its captured **After Implement** policy.

You can also exit directly.
Before implementation, direct exit discards the latest proposed plan; while a plan is saved, it clears that saved plan.
During implementation, it removes both the original implementation handoff and the extension's canonical active-plan block from later model calls; an earlier Pi-generated compaction summary may still describe prior work:

```text
/plan exit
```

## 🤝 Workflow coexistence

Plan mode is independently installable and keeps its standalone behavior when no other protocol participant is present.
On the characterized Pi `0.84.2` runtime, it participates in the anonymous `workflow:mutex:v1` `agent-workflow` group.
It holds the group while Planning is active, while a completed plan awaits review, and while revision is underway.
Saved plans and ordinary implementation after Plan handoff do not hold the group.

Every inactive start performs one final synchronous admission after asynchronous preflight and before changing Plan state, persistence, prompts, tools, thinking level, queues, or status.
If another participant is active, TUI and RPC show an anonymous warning that another workflow is active.
Print and JSON direct routes throw the same anonymous error before mutation.
Launch-menu, selected-tool, shortcut, startup-flag, active-implementation **Start a new plan**, and restored activation use the same admission boundary.
A rejected selected-tool launch does not save its draft choices.

Restored active Plan state acquires before restoring restrictive tools, thinking, status, or model hooks.
If restoration is busy, Plan mode stays non-running, leaves persisted history untouched, does not alter active tools, and requires a later reload or explicit new start after the other workflow ends.
Planning-session cancellation during a fresh implementation preflight keeps the source Plan and its ownership.
Successful session replacement relies on source-session shutdown to clean up and release; the destination's ordinary active implementation does not acquire the Plan mutex.

The coexistence guarantee is cooperative and applies only when every contender implements v1 on the characterized Pi runtime and shares its event bus and session-manager identity.
A pre-v1, mixed-version, non-participating, forked, or otherwise uncharacterized counterpart remains unsupported for mutual exclusion.
Plan mode does not identify, inspect, configure, start, stop, or depend on another extension.
Guaranteed coexistence with Goal requires `@narumitw/pi-goal` `0.53.0` or newer and this package at `0.52.0` or newer on the characterized Pi `0.84.2` runtime.

| Installation | Support |
| --- | --- |
| Plan mode without another workflow participant | Supported standalone behavior |
| Plan mode `>=0.52.0` with Goal `>=0.53.0` on Pi `0.84.2` | Workflow Mutex v1 coexistence guarantee |
| Either package below its floor, or another Pi runtime | Standalone behavior only; mutual exclusion unsupported |

## 🛠️ Tools

- `plan_mode_question` asks up to three structured questions, supports optional answer notes, submits one answer directly, and reviews multiple answers before TUI submission.
- `plan_mode_complete` records the complete approved Markdown plan and terminates the planning turn when called alone.

## ⚙️ Settings

Open **Settings** from an inactive `/plan` menu to edit one flat group of five workflow choices: **Plan thinking**, **Plan tools**, **After Implement**, **Export destination**, and **Plan mode shortcut**.
You can also edit `$PI_CODING_AGENT_DIR/pi-plan-mode.json` (normally `~/.pi/agent/pi-plan-mode.json`) manually.
`safeSubcommands` remains JSON-only.
You can change the Plan-mode shortcut with `toggleShortcut` as long as the file remains JSON-only and uses a valid key string.
The file is optional, is read at session start and reloaded automatically when changed, and is created only after an explicit Settings save or manual edit.
When omitted, the shortcut is disabled by default.
```json
{
  "thinkingLevel": "inherit",
  "defaultPlanTools": ["read", "bash", "grep", "find", "ls"],
  "implementationPlanRetention": "keep",
  "defaultPlanExportPath": "PLAN.md",
  "safeSubcommands": {
    "git": ["status", "log", "rev-parse", "blame"],
    "gh": ["pr view", "pr list", "issue view", "issue list"]
  },
  "toggleShortcut": "<your_key>"
}
```

### Default Plan tools

`defaultPlanTools` defines the initial tool selection when a session has no stored pre-start selection.
Omit it—or choose **Use automatic safe built-ins**—to keep the available safe built-ins as the default.
An explicit empty array appears as **Required tools only** and enables only `plan_mode_question` and `plan_mode_complete`.

Tool names must be non-empty strings; duplicates are removed in first-seen order.
Unknown, unavailable, and Plan-mode-blocked names are ignored when tools are activated.
Settings retains configured unavailable names and shows them as unavailable; resetting to automatic removes the entire override.
A tool registered after Plan mode is already active is not added automatically; exit and start a new Plan workflow to apply another set.
Non-built-in tools named in this global setting are an explicit user-risk opt-in, just like selecting them in the pre-start workflow selector.
Plan mode does not interpret their arguments or actions: enabling one trusts the whole effective tool.
Pi resolves tools by name, so if an extension overrides a built-in name, the effective extension tool is selected instead.
An effective tool named `bash` remains subject to the limited-shell policy regardless of its source metadata.

A selection accepted through **Choose tools, then start…** or `/plan tools` is stored in that Pi session and takes precedence over `defaultPlanTools` when the session resumes.
The global setting remains the baseline for fresh sessions and sessions without an explicit selection.
Settings saves immediately, but the saved tools and thinking level apply only when a later Plan workflow starts; they never mutate a workflow already in progress.

### After Implement

`implementationPlanRetention` controls the result of the next Implement action.
Omit it or use `keep` for **Keep plan active**, the backward-compatible behavior that retains and reinjects the exact plan until `/plan exit` or supersession.
Use `clear-on-start` for **Use plan for handoff only**: the first matching implementation request receives the complete plan, then retained state clears before later requests.
Use `clear-after-first-run` to retain the plan until that implementation's first fully settled run ends.
A resumed cleanup policy re-arms against the first context in the replacement session.
Failed handoff delivery restores the ready or saved plan and does not run automatic cleanup.

Changing this setting applies to the next Implement action only.
Each active implementation stores its effective policy, so a later Settings save cannot shorten or extend an implementation already in progress.
`/plan exit` remains available under every policy.

### Export destination

`defaultPlanExportPath` controls only exports that omit a path.
Omit it—or submit an empty value in Settings—to use `PLAN.md`.
The value must be a non-empty string of at most 4,096 characters without terminal control characters or NUL.
Relative values are resolved against the current working directory at export time; the Settings detail and every export input preview the concrete resolved destination.
An explicit `/plan export <path>` is a one-off override and does not edit Settings.
Saving a new destination affects the next export immediately, including export of a currently active implementation.

The existing no-overwrite, cancellation, and atomic Plan-state behavior is unchanged.
A failed save rolls the row back to its previous value; a failed or cancelled export preserves the plan and target.
Long previews wrap or truncate to the available terminal width without changing the raw path used by the action.

### Toggle shortcut

`toggleShortcut` controls the global Plan-mode keybinding used by the TUI shortcut.
Omit this setting to keep the shortcut disabled.
Set `toggleShortcut` to the key string you want.
Avoid values that conflict with editor shortcuts.

### Safe shell subcommands

`safeSubcommands` adds reviewed command validators to limited `bash`; it is not a raw shell allowlist.
Only the following exact values are accepted:

- `git`: `status`, `log`, `diff`, `show`, `branch`, `remote`, `ls-files`, `grep`, `rev-parse`, `blame`, `describe`, `merge-base`, `ls-tree`, and `cat-file`.
- `gh`: `pr view`, `pr list`, `issue view`, and `issue list`.

The first eight Git validators are built in and remain enabled when omitted, so listing them is valid but redundant.
The other six Git validators and every `gh` path require an explicit opt-in.
Git entries select one exact subcommand; `gh` entries select one exact two-word path, so `"pr view"` never enables `pr merge`, `pr close`, or `pr edit`.
Omitted `safeSubcommands`, an empty object, and empty arrays preserve the default policy.
Duplicate values are removed in first-seen order.

With the example configuration above, commands such as these are accepted:

```bash
git rev-parse --show-toplevel
git blame -- src/plan-mode.ts
git diff --cached
git show --stat --oneline HEAD
git log -p -1 HEAD -- src/plan-mode.ts
gh pr view 218 --json number,title,state
gh issue list --state open --json number,title,state
```

The command-specific validators still reject unsafe forms, including:

```bash
git blame --textconv -- src/plan-mode.ts
git cat-file --filters HEAD
git diff --ext-diff
git log --show-signature -1
git remote show origin
git show --textconv HEAD
gh pr merge 218
gh pr view 218
gh pr view 218 --web
gh pr view 218 > pr.txt
gh pr list --json number,title && gh pr merge 218
```

Redirects, shell expansion and substitution, explicit pager or browser requests, explicit external diff/textconv/filter/signature helpers, output flags, malformed command layouts, and any chain containing an unsafe segment fail closed.
Read-dominant Git validators accept ordinary inspection flags without requiring `--no-textconv` or `--no-ext-diff`; Git may therefore invoke a helper configured by the user or trusted repository even when the command does not request one explicitly.
Use the negative flags when you want to suppress those configured helpers.
Mixed read/write surfaces remain narrower: use `git remote show -n` to avoid invoking a transport helper, while mutating `branch` and `remote` forms remain blocked.
GitHub CLI read paths require `--json <fields>` output so Plan mode does not rely on `GH_PAGER`, `PAGER`, or gh pager configuration.
Unknown `safeSubcommands` keys or values, non-array values, and non-string entries invalidate the entire settings file and trigger the normal warning/default fallback on session start.

Read-only does not mean private: Git inspection can expose repository history and tracked secrets, while `gh` queries can expose remote repository, pull request, and issue data available to your authenticated account.
The policy reduces accidental mutation and explicit helper execution; it is not a sandbox or a confidentiality boundary.

### Thinking level

Plan mode inherits Pi's current thinking level by default.
Set `thinkingLevel` to request a fixed level only while Plan mode is active.
Supported values are `inherit`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
The extension snapshots the prior level and restores it on exit only if the level still matches the value it applied; a manual change made during Plan mode is preserved.
A Settings save does not change Pi's current or default thinking level and takes effect only when the next Plan workflow starts.

Settings saves are serialized in invocation order inside one Pi process.
Each save re-reads the latest valid document, preserves unknown top-level fields and unedited `safeSubcommands`, then publishes through a same-directory temporary file and rename.
A missing file stays absent until an explicit save.
Invalid JSON, invalid values, oversized content, non-regular files, and read failures make Settings read-only; the existing bytes and previous effective settings remain.
This in-process queue is not a cross-process lock, so concurrent separate Pi processes can still race.

Invalid settings produce a warning and fall back to inherited thinking, available safe-built-in tool defaults, `keep`, and `PLAN.md`.
Compatibility: a valid legacy `plan-mode.json` remains readable with a warning and is never modified automatically.
If Settings is explicitly saved while only that legacy file exists, the extension creates canonical `pi-plan-mode.json` from the complete legacy document, applies the selected change, preserves unknown fields, and leaves the legacy file untouched.
If both files exist, the canonical filename takes precedence.

## 🧠 Codex-like behavior

This extension maps Codex's `ModeKind::Plan` behavior onto Pi's extension API:

- Plan mode is a conversational collaboration mode, not TODO/progress tracking.
- `/plan <prompt>` follows Codex behavior by switching to Plan mode before submitting the inline prompt.
- The agent should use `plan_mode_question` for important non-discoverable preferences or tradeoffs before finalizing.
- The agent completes with a standalone `plan_mode_complete` tool call instead of relying on semantic prose detection.
- `update_plan` checklist use is blocked while Plan mode is active.
- The implementation boundary is explicit: Plan mode restores tools before saving or starting implementation, saving keeps the plan outside ordinary model context, choosing implementation immediately triggers a normal agent turn with full tool access, and the accepted plan follows the captured `keep`, `clear-on-start`, or `clear-after-first-run` lifecycle.
- Pi extension safety is approximated with tool classification and fail-closed filtering for every effective tool named `bash`; other non-built-in tools remain user-selected at user risk because Pi does not expose standardized tool mutability metadata.
- Unlike native Codex, this extension uses a terminating Pi tool plus an `agent_settled` ready flow; Pi cannot provide sandbox-level enforcement.

## 🗂️ Package layout

```txt
packages/pi-plan-mode/
├── dist/                  # Generated TypeScript runtime loaded by Jiti
├── scripts/
│   └── build-runtime.mjs  # Deterministic runtime builder and boundary validator
├── src/
│   ├── index.ts      # Pi package entrypoint
│   ├── plan-mode.ts      # Extension registration, mode state, and UI loading boundary
│   ├── interactive-ui.ts # Lazily loaded interactive menu surface
│   └── *.ts              # Package-local prompt, policy, question, and message modules
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

`index.ts` is the Pi entrypoint and forwards to `plan-mode.ts`; the other source modules are internal.
The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./dist/index.ts"]
  }
}
```

The generated runtime is built from the authoritative `src/index.ts` graph and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, plan mode, Codex-like plan mode, AI coding workflow, read-only planning, implementation plan.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
