/**
 * blueberry search — bb_search over ingested history + repo code (§Search).
 *
 * Two indexes in blueberry.db:
 * - session_fts: full conversation history (ingested at compact/shutdown/sync)
 * - code_fts: repo file lines (indexed on demand for the project)
 *
 * The design-note contract: session hits return the 3–5 message neighborhood
 * with timestamps, roles, and todo-tag context — reorientation, not snippets.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { openDb, loadRegistryDb } from "../../src/core/db.ts";
import { resolveProject } from "../../src/core/resolution.ts";
import {
	formatSessionHits,
	indexFileLines,
	searchCode,
	searchSessionsWithContext,
} from "../../src/core/search.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const INDEXABLE_EXT = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".json",
	".css",
	".scss",
	".html",
	".py",
	".rs",
	".go",
	".rb",
	".java",
	".kt",
	".c",
	".h",
	".cpp",
	".hpp",
	".cs",
	".sh",
	".bash",
	".zsh",
	".yml",
	".yaml",
	".toml",
	".md",
	".sql",
	".txt",
	".lua",
]);
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".blueberry",
	"dist",
	"build",
	"out",
	"coverage",
	".next",
	".cache",
	"vendor",
	"target",
	"__pycache__",
	".venv",
]);

/** Walk the project root and (re)index changed files. Returns lines indexed. */
export function indexProject(
	db: Parameters<typeof openDb>[0] extends never
		? never
		: import("node:sqlite").DatabaseSync,
	root: string,
): number {
	let total = 0;
	const walk = (dir: string): void => {
		let entries: Array<{ name: string; isDirectory(): boolean }>;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name.startsWith(".") && e.name !== ".github") continue;
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (SKIP_DIRS.has(e.name)) continue;
				walk(full);
			} else {
				const ext = e.name.slice(e.name.lastIndexOf("."));
				if (!INDEXABLE_EXT.has(ext)) continue;
				try {
					const st = statSync(full);
					const known = db
						.prepare("SELECT mtime_ms, size FROM files WHERE path = ?")
						.get(full) as { mtime_ms: number; size: number } | undefined;
					if (
						known &&
						known.mtime_ms === Math.round(st.mtimeMs) &&
						known.size === st.size
					)
						continue;
					total += indexFileLines(db, full, readFileSync(full, "utf8"));
				} catch {
					// unreadable/binary-ish: skip
				}
			}
		}
	};
	walk(root);
	return total;
}

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
		}),
		// deno-lint-ignore require-await
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const dir = agentDir();
			if (dir === "")
				throw new Error("PI_CODING_AGENT_DIR not set — launch via bb");
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

				if (!params.query || params.query.trim() === "")
					throw new Error("query required");
				if (params.action === "sessions") {
					const hits = searchSessionsWithContext(db, params.query, {
						limit: params.limit ?? 20,
					});
					return {
						content: [{ type: "text", text: formatSessionHits(hits) }],
						details: { count: hits.length },
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
