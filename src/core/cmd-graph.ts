/**
 * Command graph — parallel bash execution with dependencies (design 003).
 *
 * Nodes are bash commands (command string, cwd, env), edges are dependencies.
 * A runner executes the ready set with bounded parallelism, records output
 * and exit codes per node, and state lands in blueberry.db (cmd_* tables).
 *
 * NOT the todo DAG, NOT planning: a first-class substrate for running
 * long/big jobs in parallel and chaining them into temporary scripts.
 * Named templates (parameterized stored graphs) replace hook managers —
 * the trigger is judgment, not events. Args arrive as BB_ARG_<NAME> env.
 *
 * Output TTL: output rows carry a generation; compaction bumps it; purge
 * drops rows older than CMD_OUTPUT_GENERATIONS (3) with a wall-clock floor
 * of CMD_OUTPUT_FLOOR_H (168h — one week) for sessionless/detached runs.
 * Purge runs reaper-style: at compaction and on every invocation.
 */
import { spawn } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export const CMD_OUTPUT_GENERATIONS = 3;
export const CMD_OUTPUT_FLOOR_H = 168;
export const CMD_MAX_PARALLEL = 4;
export const CMD_OUTPUT_BYTE_CAP = 512 * 1024;

// --- store ---------------------------------------------------------------------------

export interface NewNode {
	name: string;
	command: string;
	cwd?: string;
	env?: Record<string, string>;
}

export interface GraphRow {
	id: string;
	project_id: string | null;
	name: string | null;
	origin: string;
	status: string;
	created_at: string;
	updated_at: string;
}

export interface NodeRow {
	id: string;
	graph_id: string;
	name: string;
	command: string;
	cwd: string | null;
	env: string | null;
	status: string;
	pid: number | null;
	started_at: string | null;
	ended_at: string | null;
	exit_code: number | null;
}

export function createGraph(
	db: DatabaseSync,
	projectId: string | null,
	nodes: NewNode[],
	edges: Array<{ node: string; dep: string }>,
	name?: string,
	origin = "adhoc",
): string {
	const id = randomUUID();
	const now = new Date().toISOString();
	const tx = db.prepare("BEGIN");
	tx.run();
	try {
		db
			.prepare(
				"INSERT INTO cmd_graphs (id, project_id, name, origin, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'defined', ?, ?)",
			)
			.run(id, projectId, name ?? null, origin, now, now);
		const insertNode = db.prepare(
			"INSERT INTO cmd_nodes (id, graph_id, name, command, cwd, env) VALUES (?, ?, ?, ?, ?, ?)",
		);
		const nameToId = new Map<string, string>();
		for (const n of nodes) {
			const nid = randomUUID();
			nameToId.set(n.name, nid);
			insertNode.run(
				nid,
				id,
				n.name,
				n.command,
				n.cwd ?? null,
				n.env ? JSON.stringify(n.env) : null,
			);
		}
		const insertEdge = db.prepare(
			"INSERT INTO cmd_edges (node_id, dep_id) VALUES (?, ?)",
		);
		for (const e of edges) {
			const node = nameToId.get(e.node);
			const dep = nameToId.get(e.dep);
			if (!node || !dep) {
				throw new Error(`edge references unknown node: ${e.node} / ${e.dep}`);
			}
			insertEdge.run(node, dep);
		}
		db.prepare("COMMIT").run();
	} catch (err) {
		db.prepare("ROLLBACK").run();
		throw err;
	}
	return id;
}

export function listGraphs(
	db: DatabaseSync,
	projectId: string | null,
): GraphRow[] {
	return (projectId === null
		? db.prepare("SELECT * FROM cmd_graphs ORDER BY created_at DESC").all()
		: db
				.prepare(
					"SELECT * FROM cmd_graphs WHERE project_id = ? ORDER BY created_at DESC",
				)
				.all(projectId)) as unknown as GraphRow[];
}

export function getGraph(db: DatabaseSync, id: string): GraphRow | undefined {
	return db.prepare("SELECT * FROM cmd_graphs WHERE id = ?").get(id) as
		| GraphRow
		| undefined;
}

export function graphNodes(db: DatabaseSync, graphId: string): NodeRow[] {
	return db
		.prepare("SELECT * FROM cmd_nodes WHERE graph_id = ? ORDER BY name")
		.all(graphId) as unknown as NodeRow[];
}

function nodeDeps(db: DatabaseSync, graphId: string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const r of db
		.prepare(
			"SELECT e.node_id, e.dep_id FROM cmd_edges e JOIN cmd_nodes n ON n.id = e.node_id WHERE n.graph_id = ?",
		)
		.all(graphId) as Array<{ node_id: string; dep_id: string }>) {
		const list = out.get(r.node_id) ?? [];
		list.push(r.dep_id);
		out.set(r.node_id, list);
	}
	return out;
}

// --- templates ------------------------------------------------------------------------

export interface TemplateDef {
	params: string[];
	nodes: NewNode[];
	edges: Array<{ node: string; dep: string }>;
}

