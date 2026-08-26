/**
 * The todo DAG store on blueberry.db (§Todo + §Data).
 *
 * DAG is truth: stage is stored, ready/blocked is always derived from
 * deps ∪ done. All mutations append to todo_events (the dreaming substrate).
 * Breadcrumbs embed the internal id `todo:<slug>/<hex6>` so §Library search
 * finds every session that touched a task.
 */
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { TodoCard } from "./todo-pane.ts";

export const STAGES = ["todo", "doing", "review", "done", "dropped"] as const;
export type FullStage = (typeof STAGES)[number];

export const WIP_LIMIT = 5; // soft: exceeded → warning in result, move still allowed

export interface TodoRow {
  id: string; // full uuid
  hex6: string; // display/address id
  project_id: string;
  title: string;
  track: string | null;
  stage: FullStage;
  created_at: string;
  updated_at: string;
  done_at: string | null;
}

/** Derive the short id from a full uuid (last 6 hex). */
export function hex6Of(id: string): string {
  return id.replace(/-/g, "").slice(-6);
}

/** Generate a collision-free task id for a project (uuid, last-6 address). */
export function newTodoId(
  db: DatabaseSync,
  projectId: string,
  uuidFactory: () => string = randomUUID,
): { id: string; hex6: string } {
  const existing = new Set(
    (
      db
        .prepare("SELECT id FROM todos WHERE project_id = ?")
        .all(projectId) as Array<Record<string, unknown>>
    ).map((r) => hex6Of(String(r["id"]))),
  );
  for (let i = 0; i < 50; i++) {
    const id = uuidFactory();
    const hex6 = hex6Of(id);
    if (!existing.has(hex6)) return { id, hex6 };
  }
  throw new Error("could not allocate todo id (50 attempts)");
}

function rowToTodo(row: Record<string, unknown>): TodoRow {
  return {
    id: String(row["id"]),
    hex6: hex6Of(String(row["id"])),
    project_id: String(row["project_id"]),
    title: String(row["title"]),
    track: row["track"] === null ? null : String(row["track"]),
    stage: String(row["stage"]) as FullStage,
    created_at: String(row["created_at"]),
    updated_at: String(row["updated_at"]),
    done_at: row["done_at"] === null ? null : String(row["done_at"]),
  };
}

/** All todos of a project with derived dep info, mapped to pane cards. */
export function listTodos(
  db: DatabaseSync,
  projectId: string,
): Array<TodoRow & { deps: string[]; blockedBy: string[] }> {
  const rows = db
    .prepare("SELECT * FROM todos WHERE project_id = ? ORDER BY created_at")
    .all(projectId) as Array<Record<string, unknown>>;
  const depsByTodo = new Map<string, string[]>();
  for (
    const d of db
      .prepare("SELECT todo_id, dep_id FROM todo_deps")
      .all() as Array<Record<string, unknown>>
  ) {
    const tid = String(d["todo_id"]);
    const list = depsByTodo.get(tid) ?? [];
    list.push(String(d["dep_id"]));
    depsByTodo.set(tid, list);
  }
  const stageById = new Map(
    rows.map((r) => [String(r["id"]), String(r["stage"])]),
  );
  const hexById = new Map(
    rows.map((r) => [String(r["id"]), hex6Of(String(r["id"]))]),
  );

  return rows.map((r) => {
    const todo = rowToTodo(r);
    const deps = depsByTodo.get(todo.id) ?? [];
    const blockedBy = deps.filter((dep) => {
      const stage = stageById.get(dep);
      return stage !== "done" && stage !== "dropped";
    });
    return {
      ...todo,
      deps,
      blockedBy: blockedBy.map((d) => hexById.get(d) ?? hex6Of(d)),
    };
  });
}

/** Map DB rows to pane cards (ages derived from timestamps). */
export function toCards(
  rows: Array<TodoRow & { blockedBy: string[] }>,
): TodoCard[] {
  return rows.map((r) => ({
    id: r.hex6,
    title: r.title,
    stage: r.stage === "dropped" ? "done" : r.stage, // pane has 4 columns; dropped renders dim in done
    age: ageString(r.stage === "todo" ? r.created_at : r.updated_at),
    ready: r.stage === "todo" && r.blockedBy.length === 0,
    blockedBy: r.blockedBy,
  }));
}

