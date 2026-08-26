/**
 * blueberry todo — the real pane + bb_todo tool on blueberry.db (§Todo).
 *
 * - /todo: kanban pane (src/core/todo-pane.ts rendering) fed by the store
 * - bb_todo tool: single tool, action enum (house style). Every mutation
 *   emits a breadcrumb custom message embedding todo:<slug>/<hex6> — the
 *   search needle. display:true only for create/complete milestones.
 * - session_shutdown: bb-checkpoint digest appended to the session log.
 * - strip widget: always-on one-liner above the editor while tasks exist.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Component, Key, matchesKey } from "@earendil-works/pi-tui";
import {
  applyInput,
  CLOSED,
  type Intent,
  type PaneState,
  type PaneTheme,
  renderTodoPane,
  type TodoCard,
  visibleCells,
} from "../../src/core/todo-pane.ts";

/** Minimal TUI surface the pane needs (requestRender). */
interface TuiLike {
  requestRender(force?: boolean): void;
}
import {
  addDep,
  breadcrumb,
  checkpointDigest,
  createTodo,
  deleteTodo,
  formatHistoryLines,
  listTodos,
  removeDep,
  seedAnchor,
  setStage,
  STAGES,
  toCards,
} from "../../src/core/todo-store.ts";
import { loadRegistryDb, openDb } from "../../src/core/db.ts";
import { resolveProject } from "../../src/core/resolution.ts";

function agentDir(): string {
  return process.env["PI_CODING_AGENT_DIR"] ?? "";
}

function projectFor(cwd: string): { id: string; slug: string } | null {
  const dir = agentDir();
  if (dir === "") return null;
  const db = openDb(dir);
  try {
    const registry = loadRegistryDb(db);
    const res = resolveProject({ cwd, registry });
    return { id: res.project.id, slug: res.project.slug };
  } finally {
    db.close();
  }
}

function loadCards(cwd: string): TodoCard[] {
  const proj = projectFor(cwd);
  if (!proj) return [];
  const db = openDb(agentDir());
  try {
    return toCards(listTodos(db, proj.id));
  } finally {
    db.close();
  }
}

function keyToIntent(data: string): Intent | null {
  if (matchesKey(data, Key.enter)) return "enter";
  if (matchesKey(data, Key.backspace)) return "back";
  if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) return "prev";
  if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) return "next";
  if (matchesKey(data, Key.escape)) return "close";
  if (data === "q") return "close";
  if (data === "h" || data === "j") return "prev";
  if (data === "l" || data === "k") return "next";
  return null;
}

/** Open the interactive todo pane (shared by /todo and ctrl+p). */
async function openTodoPane(ctx: {
  cwd: string;
  mode: string;
  ui: {
    notify(msg: string, kind: "info" | "warning"): void;
    custom<T>(
      make: (
        tui: TuiLike,
        theme: PaneTheme,
        kb: unknown,
        done: (v: T) => void,
      ) => unknown,
    ): Promise<T>;
  };
}): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("todo pane requires interactive mode", "warning");
    return;
  }
  let cards = loadCards(ctx.cwd);
  const cwd = ctx.cwd;
  let state: PaneState = { cursor: 0, detail: false };
  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    let cachedLines: string[] | undefined;
    const component: Component = {
      render(width: number): string[] {
        let lines = cachedLines;
        if (!lines) {
          lines = renderTodoPane(width, theme, cards, state);
          cachedLines = lines;
        }
        return lines;
      },
      invalidate(): void {
        cachedLines = undefined;
      },
      handleInput(data: string): void {
        const intent = keyToIntent(data);
        if (!intent) return;
        // refresh on open so the pane reflects tool mutations
        const next = applyInput(state, intent, visibleCells(cards).length);
        if (next === CLOSED) {
          done();
          return;
        }
        state = next;
        cards = loadCards(cwd);
        cachedLines = undefined;
        tui.requestRender();
      },
    };
    return component;
  });
}

