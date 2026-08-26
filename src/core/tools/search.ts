/**
 * blueberry search — bb_search over ingested history + repo code (§Search).
 *
 * Registration shim for the fork's extension loader (manifest-pointed; the
 * logic lives in src/core/search.ts). Two indexes in blueberry.db:
 * - session_fts: full conversation history (ingested at compact/shutdown/sync)
 * - code_fts: repo file lines (indexed on demand for the project)
 *
 * The design-note contract: session hits return the 3–5 message neighborhood
 * with timestamps, roles, and todo-tag context — reorientation, not snippets.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { loadRegistryDb, openDb } from "../db.ts";
import { resolveProject } from "../resolution.ts";
import {
  filterBySlug,
  formatSessionHits,
  indexProject,
  searchCode,
  searchSessionsWithContext,
} from "../search.ts";

function agentDir(): string {
  return process.env["PI_CODING_AGENT_DIR"] ?? "";
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "bb_search",
    label: "Search",
    description:
      "Search blueberry's indexes. Actions: 'sessions' — full session history (FTS5, BM25); " +
      "every hit returns the 3–5 surrounding messages with timestamps and roles, so results " +
      "reorient instead of snippet-match. Todo tags (todo:<project>/<hex6>) are first-class " +
      "needles. 'code' — repo file lines (BM25, file:line); auto-indexes changed files first. " +
      "'index' — force a repo index refresh.",
    promptSnippet:
      "Search session history with context neighborhoods + repo code by line",
    promptGuidelines: [
      "Use bb_search sessions when the user references past work, decisions, or todo tasks across sessions; use bb_search code for symbol/text lookup in the repo.",
    ],
    parameters: Type.Object({
      action: StringEnum(["sessions", "code", "index"] as const),
      query: Type.Optional(
        Type.String({ description: "sessions/code: search text" }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      scope: Type.Optional(
        Type.String({
          description:
            "sessions: project (current project only) or global (default)",
        }),
      ),
    }),
    // deno-lint-ignore require-await
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const dir = agentDir();
      if (dir === "") {
        throw new Error("PI_CODING_AGENT_DIR not set — launch via bb");
      }
      const db = openDb(dir);
      try {
        if (params.action === "index") {
          const registry = loadRegistryDb(db);
          const res = resolveProject({ cwd: ctx.cwd, registry });
          const lines = indexProject(db, res.boundary.root);
          return {
            content: [
              {
                type: "text",
                text: `indexed ${lines} lines under ${res.boundary.root}`,
              },
            ],
            details: { lines },
          };
        }

        if (!params.query || params.query.trim() === "") {
          throw new Error("query required");
        }
        if (params.action === "sessions") {
          const sessionDir = process.env["PI_CODING_AGENT_SESSION_DIR"] ?? "";
          // live-session file name: <ts>_<uuid>.jsonl → id = uuid stem
          const liveId = sessionDir === ""
            ? undefined
            : (sessionDir.split("/").pop() ?? "").replace(/\.jsonl$/, "");
          const hits = searchSessionsWithContext(db, params.query, {
            limit: params.limit ?? 20,
            excludeSessionId: liveId || undefined,
          });
          if (params.scope === "project") {
            const registry = loadRegistryDb(db);
            const res = resolveProject({ cwd: ctx.cwd, registry });
            const scoped = filterBySlug(hits, res.project.slug);
            return {
              content: [
                {
                  type: "text",
                  text: scoped.length > 0
                    ? formatSessionHits(scoped)
                    : `no matches in ${res.project.slug} (global may have more)`,
                },
              ],
              details: { count: scoped.length, scope: "project" },
            };
          }
          return {
            content: [{ type: "text", text: formatSessionHits(hits) }],
            details: { count: hits.length, scope: "global" },
          };
        }

        // code: ensure fresh, then search
        const registry = loadRegistryDb(db);
        const res = resolveProject({ cwd: ctx.cwd, registry });
        indexProject(db, res.boundary.root);
        const hits = searchCode(db, params.query, params.limit ?? 30);
        if (hits.length === 0) {
          return {
            content: [{ type: "text", text: "no matches" }],
            details: { count: 0 },
          };
        }
        const lines = hits
          .map((h) => `${h.path}:${h.line}  ${h.text.slice(0, 160)}`)
          .join("\n");
        return {
          content: [{ type: "text", text: lines }],
          details: { count: hits.length },
        };
      } finally {
        db.close();
      }
    },
  });
}