export function saveTemplate(
	db: DatabaseSync,
	name: string,
	def: TemplateDef,
): void {
	const now = new Date().toISOString();
	db
		.prepare(
			"INSERT INTO cmd_templates (name, params, nodes, edges, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET params = excluded.params, nodes = excluded.nodes, edges = excluded.edges, updated_at = excluded.updated_at",
		)
		.run(
			name,
			JSON.stringify(def.params),
			JSON.stringify(def.nodes),
			JSON.stringify(def.edges),
			now,
			now,
		);
}

export function getTemplate(
	db: DatabaseSync,
	name: string,
): (TemplateDef & { updated_at: string }) | undefined {
	const row = db
		.prepare("SELECT * FROM cmd_templates WHERE name = ?")
		.get(name) as
		| { params: string; nodes: string; edges: string; updated_at: string }
		| undefined;
	if (!row) return undefined;
	// corrupt stored JSON (template tampered/truncated) degrades to a
	// harmless empty template rather than crashing every cmd invocation
	const safe = (text: string, fallback: unknown): unknown => {
		try {
			return JSON.parse(text);
		} catch {
			return fallback;
		}
	};
	return {
		params: safe(row.params, []) as string[],
		nodes: safe(row.nodes, []) as NewNode[],
		edges: safe(row.edges, []) as Array<{ node: string; dep: string }>,
		updated_at: row.updated_at,
	};
}

export function runTemplate(
	db: DatabaseSync,
	name: string,
	args: Record<string, string>,
	projectId: string | null,
): string {
	const tpl = getTemplate(db, name);
	if (!tpl) throw new Error(`no template named '${name}'`);
	for (const p of tpl.params) {
		if (args[p] === undefined)
			throw new Error(`template '${name}' missing arg: ${p}`);
	}
	// args become BB_ARG_<NAME> env on every node — zero templating syntax
	const argEnv: Record<string, string> = {};
	for (const [k, v] of Object.entries(args)) {
		argEnv[`BB_ARG_${k.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`] = v;
	}
	const nodes = tpl.nodes.map((n) => ({
		...n,
		env: { ...argEnv, ...(n.env ?? {}) },
	}));
	return createGraph(db, projectId, nodes, tpl.edges, name, "template");
}

// --- output ---------------------------------------------------------------------------

export function currentGeneration(db: DatabaseSync): number {
	const row = db
		.prepare("SELECT value FROM meta WHERE key = 'cmd_output_generation'")
		.get() as { value: string } | undefined;
	return row ? Number(row.value) : 0;
}

