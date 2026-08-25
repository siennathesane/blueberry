/**
 * bb_cmd — model-facing command graph tool (design 003, R5).
 *
 * Same runner, same state as `blueberry cmd` CLI verbs. The model can define,
 * inspect, and run command graphs — including invoking templates (the
 * hook-manager replacement: judgment, not events).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

interface CmdToolInput {
	action: string;
	nodes?: string[];
	edges?: string[];
	target?: string;
	name?: string;
	params?: string;
	args?: Record<string, string>;
	node?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "bb_cmd",
		label: "Command Graph",
		description:
			"Command graph operations: define/run/inspect graphs of bash commands with dependencies. " +
			"Templates (named parameterized graphs) are the hook-manager replacement — " +
			"invoke them at the moment they're needed. Args arrive as BB_ARG_<NAME> env vars.",
		parameters: Type.Object({
			action: StringEnum(["new", "run", "ls", "ps", "logs", "template"]),
			nodes: Type.Optional(
				Type.Array(Type.String(), {
					description: "Node specs: 'name=command' strings (action: new, template)",
				}),
			),
			edges: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Dependency specs: 'node:dep' strings (action: new, template)",
				}),
			),
			target: Type.Optional(
				Type.String({
					description: "Graph id (prefix ok) or template name (actions: run, logs)",
				}),
			),
			name: Type.Optional(
				Type.String({ description: "Template name (action: template save)" }),
			),
			params: Type.Optional(
				Type.String({
					description: "Comma-separated parameter names (action: template save)",
				}),
			),
			args: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "Template arguments as key-value map (action: run)",
				}),
			),
			node: Type.Optional(
				Type.String({
					description: "Filter logs to a single node name (action: logs)",
				}),
			),
		}),
		async execute(_toolCallId: string, input: CmdToolInput) {
			const { openDb } = await import("../../src/core/db.ts");
			const {
				createGraph,
				listGraphs,
				graphNodes,
				nodeOutput,
				runGraph,
				runTemplate,
				saveTemplate,
				getTemplate,
				purgeOutput,
			} = await import("../../src/core/cmd-graph.ts");

			const agentDir = process.env["PI_CODING_AGENT_DIR"] ?? "";
			if (!agentDir)
				return { content: [{ type: "text", text: "no agent dir" }], details: {} };
			const db = openDb(agentDir);
			try {
				purgeOutput(db); // reaper-on-invocation
				switch (input.action) {
					case "new": {
						const nodes = (input.nodes ?? []).map((s: string) => {
							const eq = s.indexOf("=");
							return { name: s.slice(0, eq), command: s.slice(eq + 1) };
						});
						const edges = (input.edges ?? []).map((s: string) => {
							const [node, dep] = s.split(":");
							return { node: node ?? "", dep: dep ?? "" };
						});
						if (nodes.length === 0)
							return {
								content: [{ type: "text", text: "no nodes given" }],
								details: {},
							};
						const id = createGraph(db, null, nodes, edges, input.name);
						return { content: [{ type: "text", text: `graph ${id}` }], details: {} };
					}
					case "run": {
						if (!input.target)
							return { content: [{ type: "text", text: "no target" }], details: {} };
						let id = input.target;
						if (getTemplate(db, input.target)) {
							id = runTemplate(db, input.target, input.args ?? {}, null);
						} else {
							// SAFETY: node:sqlite row shape — {id} is the selected column
							const rows = db
								.prepare("SELECT id FROM cmd_graphs WHERE id LIKE ?")
								.all(`${input.target}%`) as unknown as Array<{ id: string }>;
							if (rows.length !== 1)
								return {
									content: [{ type: "text", text: `no graph '${input.target}'` }],
									details: {},
								};
							id = rows[0]!.id;
						}
						await runGraph(db, id);
						const g = listGraphs(db, null).find((x) => x.id === id);
						return {
							content: [
								{
									type: "text",
									text: `graph ${id.slice(0, 8)} ${g?.status ?? "unknown"}`,
								},
							],
							details: {},
						};
					}
					case "ls": {
						const lsText = listGraphs(db, null)
							.map(
								(g) => `${g.id.slice(0, 8)} ${g.status} ${g.origin} ${g.name ?? "—"}`,
							)
							.join("\n");
						return { content: [{ type: "text", text: lsText }], details: {} };
					}
					case "ps": {
						return {
							content: [
								{
									type: "text",
									text: listGraphs(db, null)
										.filter((g) => g.status === "running")
										.flatMap((g) =>
											graphNodes(db, g.id)
												.filter((n) => n.status === "running")
												.map((n) => `${g.id.slice(0, 8)} ${n.name} pid:${n.pid}`),
										)
										.join("\n"),
								},
							],
							details: {},
						};
					}
					case "logs": {
						if (!input.target)
							return { content: [{ type: "text", text: "no target" }], details: {} };
						// SAFETY: node:sqlite row shape — {id} is the selected column
						const rows = db
							.prepare("SELECT id FROM cmd_graphs WHERE id LIKE ?")
							.all(`${input.target}%`) as unknown as Array<{ id: string }>;
						if (rows.length !== 1)
							return {
								content: [{ type: "text", text: `no graph '${input.target}'` }],
								details: {},
							};
						const nodes = input.node
							? graphNodes(db, rows[0]!.id).filter((n) => n.name === input.node)
							: graphNodes(db, rows[0]!.id);
						const logsText = nodes
							.map((n) => {
								const out = nodeOutput(db, n.id)
									.map((l) => `  ${l.stream === "err" ? "!" : " "} ${l.text}`)
									.join("");
								return `── ${n.name} [${n.status}] ──\n${out}`;
							})
							.join("\n");
						return { content: [{ type: "text", text: logsText }], details: {} };
					}
					case "template": {
						if (input.name && input.params !== undefined) {
							const tplNodes = (input.nodes ?? []).map((s: string) => {
								const eq = s.indexOf("=");
								return { name: s.slice(0, eq), command: s.slice(eq + 1) };
							});
							const tplEdges = (input.edges ?? []).map((s: string) => {
								const [node, dep] = s.split(":");
								return { node: node ?? "", dep: dep ?? "" };
							});
							saveTemplate(db, input.name, {
								params: input.params.split(",").filter((p: string) => p !== ""),
								nodes: tplNodes,
								edges: tplEdges,
							});
							return {
								content: [
									{
										type: "text",
										text: `template '${input.name}' saved (${tplNodes.length} nodes)`,
									},
								],
								details: {},
							};
						}
						// SAFETY: node:sqlite row shape — {name} is the selected column
						const rows = db
							.prepare("SELECT name FROM cmd_templates ORDER BY name")
							.all() as unknown as Array<{ name: string }>;
						return {
							content: [{ type: "text", text: rows.map((r) => r.name).join("\n") }],
							details: {},
						};
					}
					default:
						return {
							content: [{ type: "text", text: `unknown action: ${input.action}` }],
							details: {},
						};
				}
			} finally {
				db.close();
			}
		},
	});
}
