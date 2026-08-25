/**
 * blueberry design+plan — the lifecycle extension (§Design + §Plan layer).
 *
 * Mode ring (shift+tab): normal → design → plan → normal. Modes are
 * project-wide DB state (config table); any session sees them.
 * - design mode: scaffold/reorient the open doc; bb_design actions
 * - plan mode: decompose; bb_plan actions; y-gate seeds the DAG
 * - normal: building = normal with an active plan (strip N/M)
 *
 * Tools: bb_design (draft/revise/status/abandon/supersede/complete-check),
 * bb_plan (draft/status/steps/passes/approve/abandon/enumerate-stubs).
 * Commands: /design /plan render docs + gate keys.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { openDb, loadRegistryDb } from "../../src/core/db.ts";
import { resolveProject } from "../../src/core/resolution.ts";
import { hex6Of } from "../../src/core/todo-store.ts";
import {
	checkCompleteness,
	designBreadcrumb,
	findOpenDesign,
	REQUIRED_SECTIONS,
	scaffoldDesign,
	writeDesignStatus,
} from "../../src/core/design-store.ts";
import {
	activePlan,
	createPlan,
	getPlan,
	planBreadcrumb,
	planProgress,
	runAllPasses,
	seedPlan,
	setPlanStatus,
	updatePlanBody,
} from "../../src/core/plan-store.ts";
import { ingestDesignDocs } from "../../src/core/doc-index.ts";

type Mode = "normal" | "design" | "plan";

const MODE_KEY = "mode";

function agentDir(): string {
	return process.env["PI_CODING_AGENT_DIR"] ?? "";
}

function projectFor(
	cwd: string,
): { id: string; slug: string; root: string } | null {
	const dir = agentDir();
	if (dir === "") return null;
	const db = openDb(dir);
	try {
		const registry = loadRegistryDb(db);
		const res = resolveProject({ cwd, registry });
		return {
			id: res.project.id,
			slug: res.project.slug,
			root: res.boundary.root,
		};
	} finally {
		db.close();
	}
}

function readMode(db: ReturnType<typeof openDb>): Mode {
	const row = db
		.prepare("SELECT json FROM config WHERE key = ?")
		.get(MODE_KEY) as { json: string } | undefined;
	if (!row) return "normal";
	try {
		const parsed = JSON.parse(row.json) as { mode?: string };
		return parsed.mode === "design" || parsed.mode === "plan"
			? parsed.mode
			: "normal";
	} catch {
		return "normal";
	}
}

function writeMode(db: ReturnType<typeof openDb>, mode: Mode): void {
	db
		.prepare(
			"INSERT INTO config (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json",
		)
		.run(MODE_KEY, JSON.stringify({ mode }));
}

export default function (pi: ExtensionAPI) {
	// --- strip widget ----------------------------------------------------------------
	const refreshStrip = (ctx: {
		cwd: string;
		ui: { setWidget(id: string, lines: string[] | undefined): void };
	}) => {
		const dir = agentDir();
		if (dir === "") return;
		const proj = projectFor(ctx.cwd);
		if (!proj) return;
		const db = openDb(dir);
		try {
			const mode = readMode(db);
			if (mode === "design") {
				const open = findOpenDesign(db, proj.id);
				ctx.ui.setWidget("bb-mode", [` ◈ designing ${open ? open.title : "—"}`]);
				return;
			}
			if (mode === "plan") {
				const plan = activePlan(db, proj.id);
				ctx.ui.setWidget("bb-mode", [
					` ⬡ planning ${plan ? `rev ${plan.rev}` : "—"}`,
				]);
				return;
			}
			// normal: building?
			const plan = activePlan(db, proj.id);
			if (plan && plan.status === "building") {
				const prog = planProgress(db, plan);
				ctx.ui.setWidget("bb-mode", [` ⬡ building ${prog.done}/${prog.total}`]);
			} else {
				ctx.ui.setWidget("bb-mode", undefined);
			}
		} finally {
			db.close();
		}
	};

	pi.on("session_start", (_e, ctx) => {
		if (ctx.hasUI) refreshStrip(ctx);
	});
	pi.on("agent_end", (_e, ctx) => {
		if (ctx.hasUI) refreshStrip(ctx);
	});

	// --- shift+tab mode ring ------------------------------------------------------------
	pi.registerShortcut("shift+tab", {
		description: "Cycle lifecycle mode: normal → design → plan → normal",
		handler: async (ctx) => {
			const dir = agentDir();
			const proj = projectFor(ctx.cwd);
			if (dir === "" || !proj) {
				ctx.ui.notify("blueberry: no project for mode ring", "warning");
				return;
			}
			const db = openDb(dir);
			try {
				const mode = readMode(db);
				let next: Mode;
				switch (mode) {
					case "normal": {
						next = "design";
						const open = findOpenDesign(db, proj.id);
						ctx.ui.notify(
							open
								? `◈ reorienting: ${open.title}`
								: "◈ design mode — scaffold with /design or bb_design draft",
							"info",
						);
						break;
					}
					case "design": {
						// design → plan requires decided
						const open = findOpenDesign(db, proj.id);
						if (!open) {
							ctx.ui.notify(
								"design mode but no open design — scaffold first (/design)",
								"warning",
							);
							return;
						}
						if (open.status !== "decided") {
							ctx.ui.notify(
								"approve the design first — /design then y (all required sections)",
								"warning",
							);
							return;
						}
						next = "plan";
						ctx.ui.notify("⬡ plan mode — decompose with bb_plan", "info");
						break;
					}
					case "plan": {
						// plan → normal: if building, it IS normal; if draft, confirm-lite (toast)
						const plan = activePlan(db, proj.id);
						if (plan && plan.status === "draft") {
							ctx.ui.notify(
								"draft plan kept in db — bb_plan approve to seed, or continue editing",
								"info",
							);
						}
						next = "normal";
						break;
					}
				}
				writeMode(db, next);
			} finally {
				db.close();
			}
			if (ctx.hasUI) refreshStrip(ctx);
		},
	});

	// --- breadcrumbs helper ---------------------------------------------------------
	const needle = (customType: string, content: string, display = false) => {
		pi.sendMessage({ customType, content, display });
	};

	// --- bb_design tool -----------------------------------------------------------------
	pi.registerTool({
		name: "bb_design",
		label: "Design",
		description:
			"Manage the design lifecycle. Actions: draft (scaffold a new design doc or show the open one), " +
			"revise (write section content into the open doc — provide the full updated body or per-section), " +
			"status (completeness report: unanswered sections, MUST coverage), decide (mark decided — requires " +
			"all required sections answered), abandon, supersede (mark superseded + note successor). " +
			"The design doc is a file in docs/design/ — the file is truth.",
		promptSnippet:
			"Design lifecycle: scaffold, fill, completeness-check, and decide design docs",
		promptGuidelines: [
			"Use bb_design when entering design mode or working on a design doc; check status before decide — the gate refuses unanswered sections.",
		],
		parameters: Type.Object({
			action: StringEnum([
				"draft",
				"revise",
				"status",
				"decide",
				"abandon",
				"supersede",
			] as const),
			title: Type.Optional(
				Type.String({ description: "draft: new design title" }),
			),
			body: Type.Optional(
				Type.String({
					description: "revise: full updated markdown body (without frontmatter)",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const dir = agentDir();
			if (dir === "")
				throw new Error("PI_CODING_AGENT_DIR not set — launch via bb");
			const proj = projectFor(ctx.cwd);
			if (!proj) throw new Error("no project registered for this cwd");
			const db = openDb(dir);
			try {
				ingestDesignDocs(db, proj.root, proj.id); // sync file state first
				switch (params.action) {
					case "draft": {
						const existing = findOpenDesign(db, proj.id);
						if (existing) {
							return {
								content: [
									{
										type: "text",
										text: `open design exists: ${existing.title} (${existing.id})\npath: ${existing.path}\n\nUse revise to edit; status to check completeness.`,
									},
								],
								details: { path: existing.path, id: existing.id },
							};
						}
						if (!params.title)
							throw new Error("draft requires title for a new design");
						const { path, id } = scaffoldDesign(proj.root, params.title);
						ingestDesignDocs(db, proj.root, proj.id);
						needle(
							"bb-design",
							designBreadcrumb(proj.slug, id, params.title, "drafted"),
							true,
						);
						return {
							content: [
								{
									type: "text",
									text: `scaffolded ${path}\nid: ${id}\n\nSections to answer: ${REQUIRED_SECTIONS.join(", ")}`,
								},
							],
							details: { path, id },
						};
					}
					case "revise": {
						const open = findOpenDesign(db, proj.id);
						if (!open) throw new Error("no open design — draft first");
						if (!params.body) throw new Error("revise requires body");
						const { readFileSync, writeFileSync } = await import("node:fs");
						const raw = readFileSync(open.path, "utf8");
						const fmBlock = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(raw);
						const newRaw = `${fmBlock ? fmBlock[0] : "---\n---\n\n"}${params.body}`;
						writeFileSync(open.path, newRaw);
						ingestDesignDocs(db, proj.root, proj.id);
						needle(
							"bb-design",
							designBreadcrumb(proj.slug, open.id, open.title, "revised"),
							false,
						);
						return {
							content: [
								{ type: "text", text: "revised. run status to check completeness." },
							],
							details: {},
						};
					}
					case "status": {
						const open = findOpenDesign(db, proj.id);
						if (!open)
							return {
								content: [{ type: "text", text: "no open design" }],
								details: {},
							};
						const report = checkCompleteness(open.body);
						const lines = [
							`design: ${open.title} (${open.id}) — ${open.status}`,
							report.unanswered.length === 0
								? "all required sections answered ✓"
								: `unanswered: ${report.unanswered.join(", ")}`,
							`MUSTs: ${report.requirements.musts.length}, uncovered: ${report.requirements.uncoveredMusts.length}`,
						];
						return {
							content: [{ type: "text", text: lines.join("\n") }],
							details: { ...report },
						};
					}
					case "decide": {
						const open = findOpenDesign(db, proj.id);
						if (!open) throw new Error("no open design");
						const report = checkCompleteness(open.body);
						if (report.unanswered.length > 0) {
							throw new Error(
								`gate refused — unanswered sections: ${report.unanswered.join(", ")}`,
							);
						}
						writeDesignStatus(open.path, "decided");
						ingestDesignDocs(db, proj.root, proj.id);
						needle(
							"bb-design",
							designBreadcrumb(proj.slug, open.id, open.title, "decided"),
							true,
						);
						return {
							content: [
								{ type: "text", text: `decided ✓ — shift+tab or /plan to decompose` },
							],
							details: {},
						};
					}
					case "abandon": {
						const open = findOpenDesign(db, proj.id);
						if (!open) throw new Error("no open design");
						writeDesignStatus(open.path, "abandoned");
						ingestDesignDocs(db, proj.root, proj.id);
						needle(
							"bb-design",
							designBreadcrumb(proj.slug, open.id, open.title, "abandoned"),
							false,
						);
						return {
							content: [
								{ type: "text", text: "abandoned (doc kept for archaeology)" },
							],
							details: {},
						};
					}
					case "supersede": {
						const open = findOpenDesign(db, proj.id);
						if (!open) throw new Error("no open design");
						writeDesignStatus(open.path, "superseded", {
							supersededBy: "pending-next",
						});
						ingestDesignDocs(db, proj.root, proj.id);
						needle(
							"bb-design",
							designBreadcrumb(proj.slug, open.id, open.title, "superseded"),
							false,
						);
						return {
							content: [
								{
									type: "text",
									text: "superseded — draft the successor; its doc will link back",
								},
							],
							details: {},
						};
					}
				}
			} finally {
				db.close();
			}
			if (ctx.hasUI) refreshStrip(ctx);
		},
	});

	// --- bb_plan tool --------------------------------------------------------------------
	pi.registerTool({
		name: "bb_plan",
		label: "Plan",
		description:
			"Decompose a decided design into an executable plan. Actions: draft (create plan body — Steps with " +
			"`R#` tags and ⟵ deps, Deliverable/Acceptance per step, Test matrix, Coverage matrix, Not-enumerated " +
			"ledger), status (current plan + passes report), passes (run the four consistency checks), approve " +
			"(seed the DAG — requires clean-or-acknowledged passes), abandon. The y-gate equivalent is approve.",
		promptSnippet:
			"Plan lifecycle: decompose designs into steps+deps, verify consistency, seed the todo DAG",
		promptGuidelines: [
			"Use bb_plan in plan mode: draft the full decomposition (steps with requirement tags and deps, test matrix, coverage matrix, omission ledger), run passes, then approve to seed.",
		],
		parameters: Type.Object({
			action: StringEnum([
				"draft",
				"status",
				"passes",
				"approve",
				"abandon",
			] as const),
			body: Type.Optional(
				Type.String({
					description:
						"draft: full plan markdown (Steps, Test matrix, Coverage matrix, Not enumerated)",
				}),
			),
			force: Type.Optional(
				Type.Boolean({
					description: "approve: seed despite pass findings (acknowledged risk)",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const dir = agentDir();
			if (dir === "")
				throw new Error("PI_CODING_AGENT_DIR not set — launch via bb");
			const proj = projectFor(ctx.cwd);
			if (!proj) throw new Error("no project registered for this cwd");
			const db = openDb(dir);
			try {
				ingestDesignDocs(db, proj.root, proj.id);
				const design = findOpenDesign(db, proj.id);
				switch (params.action) {
					case "draft": {
						if (!params.body) throw new Error("draft requires body");
						const existing = activePlan(db, proj.id);
						if (existing && existing.status === "draft") {
							updatePlanBody(db, existing.id, params.body);
							const plan = getPlan(db, existing.id)!;
							needle(
								"bb-plan",
								planBreadcrumb(
									proj.slug,
									hex6Of(plan.id),
									"plan",
									`revise rev ${plan.rev}`,
								),
								false,
							);
							return {
								content: [{ type: "text", text: `updated draft (rev ${plan.rev})` }],
								details: { id: plan.id },
							};
						}
						const plan = createPlan(db, proj.id, params.body, {
							designId: design?.id ?? null,
						});
						needle(
							"bb-plan",
							planBreadcrumb(proj.slug, hex6Of(plan.id), "plan", "drafted"),
							true,
						);
						return {
							content: [
								{
									type: "text",
									text: `plan drafted (${plan.id.slice(0, 6)}…) — run passes, then approve to seed`,
								},
							],
							details: { id: plan.id },
						};
					}
					case "status": {
						const plan = activePlan(db, proj.id);
						if (!plan)
							return {
								content: [{ type: "text", text: "no active plan — bb_plan draft" }],
								details: {},
							};
						const passes = runAllPasses(design ? design.body : null, plan.body);
						const prog = planProgress(db, plan);
						const lines = [
							`plan ${hex6Of(plan.id)} — ${plan.status} (rev ${plan.rev})`,
							`progress: ${prog.done}/${prog.total}`,
							...passes.map(
								(p) =>
									`${p.pass} ${p.clean ? "✓" : `✗ ${p.findings.join("; ").slice(0, 120)}`}`,
							),
						];
						return {
							content: [{ type: "text", text: lines.join("\n") }],
							details: {},
						};
					}
					case "passes": {
						const plan = activePlan(db, proj.id);
						if (!plan) throw new Error("no active plan");
						const passes = runAllPasses(design ? design.body : null, plan.body);
						return {
							content: [
								{
									type: "text",
									text: passes
										.map((p) => `${p.pass} ${p.clean ? "clean" : p.findings.join("; ")}`)
										.join("\n"),
								},
							],
							details: { passes },
						};
					}
					case "approve": {
						const plan = activePlan(db, proj.id);
						if (!plan) throw new Error("no active plan");
						const passes = runAllPasses(design ? design.body : null, plan.body);
						const dirty = passes.filter((p) => !p.clean);
						if (dirty.length > 0 && !params.force) {
							const summary = dirty
								.map((p) => `${p.pass}: ${p.findings.join("; ").slice(0, 100)}`)
								.join("\n");
							throw new Error(
								`passes not clean:\n${summary}\n\nfix the findings, or force:true to seed anyway (acknowledged risk)`,
							);
						}
						const result = seedPlan(
							db,
							plan,
							proj.slug,
							ctx.sessionManager.getSessionId(),
						);
						setPlanStatus(db, plan.id, "building");
						needle(
							"bb-plan",
							planBreadcrumb(
								proj.slug,
								hex6Of(plan.id),
								"plan",
								`approved → seeded ${result.count}`,
							),
							true,
						);
						return {
							content: [
								{
									type: "text",
									text: `seeded ${result.count} tasks${result.errors.length > 0 ? ` (errors: ${result.errors.join("; ")})` : ""}`,
								},
							],
							details: { ...result },
						};
					}
					case "abandon": {
						const plan = activePlan(db, proj.id);
						if (!plan) throw new Error("no active plan");
						setPlanStatus(db, plan.id, "abandoned");
						needle(
							"bb-plan",
							planBreadcrumb(proj.slug, hex6Of(plan.id), "plan", "abandoned"),
							false,
						);
						return {
							content: [{ type: "text", text: "plan abandoned" }],
							details: {},
						};
					}
				}
			} finally {
				db.close();
			}
			if (ctx.hasUI) refreshStrip(ctx);
		},
	});

	// --- /design and /plan commands ------------------------------------------------------
	pi.registerCommand("design", {
		description: "Open design doc view / status",
		handler: async (_args, ctx) => {
			const dir = agentDir();
			const proj = projectFor(ctx.cwd);
			if (dir === "" || !proj) return;
			const db = openDb(dir);
			try {
				const open = findOpenDesign(db, proj.id);
				if (!open) {
					ctx.ui.notify(
						"no open design — bb_design draft <title> or shift+tab",
						"info",
					);
					return;
				}
				const report = checkCompleteness(open.body);
				const head = `◈ ${open.title} (${open.id}) — ${open.status}`;
				const gate =
					report.unanswered.length === 0
						? "all sections answered — bb_design decide"
						: `unanswered: ${report.unanswered.join(", ")}`;
				ctx.ui.notify(`${head}\n${open.path}\n${gate}`, "info");
			} finally {
				db.close();
			}
		},
	});

	pi.registerCommand("plan", {
		description: "Plan status / passes",
		handler: async (_args, ctx) => {
			const dir = agentDir();
			const proj = projectFor(ctx.cwd);
			if (dir === "" || !proj) return;
			const db = openDb(dir);
			try {
				ingestDesignDocs(db, proj.root, proj.id);
				const design = findOpenDesign(db, proj.id);
				const plan = activePlan(db, proj.id);
				if (!plan) {
					ctx.ui.notify("no active plan — bb_plan draft or shift+tab", "info");
					return;
				}
				const passes = runAllPasses(design ? design.body : null, plan.body);
				const prog = planProgress(db, plan);
				ctx.ui.notify(
					`⬡ plan ${hex6Of(plan.id)} — ${plan.status} rev ${plan.rev}\nprogress ${prog.done}/${prog.total}\n${passes.map((p) => `${p.pass} ${p.clean ? "✓" : "✗"}`).join(" ")}`,
					"info",
				);
			} finally {
				db.close();
			}
		},
	});

	// --- shutdown: mode resets to normal only if no building plan ------------------------
	pi.on("session_shutdown", () => {
		// modes persist across sessions (project-wide state); nothing to tear down here
	});
}
