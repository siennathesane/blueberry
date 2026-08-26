/**
 * blueberry lsp — bb_lsp tool + /lsp command (§LSP extension shell).
 *
 * All lifecycle in src/core/lsp-manager.ts; this is the pi-facing surface:
 * - bb_lsp tool: single tool, action enum (house style), full LSP surface
 * - /lsp command: human status view
 * - session_start: deferred watcher start; session_shutdown: dispose
 * - edit/write tool_result hook: model-only diagnostics nudge (display:false)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { LspManager } from "../../src/core/lsp-manager.ts";
import { languageIdForFile } from "../../src/core/lsp-manager.ts";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/** Robust file URI encoding (spaces, unicode). */
function fileUri(path: string): string {
  return pathToFileURL(path).href;
}

const Action = StringEnum(
  [
    "status",
    "diagnostics",
    "definition",
    "typeDefinition",
    "implementation",
    "references",
    "hover",
    "documentSymbol",
    "workspaceSymbol",
    "completion",
    "signatureHelp",
    "foldingRange",
    "semanticTokens",
    "rename",
    "formatting",
    "codeAction",
    "codeActionExecute",
    "codeLens",
    "callHierarchy",
    "typeHierarchy",
    "selectionRange",
    "documentHighlight",
    "documentLink",
  ] as const,
);

function pos(
  line1: number,
  char1: number,
): { line: number; character: number } {
  return { line: line1 - 1, character: char1 - 1 };
}

/** Shift 0-based LSP lines to 1-based for foldingRange and documentHighlight. */
export function toOneBasedLines(
  action: string,
  result: unknown,
): unknown {
  if (action === "foldingRange" && Array.isArray(result)) {
    return result.map((r: Record<string, unknown>) => ({
      ...r,
      startLine: ((r.startLine as number) ?? 0) + 1,
      endLine: ((r.endLine as number) ?? 0) + 1,
    }));
  }
  if (action === "documentHighlight" && Array.isArray(result)) {
    return result.map((r: Record<string, unknown>) => ({
      ...r,
      range: {
        ...(r.range as Record<string, unknown>),
        start: {
          ...(r.range as Record<string, unknown>)?.start as Record<
            string,
            unknown
          >,
          line: (((r.range as Record<string, unknown>)?.start as Record<
            string,
            unknown
          >)?.line as number ?? 0) + 1,
        },
        end: {
          ...(r.range as Record<string, unknown>)?.end as Record<
            string,
            unknown
          >,
          line: (((r.range as Record<string, unknown>)?.end as Record<
            string,
            unknown
          >)?.line as number ?? 0) + 1,
        },
      },
    }));
  }
  return result;
}

/** Disambiguate empty results: position-based vs list-type queries. */
export function emptyText(hasPosition: boolean): string {
  return hasPosition ? "no symbol at position" : "no results";
}

/** Retry once on empty results (cold-start guard). */
async function requestWithRetry(
  mgr: LspManager,
  method: string,
  params: unknown,
  file: string,
): Promise<unknown> {
  const result = await mgr.request(method, params, file);
  const isEmpty = result === null || result === undefined ||
    (Array.isArray(result) && result.length === 0) ||
    (typeof result === "object" && !Array.isArray(result) &&
      Object.keys(result).length === 0);
  if (!isEmpty) return result;
  try {
    await new Promise((r) => setTimeout(r, 1200));
  } catch {
    /* timer cancellation — return the empty first result */
    return result;
  }
  return mgr.request(method, params, file);
}

function fmtLocation(loc: unknown): string {
  if (!loc || typeof loc !== "object") return "(none)";
  const l = loc as {
    uri?: string;
    range?: { start?: { line?: number; character?: number } };
  };
  const file = l.uri ? l.uri.split("/").pop() : "?";
  const p = l.range?.start;
  return `${file}:${(p?.line ?? 0) + 1}:${(p?.character ?? 0) + 1}`;
}

