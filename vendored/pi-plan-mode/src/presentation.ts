import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanModeState } from "./state.js";

const STATUS_KEY = "plan-mode";
const PLAN_WIDGET_KEY = "plan-mode-plan";

export function updatePlanModeUi(
	ctx: ExtensionContext,
	state: PlanModeState,
	toolSummary: () => string,
) {
	ctx.ui.setStatus(STATUS_KEY, formatStatus(state));
	if (state.enabled && state.latestPlan) {
		ctx.ui.setWidget(PLAN_WIDGET_KEY, [
			"Proposed plan ready",
			"Use /plan to implement, save, revise, or exit Plan mode.",
		]);
	} else if (state.enabled) {
		ctx.ui.setWidget(PLAN_WIDGET_KEY, [
			"Plan mode: planning",
			toolSummary(),
			"Finish with plan_mode_complete when decision-ready.",
		]);
	} else if (state.savedPlan) {
		ctx.ui.setWidget(PLAN_WIDGET_KEY, [
			"Plan saved for later",
			"Use /plan to show, implement, or clear it.",
		]);
	} else if (state.activeImplementation) {
		ctx.ui.setWidget(PLAN_WIDGET_KEY, [
			"Implementation plan active",
			"Use /plan to show, replace, or clear it.",
		]);
	} else {
		ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
	}
}

export function clearPlanModeUi(ctx: ExtensionContext) {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
}

export function showStoredPlan(pi: ExtensionAPI, ctx: ExtensionContext, state: PlanModeState) {
	const readyPlan = state.enabled ? state.latestPlan?.trim() : undefined;
	const savedPlan = state.savedPlan?.plan.trim();
	if (savedPlan && (ctx.mode === "print" || ctx.mode === "json")) {
		throw new Error("Saved plan display is unavailable in print/JSON mode. Use TUI or RPC.");
	}
	const activePlan = state.activeImplementation?.plan.trim();
	const plan = readyPlan ?? savedPlan ?? activePlan;
	if (!plan) {
		ctx.ui.notify(
			"No completed plan is available. Use /plan finalize when planning is complete.",
			"info",
		);
		return;
	}
	const title = readyPlan
		? "Proposed Plan"
		: savedPlan
			? "Saved Plan"
			: "Active Implementation Plan";
	showPlanModePlan(pi, ctx, title, plan);
}

export function showPlanModePlan(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	title: string,
	plan: string,
) {
	try {
		pi.sendMessage(
			{
				customType: "proposed-plan",
				content: `**${title}**\n\n${plan}`,
				display: true,
			},
			{ triggerTurn: false },
		);
	} catch (error: unknown) {
		const detail = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Unable to show completed plan: ${detail}`, "error");
	}
}

export function planModeStatusText(state: PlanModeState, toolSummary: () => string) {
	if (state.enabled) {
		if (state.latestPlan) {
			return `Plan mode is active and a proposed plan is ready. ${toolSummary()}`;
		}
		return `Plan mode is active. ${toolSummary()} Explore, ask, and finish with plan_mode_complete when decision-ready.`;
	}
	if (state.savedPlan) return "A plan is saved for later.";
	if (state.activeImplementation) return "An implementation plan is active.";
	return "Plan mode is off.";
}

function formatStatus(state: PlanModeState) {
	if (state.enabled) {
		if (state.awaitingAction || state.latestPlan) return "plan ready";
		return "plan active";
	}
	if (state.savedPlan) return "plan saved";
	if (state.activeImplementation) return "plan implementing";
	return undefined;
}
