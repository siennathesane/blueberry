/**
 * Plan-mode helpers — the gate logic, extracted for testability.
 *
 * The extension (extensions/plan/index.ts) imports these — one source of
 * truth for the gate semantics; planGateDecision is the pure decision the extension's
 * before_agent_start handler wraps (same queries, same semantics) so tests
 * exercise the real logic without a running TUI.
 *
 * Spec (2025-08-25): ring entry/exit free in all directions; the FIRST
 * MESSAGE in plan mode requires ≥1 pending design (any status) — decided
 * stays enforced at bb_plan approve.
 */
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.ts";
import { findOpenDesign } from "./design-store.ts";

export type Mode = "normal" | "design" | "plan";
const MODE_KEY = "mode";

export function readMode(db: DatabaseSync): Mode {
	const row = db
		.prepare("SELECT json FROM config WHERE key = ?")
		.get(MODE_KEY) as { json: string } | undefined;
	if (!row) return "normal";
	let parsed: { mode?: string };
	try {
		parsed = JSON.parse(row.json) as { mode?: string };
	} catch {
		// corrupt mode row degrades to normal — a gate must never throw
		return "normal";
	}
	return parsed.mode === "design" || parsed.mode === "plan"
		? parsed.mode
		: "normal";
}

export function writeMode(db: DatabaseSync, mode: Mode): void {
	db.prepare(
		"INSERT INTO config (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json",
	).run(MODE_KEY, JSON.stringify({ mode }));
}

export interface GateCancel {
	cancel: { reason: string };
}

/**
 * The before_agent_start decision for plan mode: cancel (with steering
 * reason) when mode=plan and no pending design exists for the project;
 * undefined otherwise (turn proceeds).
 */
export function planGateDecision(
	projectId: string,
	agentDir: string,
): GateCancel | undefined {
	const db = openDb(agentDir);
	try {
		if (readMode(db) !== "plan") return undefined;
		const open = findOpenDesign(db, projectId);
		if (open) return undefined;
		return {
			cancel: {
				reason:
					"plan mode requires a pending design — scaffold one first (/design, bb_design draft), or switch modes (shift+tab)",
			},
		};
	} finally {
		db.close();
	}
}