export default function (pi: ExtensionAPI) {
  // ctrl+p opens the pane (claimed via keybindings.json: model cycle → ctrl+m)
  pi.registerShortcut("ctrl+p", {
    description: "Open the todo pane",
    handler: async (ctx) => {
      await openTodoPane(ctx);
    },
  });

  // --- /todo pane on live data -------------------------------------------
  pi.registerCommand("todo", {
    description: "Todo pane",
    handler: async (_args, ctx) => {
      await openTodoPane(ctx);
    },
  });

  // --- strip widget --------------------------------------------------------
  const refreshStrip = (ctx: {
    cwd: string;
    ui: { setWidget(id: string, lines: string[] | undefined): void };
  }) => {
    const cards = loadCards(ctx.cwd);
    if (cards.length === 0) {
      ctx.ui.setWidget("bb-todo", undefined);
      return;
    }
    const done = cards.filter((c) => c.stage === "done").length;
    const doing = cards.filter((c) => c.stage === "doing");
    const ready = cards.filter((c) => c.stage === "todo" && c.ready);
    const review = cards.filter((c) => c.stage === "review").length;
    const parts = [`⬡ ${done}/${cards.length}`];
    if (doing[0]) {
      parts.push(`◉ ${doing[0]!.title.slice(0, 24)} ${doing[0]!.age}`);
    }
    if (review > 0) parts.push(`◷${review}`);
    if (ready[0]) parts.push(`next ▣ ${ready[0]!.title.slice(0, 24)}`);
    ctx.ui.setWidget("bb-todo", [` ${parts.join(" · ")}`]);
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) refreshStrip(ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    if (ctx.hasUI) refreshStrip(ctx);
  });

  // --- checkpoint at session end -------------------------------------------
  pi.on("session_shutdown", (_event, ctx) => {
    const dir = agentDir();
    const proj = projectFor(ctx.cwd);
    const sessionId = ctx.sessionManager.getSessionId();
    if (dir === "" || !proj || !sessionId) return;
    try {
      const db = openDb(dir);
      try {
        const digest = checkpointDigest(db, proj.id, proj.slug, sessionId);
        if (digest.includes("todo:")) {
          pi.sendMessage({
            customType: "bb-checkpoint",
            content: digest,
            display: false,
          });
        }
      } finally {
        db.close();
      }
    } catch {
      // best-effort
    }
  });

  // --- bb_todo tool ----------------------------------------------------------
  pi.registerTool({
    name: "bb_todo",
    label: "Todos",
    description:
      "Manage the project's todo DAG. Actions: list (cards with derived ready/blocked state), " +
      "create, move (stage: todo|doing|review|done|dropped; blocked tasks cannot advance), " +
      "dep (add/remove dependency, cycles rejected), delete. Every mutation logs a breadcrumb " +
      "with the task's id todo:<project>/<hex6> — searchable across sessions via bb_library.",
    promptSnippet:
      "Manage long-horizon task DAG (list/create/move/dep/delete) with cross-session search needles",
    promptGuidelines: [
      "Use bb_todo to track multi-step work: create tasks for distinct units, add deps reflecting real ordering, move work through stages, and complete tasks when done.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "create", "move", "dep", "delete"] as const),
      title: Type.Optional(Type.String({ description: "create: task title" })),
      id: Type.Optional(
        Type.String({ description: "hex6 task id for move/dep/delete" }),
      ),
      stage: Type.Optional(StringEnum(STAGES)),
      depId: Type.Optional(
        Type.String({ description: "dep: dependency task hex6" }),
      ),
      remove: Type.Optional(
        Type.Boolean({ description: "dep: remove instead of add" }),
      ),
    }),
    // deno-lint-ignore require-await
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const dir = agentDir();
      if (dir === "") {
        throw new Error("PI_CODING_AGENT_DIR not set — launch via bb");
      }
      const proj = projectFor(ctx.cwd);
      if (!proj) throw new Error("no project registered for this cwd");

      const sessionId = ctx.sessionManager.getSessionId();
      const db = openDb(dir);
      try {
        switch (params.action) {
          case "list": {
            const rows = listTodos(db, proj.id);
            const activeRows = rows.filter(
              (r) => r.stage !== "done" && r.stage !== "dropped",
            );
            const cards = toCards(activeRows);
            if (rows.length === 0) {
              return {
                content: [{ type: "text", text: `no todos in '${proj.slug}'` }],
                details: { cards: [], history: [] },
              };
            }
            const anchorIds = new Set(
              rows.filter((r) => r.isAnchor).map((r) => r.id),
            );
            const childOfAnchor = new Set<string>();
            for (const row of rows) {
              if (row.deps.some((d) => anchorIds.has(d))) {
                childOfAnchor.add(row.id);
              }
            }
            const cardById = new Map<string, (typeof cards)[number]>(
              cards.map((c) => {
                const full = activeRows.find((r) => r.hex6 === c.id);
                return full ? [full.id, c] : undefined;
              }).filter(Boolean) as Array<[string, (typeof cards)[number]]>,
            );
            const lines = activeRows.map((r) => {
              const c = cardById.get(r.id);
              if (!c) return "";
              if (r.isAnchor) {
                return `[${r.designId}] ${r.title} [${c.stage}] (${c.age})`;
              }
              const prefix = childOfAnchor.has(r.id) ? "  " : "";
              return `${prefix}${c.id} [${c.stage}] ${r.title} (${c.age})${
                c.ready ? " ready" : ""
              }${
                r.blockedBy?.length
                  ? ` blocked-by ${r.blockedBy.join(",")}`
                  : ""
              }`;
            });
            const historyLines = formatHistoryLines(rows);
            const allLines = [...lines, ...historyLines];
            const history = rows
              .filter((r) => r.stage === "done" || r.stage === "dropped")
              .sort((a, b) => {
                const tsA =
                  a.stage === "done" && a.done_at ? a.done_at : a.updated_at;
                const tsB =
                  b.stage === "done" && b.done_at ? b.done_at : b.updated_at;
                return new Date(tsB).getTime() - new Date(tsA).getTime();
              })
              .map((r) => ({
                hex6: r.hex6,
                stage: r.stage,
                title: r.title,
                doneAt: r.done_at,
                updatedAt: r.updated_at,
              }));
            return {
              content: [{
                type: "text",
                text: `[${proj.slug}]\n${allLines.join("\n")}`,
              }],
              details: { cards, history },
            };
          }
          case "create": {
            const res = createTodo(db, proj.id, params.title ?? "", {
              sessionId,
            });
            if (!res.ok || !res.todo) {
              throw new Error(res.reason ?? "create failed");
            }
            const line = breadcrumb(
              proj.slug,
              res.todo.hex6,
              res.todo.title,
              "created",
              [],
            );
            pi.sendMessage({
              customType: "bb-todo",
              content: line,
              display: true,
            });
            return {
              content: [{ type: "text", text: `created ${line}` }],
              details: { hex6: res.todo.hex6 },
            };
          }
          case "move": {
            if (!params.id || !params.stage) {
              throw new Error("move requires id + stage");
            }
            const res = setStage(db, proj.id, params.id, params.stage, {
              sessionId,
            });
            if (!res.ok || !res.todo) {
              throw new Error(res.reason ?? "move failed");
            }
            const blockedBy = listTodos(db, proj.id).find(
              (t) => t.hex6 === params.id,
            )!.blockedBy;
            const line = breadcrumb(
              proj.slug,
              res.todo.hex6,
              res.todo.title,
              `-> ${params.stage}`,
              blockedBy,
            );
            pi.sendMessage({
              customType: "bb-todo",
              content: line,
              display: params.stage === "done",
            });
            const warning = res.warning ? ` (warning: ${res.warning})` : "";
            return {
              content: [{ type: "text", text: `moved ${line}${warning}` }],
              details: { hex6: res.todo.hex6, stage: params.stage },
            };
          }
          case "dep": {
            if (!params.id || !params.depId) {
              throw new Error("dep requires id + depId");
            }
            const res = params.remove
              ? removeDep(db, proj.id, params.id, params.depId, { sessionId })
              : addDep(db, proj.id, params.id, params.depId, { sessionId });
            if (!res.ok || !res.todo) {
              throw new Error(res.reason ?? "dep failed");
            }
            const line = breadcrumb(
              proj.slug,
              res.todo.hex6,
              res.todo.title,
              params.remove ? `dep- ${params.depId}` : `dep+ ${params.depId}`,
              [],
            );
            pi.sendMessage({
              customType: "bb-todo",
              content: line,
              display: false,
            });
            return {
              content: [{ type: "text", text: line }],
              details: { hex6: res.todo.hex6 },
            };
          }
          case "delete": {
            if (!params.id) throw new Error("delete requires id");
            const res = deleteTodo(db, proj.id, params.id, { sessionId });
            if (!res.ok || !res.todo) {
              throw new Error(res.reason ?? "delete failed");
            }
            const line = breadcrumb(
              proj.slug,
              res.todo.hex6,
              res.todo.title,
              "deleted",
              [],
            );
            pi.sendMessage({
              customType: "bb-todo",
              content: line,
              display: false,
            });
            return { content: [{ type: "text", text: line }], details: {} };
          }
        }
      } finally {
        db.close();
      }
      // refresh the strip after any mutation
      if (ctx.hasUI) refreshStrip(ctx);
    },
  });
}