/** Compaction hook: bump the generation and purge old output (R7). */
export function bumpGeneration(db: DatabaseSync): number {
	const next = currentGeneration(db) + 1;
	db
		.prepare(
			"INSERT INTO meta (key, value) VALUES ('cmd_output_generation', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
		.run(String(next));
	purgeOutput(db);
	return next;
}

export function appendOutput(
	db: DatabaseSync,
	nodeId: string,
	stream: "out" | "err",
	text: string,
): void {
	const seq = (
		db
			.prepare(
				"SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM cmd_output WHERE node_id = ?",
			)
			.get(nodeId) as { next: number }
	).next;
	db
		.prepare(
			"INSERT INTO cmd_output (node_id, seq, stream, text, ts, generation) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.run(
			nodeId,
			seq,
			stream,
			text,
			new Date().toISOString(),
			currentGeneration(db),
		);
}

export function nodeOutput(
	db: DatabaseSync,
	nodeId: string,
	tail = 40,
): Array<{ stream: string; text: string }> {
	return db
		.prepare(
			"SELECT stream, text FROM cmd_output WHERE node_id = ? ORDER BY seq DESC LIMIT ?",
		)
		.all(nodeId, tail)
		.reverse() as Array<{ stream: string; text: string }>;
}

/**
 * Purge output older than N generations, honoring the wall-clock floor.
 *
 * Two independent rules (user spec R7):
 *   1. FLOOR: rows younger than CMD_OUTPUT_FLOOR_H always survive
 *      generation expiry — a week-old guarantee for detached/sessionless
 *      runs. Rows OLDER than the floor are deleted regardless of
 *      generation (they've had their week).
 *   2. GENERATION: among floor-expired rows, keep the most recent
 *      CMD_OUTPUT_GENERATIONS generations.
 *
 * Off-by-one contract (test-pinned): a row from generation G survives
 * while currentGeneration - G < N; at exactly N it purges... no — the
 * test pins SURVIVES at distance 3, purges at 4, so the guard is
 * `generation > gen - N - 1` retained, i.e. delete when
 * `gen - generation > N`. With N=3: distance 3 survives, 4 purges.
 */
export function purgeOutput(db: DatabaseSync): number {
	const gen = currentGeneration(db);
	const floorTs = new Date(
		Date.now() - CMD_OUTPUT_FLOOR_H * 3600_000,
	).toISOString();
	// rows past the floor: subject to the generation rule
	// older generations have SMALLER numbers: a row expires when it is
	// more than N generations behind (gen - row_gen > N ⇒ row_gen < gen - N)
	const expired = db
		.prepare("DELETE FROM cmd_output WHERE ts < ? AND generation < ?")
		.run(floorTs, gen - CMD_OUTPUT_GENERATIONS);
	return Number(expired.changes);
}

// --- runner ---------------------------------------------------------------------------

export type RunEvents = {
	onNodeStart?: (node: NodeRow) => void;
	onNodeEnd?: (node: NodeRow, code: number | null) => void;
};

/** Compute the ready set: pending nodes whose deps are all done. */
export function readySet(db: DatabaseSync, graphId: string): NodeRow[] {
	const nodes = graphNodes(db, graphId);
	const deps = nodeDeps(db, graphId);
	const done = new Set(nodes.filter((n) => n.status === "ok").map((n) => n.id));
	return nodes.filter(
		(n) =>
			n.status === "pending" && (deps.get(n.id) ?? []).every((d) => done.has(d)),
	);
}

/** Failed node → its downstream stays blocked (never starts). */
export function blockedByFailure(db: DatabaseSync, graphId: string): number {
	const nodes = graphNodes(db, graphId);
	const deps = nodeDeps(db, graphId);
	const bad = new Set(
		nodes.filter((n) => n.status === "failed").map((n) => n.id),
	);
	let count = 0;
	for (const n of nodes) {
		if (n.status !== "pending") continue;
		const stack = [...(deps.get(n.id) ?? [])];
		while (stack.length > 0) {
			const d = stack.pop()!;
			if (bad.has(d)) {
				count++;
				break;
			}
			const dn = nodes.find((x) => x.id === d);
			if (dn) stack.push(...(deps.get(dn.id) ?? []));
		}
	}
	return count;
}

/** Run one node's command to completion, streaming output to the DB. */
export function runNode(
	db: DatabaseSync,
	node: NodeRow,
	events?: RunEvents,
): Promise<number | null> {
	return new Promise((resolve) => {
		// corrupt env JSON degrades to an empty env — the command still runs
		let env: Record<string, string> = {};
		if (node.env) {
			try {
				env = JSON.parse(node.env) as Record<string, string>;
			} catch {
				env = {};
			}
		}
		const child = spawn(node.command, {
			shell: true,
			cwd: node.cwd ?? undefined,
			env: { ...env },
		});
		db
			.prepare(
				"UPDATE cmd_nodes SET status = 'running', pid = ?, started_at = ? WHERE id = ?",
			)
			.run(child.pid ?? null, new Date().toISOString(), node.id);
		events?.onNodeStart?.(node);

		let written = 0;
		const cap = (chunk: Buffer | string, stream: "out" | "err") => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			written += text.length;
			if (written > CMD_OUTPUT_BYTE_CAP) {
				appendOutput(db, node.id, stream, "[output capped at 512KB]");
				return;
			}
			appendOutput(db, node.id, stream, text);
		};
		child.stdout?.on("data", (c: Buffer | string) => cap(c, "out"));
		child.stderr?.on("data", (c: Buffer | string) => cap(c, "err"));

		child.on("error", (err) => {
			appendOutput(db, node.id, "err", `[spawn error] ${err.message}`);
			finish(null);
		});
		const finish = (code: number | null) => {
			db
				.prepare(
					"UPDATE cmd_nodes SET status = ?, ended_at = ?, exit_code = ? WHERE id = ?",
				)
				.run(code === 0 ? "ok" : "failed", new Date().toISOString(), code, node.id);
			events?.onNodeEnd?.(node, code);
			resolve(code);
		};
		child.on("close", finish);
	});
}

/**
 * Execute a graph to completion: walk the ready set with bounded
 * parallelism until nothing is runnable. Sets graph status.
 */
export async function runGraph(
	db: DatabaseSync,
	graphId: string,
	events?: RunEvents,
): Promise<void> {
	db
		.prepare(
			"UPDATE cmd_graphs SET status = 'running', updated_at = ? WHERE id = ?",
		)
		.run(new Date().toISOString(), graphId);
	const inflight = new Set<Promise<unknown>>();
	for (;;) {
		// drain finished promises to check for failures
		const ready = readySet(db, graphId);
		if (ready.length === 0 && inflight.size === 0) break;
		for (const node of ready) {
			if (inflight.size >= CMD_MAX_PARALLEL) break;
			const p = runNode(db, node, events).finally(() => {
				void 0;
			});
			inflight.add(p);
			void p.then(() => {
				inflight.delete(p);
			});
		}
		if (ready.length === 0 && inflight.size > 0) {
			await Promise.race(inflight);
		} else if (inflight.size > 0) {
			await Promise.race(inflight);
		}
	}
	const nodes = graphNodes(db, graphId);
	const failed = nodes.some((n) => n.status === "failed");
	const blocked = blockedByFailure(db, graphId);
	const status = failed ? "failed" : "done";
	db
		.prepare("UPDATE cmd_graphs SET status = ?, updated_at = ? WHERE id = ?")
		.run(status, new Date().toISOString(), graphId);
	void blocked;
}
