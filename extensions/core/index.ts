/**
 * blueberry core — identity: opener header, terminal title, session-start guard.
 *
 * The opener replaces pi's stock startup header (DESIGN.md §Identity):
 *   line 1 — identity
 *   line 2 — project · branch · session (state at a glance)
 *   line 3 — one hint line (shortcuts aren't discoverable otherwise)
 * Everything else (resource listings, update banners) is suppressed, not
 * decorated over: quietStartup in settings, PI_OFFLINE in the launcher.
 * Skills stay model-side — the header never lists them (user decision).
 *
 * pi re-asserts its own terminal title on session events (updateTerminalTitle);
 * we re-assert ours on session_start and session_info_changed.
 *
 * The guard (§Sessions) warns when a launch would fragment history — the one
 * startup message that SHOULD interrupt.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { findProjectBoundary } from "../../src/core/markers.ts";
import { getVersion } from "../../src/core/version.ts";
import { projectNameFor, terminalTitle } from "../../src/core/identity.ts";
import { installInterceptor } from "../../src/core/title-guard.ts";
import {
  composeDatetimeLine,
  composeStateBlock,
  composeSystemPrompt,
  extractToolSurfaces,
  type IdentityProbe,
  type LiveState,
} from "../../src/core/context-composer.ts";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectFailureBlocks, parseJunit } from "../../src/core/lifecycle.ts";
import {
  type LinkCapability,
  probeLinkCapability,
} from "../../src/core/deeplink.ts";

/** Current branch name from .git/HEAD; null when not a git repo / unreadable. */
function gitBranch(root: string): string | null {
  try {
    const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
    const match = /^ref: refs\/heads\/(.+)$/.exec(head);
    if (match) return match[1]!;
    if (head !== "") return "detached";
  } catch {
    // no .git (lore repos, plain dirs): no branch segment
  }
  return null;
}

