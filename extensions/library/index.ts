/**
 * blueberry library — cross-project session access for the model.
 *
 * Single tool, action enum (user decision 2025-08-25). Read-only: the model
 * can discover projects, list sessions, inspect any view (summary, tree,
 * messages, full single-message drill-down), and search history across all
 * projects. Forking stays a user action (bb sessions fork) by design.
 *
 * Agent dir resolution inside pi: PI_CODING_AGENT_DIR is set by the launcher;
 * fall back to BLUEBERRY_AGENT_DIR, then the default. The current project is
 * derived from ctx.cwd via normal resolution.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	resolveAddress,
	parseSessionFile,
	renderSummary,
	renderTree,
	renderMessages,
	renderMessage,
	searchSessions,
	formatSearchHits,
} from "../../src/core/library.ts";
import { loadRegistry } from "../../src/core/registry.ts";
import { resolveProject, storeDirFor } from "../../src/core/resolution.ts";
import { listSessions } from "../../src/core/sessions.ts";
import { getAgentDir } from "../../src/core/agent-dir.ts";

const Action = StringEnum(["projects", "sessions", "show", "search"] as const);
const View = StringEnum(["summary", "tree", "messages", "message"] as const);

function libraryAgentDir(): string {
	const env = process.env as Record<string, string | undefined>;
	const pi = env["PI_CODING_AGENT_DIR"];
	if (pi && pi.trim() !== "") return pi;
	return getAgentDir(process.env);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "bb_library",
		label: "Library",
		description:
			"Inspect sessions across blueberry projects. Actions: 'projects' lists registered projects; " +
			"'sessions' lists a project's sessions; 'show' inspects one session (views: summary, tree, " +
			"messages with tool one-liners, message = full single-message drill-down including thinking " +
			"and tool results); 'search' scans session text across projects. Read-only.",
		promptSnippet: "List and inspect sessions across projects (summaries, trees, messages, search)",
		promptGuidelines: [
			"Use bb_library when the user references work or decisions from another project or past sessions; start with the summary view and drill down (messages, then message) only as needed.",
		],
		parameters: Type.Object({
			action: Action,
			address: Type.Optional(
				Type.String({ description: "[project/]<index|uuid-prefix|name>; bare selector = current project" }),
			),
			project: Type.Optional(Type.String({ description: "project slug for 'sessions' and 'search' scoping" })),
			view: Type.Optional(View),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "messages view: skip N messages" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "messages view: max messages" })),
			message: Type.Optional(Type.Integer({ minimum: 1, description: "message view: 1-based message number" })),
			query: Type.Optional(Type.String({ description: "search action: text to find" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agentDir = libraryAgentDir();
			const registry = loadRegistry(agentDir);

			if (params.action === "projects") {
				if (registry.projects.length === 0) {
					return { content: [{ type: "text", text: "no projects registered" }], details: { projects: [] } };
				}
				const lines = registry.projects.map((p) => {
					const nested = p.mergedInto ? ` (nested into ${p.mergedInto})` : "";
					return `${p.slug}  [${p.sessionStore}]  ${p.canonicalPath}${nested}`;
				});
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { projects: registry.projects.map((p) => p.slug) },
				};
			}

			const res = resolveProject({ cwd: ctx.cwd, registry });
			const current = res.project;

			if (params.action === "sessions") {
				const target = params.project ? registry.projects.find((p) => p.slug === params.project) : current;
				if (!target) {
					throw new Error(`no project '${params.project}' (known: ${registry.projects.map((p) => p.slug).join(", ") || "none"})`);
				}
				const sessions = listSessions(storeDirFor(agentDir, target));
				if (sessions.length === 0) {
					return { content: [{ type: "text", text: `no sessions in '${target.slug}'` }], details: { project: target.slug, sessions: [] } };
				}
				const lines = sessions.map((s, i) => {
					const label = s.name ?? s.firstUserText?.slice(0, 50) ?? "(empty)";
					return `${i + 1}. ${s.id.slice(0, 8)}  ${label}  (${s.messageCount} msgs)`;
				});
				return {
					content: [{ type: "text", text: `[${target.slug}]\n${lines.join("\n")}` }],
					details: { project: target.slug, sessions: sessions.map((s) => s.id) },
				};
			}

			if (params.action === "search") {
				if (!params.query || params.query.trim() === "") throw new Error("search requires query");
				const scope = params.project ?? null;
				const opts = { all: scope === null, currentSlug: current.slug };
				if (scope) {
					// scoped: run unfiltered and post-filter so an explicit project always wins
					const hits = searchSessions(registry, agentDir, params.query, { all: true, currentSlug: current.slug });
					const scoped = hits.filter((h) => h.project === scope);
					return {
						content: [{ type: "text", text: formatSearchHits(scoped) }],
						details: { hits: scoped.length, scope },
					};
				}
				const hits = searchSessions(registry, agentDir, params.query, opts);
				return {
					content: [{ type: "text", text: formatSearchHits(hits) }],
					details: { hits: hits.length, scope: "all" },
				};
			}

			// action === "show"
			if (!params.address) throw new Error("show requires address");
			const resolved = resolveAddress(registry, agentDir, current.slug, params.address);
			const parsed = parseSessionFile(resolved.session.file);
			if (!parsed) throw new Error(`cannot parse session file ${resolved.session.file}`);

			const view = params.view ?? "summary";
			switch (view) {
				case "summary":
					return {
						content: [{ type: "text", text: renderSummary(resolved.session, parsed) }],
						details: { address: params.address, id: resolved.session.id },
					};
				case "tree":
					return {
						content: [{ type: "text", text: renderTree(parsed) }],
						details: { address: params.address, id: resolved.session.id },
					};
				case "messages": {
					const text = renderMessages(parsed, params.offset ?? 0, params.limit ?? 80);
					return {
						content: [{ type: "text", text }],
						details: { address: params.address, id: resolved.session.id, offset: params.offset ?? 0, limit: params.limit ?? 80 },
					};
				}
				case "message": {
					if (params.message === undefined) throw new Error("message view requires 'message' (1-based number from the messages view)");
					const text = renderMessage(parsed, params.message);
					return {
						content: [{ type: "text", text }],
						details: { address: params.address, id: resolved.session.id, message: params.message },
					};
				}
				default:
					throw new Error(`unknown view '${String(view)}' (expected summary, tree, messages, or message)`);
			}
		},
	});
}
