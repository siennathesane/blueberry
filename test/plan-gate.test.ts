/**
 * Plan-mode USE gate tests — the toll is at message time, not the door.
 *
 * Spec (user, 2025-08-25): entering/exiting/swapping plan mode is FREE;
 * the FIRST MESSAGE in plan mode is blocked unless ≥1 pending design
 * exists for the project. Plan mode is expensive (reviews, iterations,
 * consistency passes) — never usable without a relevant design.
 *
 * These tests exercise the extension's gate logic directly with a real
 * temp DB: mode state, design presence, and the cancel decision.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/core/db.ts";
import { writeMode, readMode } from "../src/core/plan-gate.ts";
import { tmpAgentDir, tmpDir, fakeRepo, cleanup } from "./helpers.ts";

let agentDir: string;
let area: string;
let db: ReturnType<typeof openDb>;
let projectId: string;

beforeEach(() => {
	agentDir = tmpAgentDir();
	area = tmpDir("bb-plangate-");
	const root = fakeRepo(area, "gate", "git");
	// register the project in the registry exactly as the launcher would
	db = openDb(agentDir);
	const slug = "gated";
	db.prepare(
		"INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
	).run(slug, slug, root, new Date().toISOString(), new Date().toISOString());
	projectId = slug;
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
});

afterEach(() => {
	db.close();
	cleanup(area);
	delete process.env["PI_CODING_AGENT_DIR"];
});

test("gate: plan mode with NO pending design → before_agent_start cancels", async () => {
	writeMode(db, "plan");
	assert.equal(readMode(db), "plan");
	const { planGateDecision } = await import("../src/core/plan-gate.ts");
	const decision = planGateDecision(projectId, agentDir);
	assert.ok(decision?.cancel, "turn must be cancelled without a design");
	assert.match(decision.cancel.reason, /pending design/);
});

test("gate: plan mode WITH a pending design (any status) → turn proceeds", async () => {
	// scaffold a design into the project's docs/design (status: open = pending)
	const root = db
		.prepare("SELECT canonical_path FROM projects WHERE id = ?")
		.get(projectId) as { canonical_path: string };
	const dir = join(root.canonical_path, "docs", "design");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "001-gated-design.md"),
		"---\nid: abc123\nstatus: open\ntitle: Gated Design\n---\n## Problem\nx\n",
	);
	const { planGateDecision } = await import("../src/core/plan-gate.ts");
	const decision = planGateDecision(projectId, agentDir);
	assert.equal(decision, undefined, "no cancel when a design is pending");
});

test("gate: normal and design modes never cancel regardless of designs", async () => {
	const { planGateDecision } = await import("../src/core/plan-gate.ts");
	writeMode(db, "normal");
	assert.equal(planGateDecision(projectId, agentDir), undefined);
	writeMode(db, "design");
	assert.equal(planGateDecision(projectId, agentDir), undefined);
});

test("ring: mode writes round-trip freely (no entry guards at the DB layer)", () => {
	for (const mode of ["design", "plan", "normal", "plan", "design", "normal"] as const) {
		writeMode(db, mode);
		assert.equal(readMode(db), mode, `${mode} round-trips`);
	}
});