function ageString(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "?";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "new";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export interface MutationResult {
  ok: boolean;
  reason?: string;
  warning?: string;
  todo?: TodoRow;
}

function getTodo(
  db: DatabaseSync,
  projectId: string,
  hex6: string,
): TodoRow | null {
  const rows = db
    .prepare("SELECT * FROM todos WHERE project_id = ?")
    .all(projectId) as Array<Record<string, unknown>>;
  const hit = rows.find((r) => hex6Of(String(r["id"])) === hex6);
  return hit ? rowToTodo(hit) : null;
}

function appendEvent(
  db: DatabaseSync,
  todoId: string,
  kind: string,
  sessionId: string | null,
  note: string | null,
): void {
  db
    .prepare(
      "INSERT INTO todo_events (todo_id, kind, ts, session_id, note) VALUES (?, ?, ?, ?, ?)",
    )
    .run(todoId, kind, new Date().toISOString(), sessionId, note);
}

export function createTodo(
  db: DatabaseSync,
  projectId: string,
  title: string,
  opts: { track?: string; sessionId?: string | null } = {},
): MutationResult {
  const trimmed = title.trim();
  if (trimmed === "") return { ok: false, reason: "title required" };
  const now = new Date().toISOString();
  const { id } = newTodoId(db, projectId);
  db
    .prepare(
      "INSERT INTO todos (id, project_id, title, track, stage, created_at, updated_at) VALUES (?, ?, ?, ?, 'todo', ?, ?)",
    )
    .run(id, projectId, trimmed, opts.track ?? null, now, now);
  appendEvent(db, id, "create", opts.sessionId ?? null, trimmed);
  const saved = getTodo(db, projectId, hex6Of(id));
  return saved
    ? { ok: true, todo: saved }
    : { ok: false, reason: "internal: row vanished after insert" };
}

export function setStage(
  db: DatabaseSync,
  projectId: string,
  hex6: string,
  stage: FullStage,
  opts: { sessionId?: string | null } = {},
): MutationResult {
  const todo = getTodo(db, projectId, hex6);
  if (!todo) return { ok: false, reason: `no todo '${hex6}'` };
  if (todo.stage === stage) return { ok: true, todo };

  // DAG legality
  if (stage === "doing" || stage === "review" || stage === "done") {
    const fresh = getTodo(db, projectId, hex6)!;
    const all = listTodos(db, projectId);
    const row = all.find((t) => t.id === fresh.id)!;
    if (row.blockedBy.length > 0) {
      return { ok: false, reason: `blocked by ${row.blockedBy.join(", ")}` };
    }
  }

  const now = new Date().toISOString();
  const doneAt = stage === "done" ? now : null;
  db
    .prepare(
      "UPDATE todos SET stage = ?, updated_at = ?, done_at = COALESCE(?, done_at) WHERE id = ?",
    )
    .run(stage, now, doneAt, todo.id);
  appendEvent(
    db,
    todo.id,
    `move:${todo.stage}->${stage}`,
    opts.sessionId ?? null,
    todo.title,
  );

  let warning: string | undefined;
  if (stage === "doing") {
    const doingCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM todos WHERE project_id = ? AND stage = 'doing'",
        )
        .get(projectId) as { n: number }
    ).n;
    if (doingCount > WIP_LIMIT) {
      warning = `WIP ${doingCount} > ${WIP_LIMIT} (soft limit)`;
    }
  }
  const saved = getTodo(db, projectId, hex6);
  if (!saved) {
    return { ok: false, reason: "internal: row vanished after update" };
  }
  return warning === undefined
    ? { ok: true, todo: saved }
    : { ok: true, warning, todo: saved };
}

export function addDep(
  db: DatabaseSync,
  projectId: string,
  hex6: string,
  depHex6: string,
  opts: { sessionId?: string | null } = {},
): MutationResult {
  const todo = getTodo(db, projectId, hex6);
  const dep = getTodo(db, projectId, depHex6);
  if (!todo) return { ok: false, reason: `no todo '${hex6}'` };
  if (!dep) return { ok: false, reason: `no todo '${depHex6}'` };
  if (todo.id === dep.id) {
    return { ok: false, reason: "cannot depend on itself" };
  }

  // cycle check: does dep (transitively) depend on todo?
  const all = listTodos(db, projectId);
  const depsOf = new Map(all.map((t) => [t.id, t.deps]));
  const seen = new Set<string>();
  const stack = [dep.id];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === todo.id) return { ok: false, reason: "would create a cycle" };
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(depsOf.get(cur) ?? []));
  }

  db
    .prepare("INSERT OR IGNORE INTO todo_deps (todo_id, dep_id) VALUES (?, ?)")
    .run(todo.id, dep.id);
  appendEvent(db, todo.id, "dep:add", opts.sessionId ?? null, depHex6);
  const saved = getTodo(db, projectId, hex6);
  return saved
    ? { ok: true, todo: saved }
    : { ok: false, reason: "internal: row vanished after dep add" };
}