function lastSegment(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export default function (pi: ExtensionAPI) {
  // ── §Failure-only context injection (design 005) ───────────
  let pendingFailureIds: string[] = [];

  // ── §Context: the two rails ─────────────────────────────────
  // Rail 1 (system prompt): identity, FROZEN at first use — the prompt is
  // the cache-prefix root; our bytes never change mid-session (zero-
  // eviction). Rail 2 (context event): state + datetime, rebuilt fresh per
  // turn at the tail — never persisted, never cache-hostile.
  let frozenPrompt: string | null = null;

  const probeIdentity = async (cwd: string): Promise<IdentityProbe> => {
    const boundary = findProjectBoundary(resolve(cwd));
    const root = boundary ? boundary.root : resolve(cwd);
    const probe: IdentityProbe = {
      cwd,
      lspLanguages: [],
      hasDesignLifecycle: existsSync(join(root, "docs", "design")),
      hasTodos: false,
    };
    try {
      const { defaultServers } = await import("../../src/core/lsp-manager.ts");
      probe.lspLanguages = defaultServers().flatMap((s) => s.languageIds);
    } catch {
      // no servers installed = no bb_lsp surface in identity
    }
    const agentDir = process.env["PI_CODING_AGENT_DIR"];
    if (agentDir) {
      try {
        const { openDb } = await import("../../src/core/db.ts");
        const db = openDb(agentDir);
        try {
          probe.hasTodos =
            (db.prepare("SELECT COUNT(*) AS n FROM todos").get() as {
              n: number;
            }).n >
              0;
        } finally {
          db.close();
        }
      } catch {
        // probe failure = minimal identity, never a broken session
      }
    }
    return probe;
  };

  const TOOL_SOURCES = [
    "src/core/tools/search.ts",
    "src/core/tools/mint-id.ts",
    "extensions/library/index.ts",
    "extensions/lsp/index.ts",
    "extensions/todo/index.ts",
  ];

  const ensurePrompt = async (cwd: string): Promise<string> => {
    if (frozenPrompt === null) {
      const probe = await probeIdentity(cwd);
      const repoRoot = resolve(
        fileURLToPath(new URL("..", import.meta.url)),
        "..",
      );
      const toolPaths = TOOL_SOURCES.map((s) => join(repoRoot, s));
      const { snippets, guidelines } = extractToolSurfaces(toolPaths);
      frozenPrompt = composeSystemPrompt({
        cwd,
        probe,
        toolSnippets: snippets,
        promptGuidelines: guidelines,
      });
    }
    return frozenPrompt;
  };

  pi.on("before_agent_start", async (event, ctx) => {
    // Rail 1 — frozen prompt, byte-identical every turn (zero-eviction)
    const prompt = await ensurePrompt(ctx.cwd);
    event.systemPrompt = prompt;
  });

  // Derive the live state snapshot from the DB (never stale, never cached).
  const readLiveState = async (cwd: string): Promise<LiveState> => {
    const state: LiveState = { mode: "normal" };
    const agentDir = process.env["PI_CODING_AGENT_DIR"];
    if (!agentDir) return state;
    const boundary = findProjectBoundary(resolve(cwd));
    const root = boundary ? boundary.root : resolve(cwd);
    try {
      const { openDb, loadRegistryDb } = await import("../../src/core/db.ts");
      const { normalizePathForCompare } = await import(
        "../../src/core/util.ts"
      );
      const db = openDb(agentDir);
      try {
        const modeRow = db
          .prepare("SELECT json FROM config WHERE key = 'mode'")
          .get() as { json: string } | undefined;
        if (modeRow) {
          const mode = (JSON.parse(modeRow.json) as { mode?: string }).mode;
          if (mode === "design" || mode === "plan") state.mode = mode;
        }
        const registry = loadRegistryDb(db);
        const project = registry.projects.find(
          (p) =>
            normalizePathForCompare(p.canonicalPath) ===
              normalizePathForCompare(root),
        );
        if (project) {
          if (state.mode === "design") {
            const { findOpenDesign, checkCompleteness } = await import(
              "../../src/core/design-store.ts"
            );
            const open = findOpenDesign(db, project.id);
            if (open) {
              state.designTitle = open.title;
              state.missingSections = checkCompleteness(open.body).unanswered;
            }
          } else if (state.mode === "plan") {
            const row = db
              .prepare(
                "SELECT rev, status FROM plans WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1",
              )
              .get(project.id) as { rev: number; status: string } | undefined;
            if (row) state.planRev = row.rev;
          } else {
            // building: DAG progress (NOW/NEXT from ready todos)
            const { listTodos } = await import("../../src/core/todo-store.ts");
            const todos = listTodos(db, project.id);
            const done = todos.filter((t) => t.stage === "done");
            const ready = todos.filter(
              (t) => t.stage !== "done" && t.blockedBy.length === 0,
            );
            if (todos.length > 0 && done.length < todos.length) {
              state.buildingTitle = "current work";
              state.doneCount = done.length;
              state.totalCount = todos.length;
              state.nowTask = ready[0]?.title ?? undefined;
              state.nextTask = ready[1]?.title ?? undefined;
            }
          }
        }
      } finally {
        db.close();
      }
    } catch {
      // state derivation is best-effort; broken DB read degrades to normal
    }
    return state;
  };

  pi.on("context", async (event, ctx) => {
    // Rail 2 — ephemeral tail: state (DB-derived) + datetime (fresh clock)
    const lines: string[] = [];
    const block = composeStateBlock(await readLiveState(ctx.cwd));
    if (block !== "") lines.push(block);
    lines.push(composeDatetimeLine(new Date()));
    event.messages = [
      ...event.messages,
      { role: "user", content: lines.join("\n"), timestamp: Date.now() },
    ];
  });

  // ── §Failure-only context: detect test runs and inject on next turn ──
  pi.on("tool_result", (event, ctx) => {
    try {
      if (event.toolName !== "bash") return;
      const input = event.input as { command?: string } | undefined;
      const cmd = input?.command ?? "";
      if (!cmd.includes("deno test") && !cmd.includes("deno task test")) return;
      const junitPath = join(ctx.cwd, ".blueberry", "lifecycle-junit.xml");
      if (!existsSync(junitPath)) return;
      const xml = readFileSync(junitPath, "utf8");
      const cases = parseJunit(xml);
      const failing = cases.filter((c) =>
        c.outcome === "fail" && c.id !== null
      );
      if (failing.length === 0) return;
      const seen = new Set<string>();
      pendingFailureIds = [];
      for (const c of failing) {
        if (c.id && !seen.has(c.id)) {
          seen.add(c.id);
          pendingFailureIds.push(c.id);
        }
      }
    } catch {
      // never throw from the hook
    }
  });

  pi.on("context", async (event, ctx) => {
    if (pendingFailureIds.length === 0) return undefined;
    const agentDir = process.env["PI_CODING_AGENT_DIR"];
    if (!agentDir) {
      pendingFailureIds = [];
      return undefined;
    }
    try {
      const { openDb } = await import("../../src/core/db.ts");
      const db = openDb(agentDir);
      try {
        const linkCap: LinkCapability = probeLinkCapability();
        // resolve slug for card refs (best-effort: use the first project)
        let failSlug: string | undefined;
        try {
          const { loadRegistryDb } = await import("../../src/core/db.ts");
          const { normalizePathForCompare } = await import(
            "../../src/core/util.ts"
          );
          const registry = loadRegistryDb(db);
          const boundary = findProjectBoundary(resolve(ctx.cwd));
          const root = boundary ? boundary.root : resolve(ctx.cwd);
          const project = registry.projects.find(
            (p) =>
              normalizePathForCompare(p.canonicalPath) ===
                normalizePathForCompare(root),
          );
          failSlug = project?.slug;
        } catch {
          // best-effort
        }
        const { blocks, overflowIds } = collectFailureBlocks(
          db,
          pendingFailureIds,
          3,
          { linkCap, slug: failSlug, tty: process.stdout.isTTY === true },
        );
        const content = "[lifecycle]" + "\n" + blocks.join("\n\n") +
          (overflowIds.length
            ? "\nmore: " + overflowIds.map((i) => `[${i}]`).join(" ")
            : "");
        event.messages = [
          ...event.messages,
          { role: "user", content, timestamp: Date.now() },
        ];
      } finally {
        db.close();
      }
    } catch {
      // best-effort
    } finally {
      pendingFailureIds = [];
    }
    return { messages: event.messages };
  });

  // /exit — the muscle-memory command pi never shipped. Graceful: defers
  // until the agent is idle (queued messages drain first) and emits
  // session_shutdown, so every cleanup hook runs.
  pi.registerCommand("exit", {
    description: "Quit blueberry",
    // deno-lint-ignore require-await
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });

  const applyIdentity = (
    ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
    reason: string,
  ) => {
    const cwd = resolve(ctx.cwd);
    const boundary = findProjectBoundary(cwd);
    const root = boundary ? boundary.root : cwd;
    const name = lastSegment(root);
    const branch = boundary ? gitBranch(root) : null;
    const sessionId = ctx.sessionManager.getSessionId().slice(0, 8);
    const resumed = reason === "resume" || reason === "fork";

    if (ctx.mode === "tui") {
      ctx.ui.setHeader((_tui, theme) => ({
        render(_width: number): string[] {
          const line1 = theme.fg("accent", theme.bold("🫐 blueberry")) +
            theme.fg("muted", ` ${getVersion()}`) +
            theme.fg("dim", " · orange juice");
          const segments = [name];
          if (branch) segments.push(branch);
          segments.push(`session ${sessionId}`);
          if (resumed) segments.push("resumed");
          const line2 = theme.fg("muted", segments.join(" · "));
          const line3 = theme.fg(
            "dim",
            "esc interrupt · / commands · ctrl+o everything else",
          );
          return [line1, line2, line3];
        },
        invalidate() {},
      }));
      ctx.ui.setTitle(terminalTitle(name));
    }
    return { cwd, boundary };
  };

  pi.on("session_start", (event, ctx) => {
    // §Title-guard: transport-level claim. pi writes OSC 0 titles from 8
    // internal call sites (incl. async paths no event can observe) — we
    // rewrite every non-ours title at the byte level instead of racing
    // events. Also rewrites pi's exit resume hint to the bb surface.
    if (ctx.mode === "tui") {
      const boundary0 = findProjectBoundary(resolve(ctx.cwd));
      // SAFETY: process.stdout satisfies the structural write(...args)
      // surface; the cast bridges Node's overloaded stream typing only.
      installInterceptor(
        process.stdout as unknown as {
          write(...args: unknown[]): boolean;
        } & object,
        terminalTitle(projectNameFor(boundary0 ? boundary0.root : ctx.cwd)),
      );
    }

    const { cwd, boundary } = applyIdentity(ctx, event.reason);

    // Fragmentation guard (§Sessions): warn when this session is NOT
    // anchored at a project root — the one startup interrupt that matters.
    if (!ctx.hasUI) return;
    if (!boundary) {
      if (process.env["PI_CODING_AGENT_SESSION_DIR"] === undefined) {
        ctx.ui.notify(
          "blueberry guard: no project boundary above this directory and no blueberry session dir — this looks like a bare `pi` launch. History may fragment; use `bb`.",
          "warning",
        );
      }
      return;
    }
    if (boundary.root !== cwd) {
      ctx.ui.notify(
        `blueberry guard: session cwd is '${cwd}', not the project root '${boundary.root}'. Use bb (canonicalizes automatically) or bb --here (intentional).`,
        "warning",
      );
    }
  });

  // pi re-asserts its title from several internal events (startup .finally,
  // session switch, model change...). Self-healing: re-claim on every event
  // we can see — worst case the title is wrong for one sub-turn.
  const claimTitle = (ctx: {
    cwd: string;
    mode: string;
    ui: { setTitle(t: string): void };
  }) => {
    if (ctx.mode !== "tui") return;
    const boundary = findProjectBoundary(resolve(ctx.cwd));
    const name = projectNameFor(boundary ? boundary.root : ctx.cwd);
    ctx.ui.setTitle(terminalTitle(name));
  };
  pi.on("session_info_changed", (_event, ctx) => claimTitle(ctx));
  pi.on("model_select", (_event, ctx) => claimTitle(ctx));
  pi.on("agent_start", (_event, ctx) => claimTitle(ctx));

  // §Data sync: ingest this session's JSONL into blueberry.db at compaction
  // and shutdown. Fire-and-forget — sync failures must never disturb the
  // session; bb sync catches anything missed (e.g. crashes).
  const syncThisSession = (ctx: {
    sessionManager: { getSessionFile(): string | undefined };
  }) => {
    try {
      const file = ctx.sessionManager.getSessionFile();
      if (!file) return;
      const agentDir = process.env["PI_CODING_AGENT_DIR"] ?? "";
      if (agentDir === "") return;
      // inline dynamic import to keep module load light under jiti
      void import("../../src/core/db.ts")
        .then(async ({ openDb, loadRegistryDb }) => {
          const { ingestSessionFile } = await import("../../src/core/sync.ts");
          const db = openDb(agentDir);
          try {
            const registry = loadRegistryDb(db);
            const byPath = new Map<string, string>();
            for (const p of registry.projects) {
              byPath.set(p.canonicalPath, p.id);
              for (const a of p.aliases) byPath.set(a, p.id);
            }
            ingestSessionFile(
              db,
              file,
              (cwd) => cwd ? (byPath.get(cwd) ?? null) : null,
            );
          } finally {
            db.close();
          }
        })
        .catch(() => {
          // best-effort only
        });
    } catch {
      // best-effort only
    }
  };
  pi.on("session_compact", (_event, ctx) => syncThisSession(ctx));
  pi.on("session_shutdown", (_event, ctx) => syncThisSession(ctx));
}
