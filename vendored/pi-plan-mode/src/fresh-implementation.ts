import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImplementationPlanRetention } from "./settings.js";
import type { PlanCompletionSource, PlanModeState } from "./state.js";

type NewSessionOptions = Exclude<Parameters<ExtensionCommandContext["newSession"]>[0], undefined>;
type ReplacementContext = Parameters<NonNullable<NewSessionOptions["withSession"]>>[0];

export interface FreshImplementationRequest {
	plan: string;
	source: PlanCompletionSource;
	retention: ImplementationPlanRetention;
	stateEntryType: string;
	isCurrent(): boolean;
}

interface FreshImplementationFromStateOptions {
	getState(): PlanModeState;
	menuIsCurrent(): boolean;
	retention: ImplementationPlanRetention;
	stateEntryType: string;
}

export type FreshImplementationResult =
	| { kind: "started" }
	| { kind: "cancelled" }
	| { kind: "partial" }
	| { kind: "rejected" }
	| { kind: "stale" };

export function formatImplementationHandoff(plan: string) {
	return `Plan mode is now disabled. Full tool access is restored. Implement this proposed plan now:\n\n${plan}`;
}

export async function startFreshImplementationFromState(
	ctx: ExtensionContext,
	options: FreshImplementationFromStateOptions,
) {
	if (!isCommandContext(ctx)) {
		ctx.ui.notify(
			"Fresh implementation requires the interactive /plan command. Reopen /plan and try again.",
			"warning",
		);
		return { kind: "rejected" } as const;
	}
	const initialState = options.getState();
	const savedPlan = initialState.enabled ? undefined : initialState.savedPlan;
	const plan = (initialState.enabled ? initialState.latestPlan : savedPlan?.plan)?.trim();
	const source = initialState.enabled ? initialState.latestPlanSource : savedPlan?.source;
	if (!plan || !source) {
		ctx.ui.notify("No completed plan is available to implement.", "warning");
		return { kind: "rejected" } as const;
	}
	const wasEnabled = initialState.enabled;
	const isCurrent = () => {
		const current = options.getState();
		return (
			options.menuIsCurrent() &&
			current.enabled === wasEnabled &&
			(wasEnabled
				? current.latestPlan === plan && current.latestPlanSource === source
				: current.savedPlan === savedPlan)
		);
	};
	return startFreshImplementationSession(ctx, {
		plan,
		source,
		retention: options.retention,
		stateEntryType: options.stateEntryType,
		isCurrent,
	});
}

export async function startFreshImplementationSession(
	ctx: ExtensionCommandContext,
	request: FreshImplementationRequest,
): Promise<FreshImplementationResult> {
	if (ctx.mode === "print" || ctx.mode === "json") {
		throw new Error("Fresh plan implementation is unavailable in print/JSON mode. Use TUI or RPC.");
	}

	await ctx.waitForIdle();
	if (!request.isCurrent()) return { kind: "stale" };
	if (!(await preflightModel(ctx, request.isCurrent))) return { kind: "rejected" };
	if (!request.isCurrent()) return { kind: "stale" };

	const activeImplementation = {
		id: randomUUID(),
		plan: request.plan,
		source: request.source,
		startedAt: Date.now(),
		retention: request.retention,
	};
	const destinationState: PlanModeState = {
		enabled: false,
		awaitingAction: false,
		activeImplementation,
	};
	const handoff = formatImplementationHandoff(request.plan);
	const parentSession = ctx.sessionManager.getSessionFile();
	let setupError: string | undefined;
	let kickoffError: string | undefined;

	if (ctx.mode === "rpc") ctx.ui.notify("Starting fresh implementation session…", "info");

	let result: Awaited<ReturnType<ExtensionCommandContext["newSession"]>>;
	try {
		result = await ctx.newSession({
			...(parentSession ? { parentSession } : {}),
			setup: async (sessionManager) => {
				try {
					sessionManager.appendCustomEntry(request.stateEntryType, destinationState);
				} catch (error: unknown) {
					setupError = safeErrorDetail(error);
				}
			},
			withSession: async (replacementCtx) => {
				if (setupError) {
					recoverSetupFailure(replacementCtx, handoff, setupError);
					return;
				}
				try {
					await replacementCtx.sendUserMessage(handoff);
					replacementCtx.ui.notify(
						"Fresh implementation session started. Only the approved plan was transferred.",
						"info",
					);
				} catch (error: unknown) {
					kickoffError = safeErrorDetail(error);
					replacementCtx.ui.notify(
						`Fresh session created, but implementation did not start: ${kickoffError}. Send a message to continue, use /plan exit to clear the active plan, or resume the parent planning session.`,
						"error",
					);
				}
			},
		});
	} catch (error: unknown) {
		safeNotify(
			ctx,
			`Unable to start a fresh implementation session: ${safeErrorDetail(error)}. The source plan remains available; retry or resume the planning session.`,
			"error",
		);
		return { kind: "rejected" };
	}

	if (result.cancelled) {
		ctx.ui.notify("Fresh implementation cancelled. The plan remains available.", "info");
		return { kind: "cancelled" };
	}
	return setupError || kickoffError ? { kind: "partial" } : { kind: "started" };
}

async function preflightModel(ctx: ExtensionCommandContext, isCurrent: () => boolean) {
	const model = ctx.model;
	if (!model) {
		ctx.ui.notify("Unable to implement the plan: no model is selected.", "warning");
		return false;
	}
	let auth: Awaited<ReturnType<ExtensionCommandContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
	try {
		auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	} catch (error: unknown) {
		if (isCurrent()) {
			ctx.ui.notify(`Unable to implement the plan: ${safeErrorDetail(error)}`, "error");
		}
		return false;
	}
	if (!isCurrent()) return false;
	if (!auth.ok) {
		ctx.ui.notify(`Unable to implement the plan: ${safeErrorDetail(auth.error)}`, "warning");
		return false;
	}
	return true;
}

function recoverSetupFailure(ctx: ReplacementContext, handoff: string, setupError: string) {
	ctx.ui.setEditorText(handoff);
	ctx.ui.notify(
		`Fresh session created, but the active plan could not be saved: ${setupError}. The implementation request is in the editor; submit it to continue or resume the parent planning session.`,
		"error",
	);
}

function safeNotify(
	ctx: ExtensionCommandContext,
	message: string,
	level: "info" | "warning" | "error",
) {
	try {
		ctx.ui.notify(message, level);
	} catch {
		// The source context can become stale if Pi fails after replacement teardown.
	}
}

function isCommandContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
	return typeof (ctx as Partial<ExtensionCommandContext>).newSession === "function";
}

function safeErrorDetail(error: unknown) {
	const detail = error instanceof Error ? error.message : String(error);
	const normalized =
		[...detail]
			.map((character) => {
				const codePoint = character.codePointAt(0) ?? 0;
				return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
			})
			.join("")
			.replace(/\s+/gu, " ")
			.trim() || "unknown error";
	const characters = [...normalized];
	return characters.length > 500 ? `${characters.slice(0, 499).join("")}…` : normalized;
}