export function removeDep(
  db: DatabaseSync,
  projectId: string,
  hex6: string,
  depHex6: string,
  opts: { sessionId?: string | null } = {},
): MutationResult {
  const todo = getTodo(db, projectId, hex6);
  const dep = getTodo(db, projectId, depHex6);
  if (!todo || !dep) return { ok: false, reason: "no such todo" };
  db
    .prepare("DELETE FROM todo_deps WHERE todo_id = ? AND dep_id = ?")
    .run(todo.id, dep.id);
  appendEvent(db, todo.id, "dep:remove", opts.sessionId ?? null, depHex6);
  const saved = getTodo(db, projectId, hex6);
  return saved
    ? { ok: true, todo: saved }
    : { ok: false, reason: "internal: row vanished after dep remove" };
}

export function deleteTodo(
  db: DatabaseSync,
  projectId: string,
  hex6: string,
  opts: { sessionId?: string | null } = {},
): MutationResult {
  const todo = getTodo(db, projectId, hex6);
  if (!todo) return { ok: false, reason: `no todo '${hex6}'` };
  db
    .prepare("DELETE FROM todo_deps WHERE todo_id = ? OR dep_id = ?")
    .run(todo.id, todo.id);
  db.prepare("DELETE FROM todo_events WHERE todo_id = ?").run(todo.id);
  db.prepare("DELETE FROM todos WHERE id = ?").run(todo.id);
  appendEvent(db, todo.id, "delete", opts.sessionId ?? null, todo.title);
  return { ok: true, todo };
}

// --- breadcrumbs + checkpoint ---------------------------------------------------

export function breadcrumb(
  slug: string,
  hex6: string,
  title: string,
  transition: string,
  deps: string[],
): string {
  const depNote = deps.length > 0 ? ` · deps ${deps.join(",")}` : "";
  return `todo:${slug}/${hex6} · ${title} · ${transition}${depNote}`;
}

export interface CheckpointTask {
  hex6: string;
  title: string;
  stage: FullStage;
}

/** Session-end digest: every task touched this session + the current frontier. */
export function checkpointDigest(
  db: DatabaseSync,
  projectId: string,
  slug: string,
  sessionId: string,
): string {
  const touched = db
    .prepare(
      `SELECT DISTINCT todo_id FROM todo_events WHERE session_id = ? ORDER BY todo_id`,
    )
    .all(sessionId) as Array<Record<string, unknown>>;
  const touchedIds = new Set(touched.map((r) => String(r["todo_id"])));
  const rows = listTodos(db, projectId);
  const mine = rows.filter((r) => touchedIds.has(r.id));

  const parts: string[] = [`bb-checkpoint ${slug}`];
  for (const t of mine) {
    parts.push(breadcrumb(slug, t.hex6, t.title, t.stage, t.blockedBy));
  }
  const doing = rows.filter((r) => r.stage === "doing");
  const ready = rows.filter(
    (r) => r.stage === "todo" && r.blockedBy.length === 0,
  );
  if (doing.length > 0) parts.push(`NOW ${doing.map((d) => d.hex6).join(",")}`);
  if (ready.length > 0) {
    parts.push(`NEXT ${ready.map((r) => r.hex6).join(",")}`);
  }
  return parts.join("\n");
}

/** Sessions that touched a task (db-first discovery, §Library for context). */
export function sessionsForTodo(db: DatabaseSync, hex6: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT session_id FROM todo_events
			 WHERE session_id IS NOT NULL AND todo_id LIKE ?
			 ORDER BY session_id`,
    )
    .all(`%${hex6}`) as Array<Record<string, unknown>>;
  return rows.map((r) => String(r["session_id"]));
}

export { getTodo };