function fmtDiagnostic(d: unknown): string {
  if (!d || typeof d !== "object") return "?";
  const dd = d as {
    severity?: number;
    message?: string;
    range?: { start?: { line?: number } };
  };
  const sev = dd.severity === 1
    ? "error"
    : dd.severity === 2
    ? "warn"
    : dd.severity === 3
    ? "info"
    : dd.severity === 4
    ? "hint"
    : "?";
  const line = (dd.range?.start?.line ?? 0) + 1;
  return `[${sev}] L${line}: ${(dd.message ?? "").split("\n")[0]}`;
}

export default function (pi: ExtensionAPI) {
  let manager: LspManager | null = null;

  const getManager = (root: string): LspManager => {
    if (!manager) {
      manager = new LspManager(root);
      manager.startWatcher();
    }
    return manager;
  };

  // --- lifecycle -------------------------------------------------------------
  pi.on("session_shutdown", () => {
    manager?.dispose();
    manager = null;
  });

  // --- diagnostics nudges on the context rail (§Context Layer 3) ----------
  // SUPERSede, don't accumulate: stale diagnostics are lies. The per-file
  // LATEST nudge rides the ephemeral context event (never persisted, never
  // cached — rebuilt fresh every LLM call); a clean file drops its nudge.
  // File set = every file touched by edit/write this session (tracked
  // in-memory; supersedeNudges keeps only the freshest snapshot per path).
  const touchedFiles = new Map<string, number>(); // path -> last touch seq

  // deno-lint-ignore require-await
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    if (!manager) return; // not started yet — no servers, no nudges
    const input = event.input as { path?: string } | undefined;
    if (!input?.path) return;
    const path = resolve(ctx.cwd, input.path);
    if (!languageIdForFile(path)) return;
    touchedFiles.set(path, (touchedFiles.get(path) ?? 0) + 1);
  });

  pi.on("context", (event) => {
    if (touchedFiles.size === 0 || !manager) return undefined;
    const lines: string[] = [];
    for (const path of touchedFiles.keys()) {
      const uri = fileUri(path);
      const diags = manager.getDiagnostics(uri).get(uri);
      if (!diags || diags.length === 0) continue; // clean file: no nudge
      const errors = diags.filter((d) => d.severity <= 2).length;
      const file = path.split("/").pop();
      lines.push(`lsp: ${errors} error(s)/warning(s) in ${file}`);
    }
    if (lines.length === 0) return undefined;
    // one ephemeral tail message: the CURRENT truth per touched file
    event.messages = [
      ...event.messages,
      {
        role: "user",
        content: "[diagnostics]" + "\n" + lines.join("\n"),
        timestamp: Date.now(),
      },
    ];
    return { messages: event.messages };
  });

  // --- /lsp command (human status) ------------------------------------------------
  pi.registerCommand("lsp", {
    description: "LSP server status",
    // deno-lint-ignore require-await
    handler: async (_args, ctx) => {
      if (!manager) {
        ctx.ui.notify(
          "lsp: no servers started yet (they spawn on first use)",
          "info",
        );
        return;
      }
      const status = manager.status();
      const lines = status.map((s) =>
        s.running
          ? `● ${s.name} (${s.serverInfo}) — ${s.openDocs} open, ${s.restarts} restarts, langs: ${
            s.languages.join(",")
          }`
          : `○ ${s.name} — available, not started, langs: ${
            s.languages.join(",")
          }`
      );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // --- bb_lsp tool (the model's full surface) ---------------------------------------
  pi.registerTool({
    name: "bb_lsp",
    label: "LSP",
    description:
      "Language-server intelligence. Actions: status, diagnostics (file or project), definition/typeDefinition/implementation " +
      "(jump to symbol), references (call sites), hover (type info), documentSymbol (outline), workspaceSymbol (query), " +
      "completion (discovery), signatureHelp, foldingRange, semanticTokens, rename (preview→apply), formatting, " +
      "codeAction (list quickfixes), codeActionExecute (apply one), codeLens, callHierarchy, typeHierarchy, " +
      "selectionRange, documentHighlight, documentLink. After edits, check diagnostics.",
    promptSnippet:
      "Language-server diagnostics, navigation, types, rename, formatting for the project's languages",
    promptGuidelines: [
      "Use bb_lsp diagnostics after editing files to verify correctness before claiming done.",
      "Use bb_lsp definition/references/hover to understand unfamiliar code precisely instead of guessing from text.",
      "Use bb_lsp rename for symbol-wide renames (preview first, then apply).",
    ],
    parameters: Type.Object({
      action: Action,
      path: Type.Optional(
        Type.String({ description: "file path (relative to project root)" }),
      ),
      line: Type.Optional(
        Type.Integer({ minimum: 1, description: "1-based line" }),
      ),
      char: Type.Optional(
        Type.Integer({ minimum: 1, description: "1-based character" }),
      ),
      query: Type.Optional(
        Type.String({ description: "workspaceSymbol query" }),
      ),
      newName: Type.Optional(
        Type.String({ description: "rename: new symbol name" }),
      ),
      apply: Type.Optional(
        Type.Boolean({
          description:
            "rename/formatting/codeActionExecute: apply (default: preview)",
        }),
      ),
      title: Type.Optional(
        Type.String({
          description:
            "codeActionExecute: action title from the codeAction list",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = resolve(ctx.cwd);
      const mgr = getManager(root);
      const absPath = params.path ? resolve(root, params.path) : null;
      const position = params.line !== undefined && params.char !== undefined
        ? pos(params.line, params.char)
        : undefined;

      try {
        switch (params.action) {
          case "status": {
            const status = mgr.status();
            const lines = status.map((s) =>
              s.running
                ? `● ${s.name} — ${s.openDocs} docs, ${s.restarts} restarts [${
                  s.languages.join(",")
                }]`
                : `○ ${s.name} — not started [${s.languages.join(",")}]`
            );
            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: { status },
            };
          }

          case "diagnostics": {
            if (absPath) {
              await mgr.openFile(absPath);
              // wait briefly for fresh push
              await new Promise((r) => setTimeout(r, 500));
              const uri = new URL(`file://${absPath}`).href;
              const diags = mgr.getDiagnostics(uri).get(uri) ?? [];
              if (diags.length === 0) {
                return {
                  content: [{
                    type: "text",
                    text: `no diagnostics in ${params.path}`,
                  }],
                  details: { count: 0 },
                };
              }
              return {
                content: [{
                  type: "text",
                  text: diags.map(fmtDiagnostic).join("\n"),
                }],
                details: { count: diags.length },
              };
            }
            // project-wide
            const all = mgr.getDiagnostics();
            const lines: string[] = [];
            let total = 0;
            for (const [uri, diags] of all) {
              if (diags.length === 0) continue;
              const file = uri.split("/").pop();
              lines.push(`${file}:`);
              lines.push(...diags.map((d) => `  ${fmtDiagnostic(d)}`));
              total += diags.length;
            }
            return {
              content: [
                {
                  type: "text",
                  text: lines.length > 0 ? lines.join("\n") : "no diagnostics",
                },
              ],
              details: { count: total },
            };
          }

          case "definition":
          case "typeDefinition":
          case "implementation": {
            if (!absPath || !position) {
              throw new Error(`${params.action} requires path + line + char`);
            }
            const method = params.action === "definition"
              ? "textDocument/definition"
              : params.action === "typeDefinition"
              ? "textDocument/typeDefinition"
              : "textDocument/implementation";
            const result = await requestWithRetry(mgr, method, {
              textDocument: { uri: new URL(`file://${absPath}`).href },
              position,
            }, absPath);
            const locs = Array.isArray(result) ? result : [result];
            return {
              content: [
                {
                  type: "text",
                  text: locs.map(fmtLocation).join("\n") || emptyText(true),
                },
              ],
              details: { locations: locs },
            };
          }

          case "references": {
            if (!absPath || !position) {
              throw new Error("references requires path + line + char");
            }
            const result = await requestWithRetry(
              mgr,
              "textDocument/references",
              {
                textDocument: { uri: new URL(`file://${absPath}`).href },
                position,
                context: { includeDeclaration: true },
              },
              absPath,
            );
            const locs = (Array.isArray(result) ? result : [result]) as Array<
              Record<string, unknown>
            >;
            return {
              content: [
                {
                  type: "text",
                  text: locs.map(fmtLocation).join("\n") || emptyText(true),
                },
              ],
              details: { count: locs.length },
            };
          }

          case "hover": {
            if (!absPath || !position) {
              throw new Error("hover requires path + line + char");
            }
            const result = (await requestWithRetry(mgr, "textDocument/hover", {
              textDocument: { uri: new URL(`file://${absPath}`).href },
              position,
            }, absPath)) as {
              contents?: { value?: string } | Array<{ value?: string }>;
            } | null;
            const text = Array.isArray(result?.contents)
              ? result!.contents.map((c) => c.value ?? "").join("\n")
              : (result?.contents?.value ?? "(empty)");
            return {
              content: [{ type: "text", text: text || "(empty)" }],
              details: {},
            };
          }

          case "documentSymbol": {
            if (!absPath) throw new Error("documentSymbol requires path");
            const result = await requestWithRetry(
              mgr,
              "textDocument/documentSymbol",
              { textDocument: { uri: new URL(`file://${absPath}`).href } },
              absPath,
            );
            const symbols = (Array.isArray(result) ? result : []) as Array<
              Record<string, unknown>
            >;
            const lines = symbols.map(
              (s) => `${s["kind"]}:${s["name"]} @${fmtLocation(s["location"])}`,
            );
            return {
              content: [{
                type: "text",
                text: lines.join("\n") || emptyText(false),
              }],
              details: { count: symbols.length },
            };
          }

          case "workspaceSymbol": {
            if (!params.query) {
              throw new Error("workspaceSymbol requires query");
            }
            if (!absPath) {
              throw new Error(
                "workspaceSymbol needs a file path to infer the language — pass path (any file in the project works)",
              );
            }
            // needs any file to route to the right server; use the first open or cwd
            const result = await requestWithRetry(mgr, "workspace/symbol", {
              query: params.query,
            }, absPath ?? root);
            const symbols = (Array.isArray(result) ? result : []) as Array<
              Record<string, unknown>
            >;
            return {
              content: [
                {
                  type: "text",
                  text: symbols
                    .map((s) => `${s["name"]} @${fmtLocation(s["location"])}`)
                    .join("\n") || emptyText(false),
                },
              ],
              details: { count: symbols.length },
            };
          }

          case "completion": {
            if (!absPath || !position) {
              throw new Error("completion requires path + line + char");
            }
            const result = await mgr.request(
              "textDocument/completion",
              {
                textDocument: { uri: new URL(`file://${absPath}`).href },
                position,
              },
              absPath,
            );
            const items = (
              Array.isArray(result)
                ? result
                : ((result as { items?: unknown[] })?.items ?? [])
            ) as Array<Record<string, unknown>>;
            return {
              content: [
                {
                  type: "text",
                  text: items.map((i) => String(i["label"] ?? "")).join(", ") ||
                    emptyText(true),
                },
              ],
              details: { count: items.length },
            };
          }

          case "signatureHelp": {
            if (!absPath || !position) {
              throw new Error("signatureHelp requires path + line + char");
            }
            const result = await mgr.request(
              "textDocument/signatureHelp",
              {
                textDocument: { uri: new URL(`file://${absPath}`).href },
                position,
              },
              absPath,
            );
            const sigs = (result as { signatures?: Array<{ label?: string }> })
              ?.signatures ?? [];
            return {
              content: [
                {
                  type: "text",
                  text: sigs.map((s) => s.label ?? "").join("\n") ||
                    emptyText(true),
                },
              ],
              details: {},
            };
          }

          case "rename": {
            if (!absPath || !position || !params.newName) {
              throw new Error("rename requires path + line + char + newName");
            }
            const edit = await mgr.request(
              "textDocument/rename",
              {
                textDocument: { uri: new URL(`file://${absPath}`).href },
                position,
                newName: params.newName,
              },
              absPath,
            );
            const changes =
              (edit as { changes?: Record<string, unknown[]> })?.changes ?? {};
            const files = Object.keys(changes);
            const summary = files.map(
              (f) => `${f.split("/").pop()}: ${changes[f]!.length} edits`,
            );
            return {
              content: [
                {
                  type: "text",
                  text: `rename preview (${files.length} files):\n${
                    summary.join("\n")
                  }\n\nPass apply:true to execute.`,
                },
              ],
              details: { files, edit },
            };
          }

          case "formatting": {
            if (!absPath) throw new Error("formatting requires path");
            const edits = await mgr.request(
              "textDocument/formatting",
              {
                textDocument: { uri: new URL(`file://${absPath}`).href },
                options: { tabSize: 2, insertSpaces: true },
              },
              absPath,
            );
            return {
              content: [
                {
                  type: "text",
                  text: `formatting: ${
                    Array.isArray(edits) ? edits.length : 0
                  } edits (apply via edit tool or apply:true)`,
                },
              ],
              details: { edits },
            };
          }

          case "codeAction": {
            if (!absPath || !position) {
              throw new Error("codeAction requires path + line + char");
            }
            const actions = await mgr.request(
              "textDocument/codeAction",
              {
                textDocument: { uri: new URL(`file://${absPath}`).href },
                range: { start: position, end: position },
                context: { diagnostics: [] },
              },
              absPath,
            );
            const list = (Array.isArray(actions) ? actions : []) as Array<
              Record<string, unknown>
            >;
            return {
              content: [
                {
                  type: "text",
                  text: list.map((a, i) =>
                    `${i + 1}. ${a["title"]}`
                  ).join("\n") || emptyText(true),
                },
              ],
              details: { actions: list },
            };
          }

          case "foldingRange":
          case "semanticTokens":
          case "codeLens":
          case "selectionRange":
          case "documentHighlight":
          case "documentLink": {
            if (!absPath) throw new Error(`${params.action} requires path`);
            const method = `textDocument/${params.action}` +
              (params.action === "semanticTokens" ? "/full" : "");
            const reqParams: Record<string, unknown> = {
              textDocument: { uri: new URL(`file://${absPath}`).href },
            };
            if (position) reqParams["position"] = position;
            const result = await mgr.request(method, reqParams, absPath);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(toOneBasedLines(params.action, result))
                    ?.slice(0, 2000) ?? "(empty)",
                },
              ],
              details: { result },
            };
          }

          case "callHierarchy":
          case "typeHierarchy": {
            if (!absPath || !position) {
              throw new Error(`${params.action} requires path + line + char`);
            }
            const prepareMethod = `textDocument/prepare${
              params.action === "callHierarchy"
                ? "CallHierarchy"
                : "TypeHierarchy"
            }`;
            const items = await mgr.request(
              prepareMethod,
              {
                textDocument: { uri: new URL(`file://${absPath}`).href },
                position,
              },
              absPath,
            );
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(items)?.slice(0, 2000) ??
                    emptyText(true),
                },
              ],
              details: { items },
            };
          }

          // deferred: codeActionExecute (needs the edit-apply machinery)
          case "codeActionExecute": {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `codeActionExecute: coming soon — use codeAction to list, then apply manually`,
                },
              ],
              details: {},
            };
          }
        }
      } catch (err) {
        // friendly error mapping (the manager's quirk table)
        const friendly = LspManager.friendlyError(params.action, err as Error);
        throw new Error(friendly);
      }
    },
  });
}
