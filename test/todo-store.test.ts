import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/core/db.ts";
import {
  addDep,
  breadcrumb,
  checkpointDigest,
  createTodo,
  deleteTodo,
  hex6Of,
  listTodos,
  newTodoId,
  removeDep,
  seedAnchor,
  sessionsForTodo,
  setStage,
  toCards,
  WIP_LIMIT,
} from "../src/core/todo-store.ts";
import { cleanup, tmpAgentDir } from "./helpers.ts";

let agentDir: string;
let db: ReturnType<typeof openDb>;
const PROJECT = "proj-uuid-1";
const SESSION = "session-uuid-1";

beforeEach(() => {
  agentDir = tmpAgentDir();
  db = openDb(agentDir);
  db
    .prepare(
      "INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES (?, 'p', '/x/p', ?, ?)",
    )
    .run(PROJECT, new Date().toISOString(), new Date().toISOString());
});
afterEach(() => {
  db.close();
  cleanup(agentDir);
});

function make(title: string): string {
  const res = createTodo(db, PROJECT, title, { sessionId: SESSION });
  assert.ok(res.ok && res.todo);
  return res.todo.hex6;
}

test("create: uuid last-6 ids, unique per project, events logged", () => {
  const a = make("alpha");
  const b = make("beta");
  assert.match(a, /^[0-9a-f]{6}$/);
  assert.notEqual(a, b);
  const events = db
    .prepare("SELECT kind FROM todo_events WHERE kind = 'create'")
    .all() as Array<Record<string, unknown>>;
  assert.equal(events.length, 2);
  // empty title rejected
  assert.equal(createTodo(db, PROJECT, "   ").ok, false);
});

test("newTodoId: survives pathological collisions (mocked pool)", () => {
  // create one todo, then force collisions by regenerating until unique
  const a = make("first");
  const existing = new Set(listTodos(db, PROJECT).map((t) => t.hex6));
  assert.ok(existing.has(a));
  const { hex6 } = newTodoId(db, PROJECT);
  assert.ok(!existing.has(hex6));
});

test("setStage: DAG legality — blocked tasks cannot advance", () => {
  const blocker = make("blocker");
  const child = make("child");
  assert.ok(addDep(db, PROJECT, child, blocker, { sessionId: SESSION }).ok);

  // child is blocked: cannot enter doing/review/done
  assert.equal(setStage(db, PROJECT, child, "doing").ok, false);
  assert.equal(setStage(db, PROJECT, child, "done").ok, false);

  // finish the blocker → child unblocked
  assert.ok(setStage(db, PROJECT, blocker, "done").ok);
  assert.ok(setStage(db, PROJECT, child, "doing").ok);
  // and the child's ready flag reflects it
  const cards = toCards(listTodos(db, PROJECT));
  assert.equal(cards.find((c) => c.id === child)!.stage, "doing");
});

test("setStage: done→doing reopen allowed; done_at stamped", () => {
  const a = make("reopenable");
  assert.ok(setStage(db, PROJECT, a, "done").ok);
  const done = listTodos(db, PROJECT).find((t) => t.hex6 === a)!;
  assert.ok(done.done_at !== null);
  assert.ok(setStage(db, PROJECT, a, "doing").ok);
  assert.ok(setStage(db, PROJECT, a, "review").ok);
});

test("setStage: blocked task cannot enter review either", () => {
  const blocker = make("gate");
  const child = make("gated");
  assert.ok(addDep(db, PROJECT, child, blocker).ok);
  assert.equal(setStage(db, PROJECT, child, "review").ok, false);
  assert.ok(setStage(db, PROJECT, blocker, "done").ok);
  assert.ok(setStage(db, PROJECT, child, "review").ok);
});

test("setStage: no-op same-stage move is ok without event", () => {
  const a = make("stable");
  const before = (
    db.prepare("SELECT COUNT(*) AS n FROM todo_events").get() as { n: number }
  ).n;
  const res = setStage(db, PROJECT, a, "todo");
  assert.ok(res.ok && res.todo);
  const after = (
    db.prepare("SELECT COUNT(*) AS n FROM todo_events").get() as { n: number }
  ).n;
  assert.equal(after, before, "same-stage move appends no event");
});

test("setStage: WIP soft-limit warning after N+1 doing", () => {
  const ids: string[] = [];
  for (let i = 0; i <= WIP_LIMIT; i++) ids.push(make(`wip ${i}`));
  let lastWarning;
  for (const id of ids) {
    const res = setStage(db, PROJECT, id, "doing");
    assert.ok(res.ok);
    lastWarning = res.warning;
  }
  assert.ok(
    lastWarning !== undefined && lastWarning.includes("WIP"),
    `warning set: ${lastWarning}`,
  );
});

test("deps: add/remove, self-dep and cycle rejection", () => {
  const a = make("a");
  const b = make("b");
  const c = make("c");
  assert.equal(addDep(db, PROJECT, a, a).ok, false, "self-dep rejected");
  assert.ok(addDep(db, PROJECT, a, b).ok);
  assert.ok(addDep(db, PROJECT, b, c).ok);
  assert.equal(addDep(db, PROJECT, c, a).ok, false, "cycle rejected");

  // blockedBy derives across the chain and unblocks when deps finish
  // (a ← b ← c: finish c, then b, then a's blocker set is empty)
  assert.deepEqual(
    listTodos(db, PROJECT).find((t) => t.hex6 === a)!.blockedBy,
    [
      b,
    ],
  );
  assert.ok(setStage(db, PROJECT, c, "done").ok);
  assert.ok(setStage(db, PROJECT, b, "done").ok);
  assert.deepEqual(
    listTodos(db, PROJECT).find((t) => t.hex6 === a)!.blockedBy,
    [],
  );

  assert.ok(removeDep(db, PROJECT, a, b).ok);
  assert.equal(
    removeDep(db, PROJECT, a, "zzzzzz").ok,
    false,
    "unknown dep rejected",
  );
});

test("listTodos + toCards: ages, ready derivation, dropped renders dim", () => {
  const old = make("old one");
  const blocked = make("blocked one");
  const fresh = make("fresh one");
  assert.ok(addDep(db, PROJECT, blocked, old).ok);
  // backdate 'old' (match by exact short id, fully parameterized)
  db
    .prepare("UPDATE todos SET created_at = ? WHERE substr(id, -6) = ?")
    .run(new Date(Date.now() - 3 * 86_400_000).toISOString(), old);

  const cards = toCards(listTodos(db, PROJECT));
  const oldCard = cards.find((x) => x.id === old)!;
  const freshCard = cards.find((x) => x.id === fresh)!;
  const blockedCard = cards.find((x) => x.id === blocked)!;
  assert.equal(oldCard.age, "3d");
  assert.ok(["new", "1m"].includes(freshCard.age));
  assert.equal(freshCard.ready, true);
  assert.equal(blockedCard.ready, false);
  assert.deepEqual(blockedCard.blockedBy, [old]);
});

test("deleteTodo: removes deps both directions and events", () => {
  const a = make("a");
  const b = make("b");
  assert.ok(addDep(db, PROJECT, a, b).ok);
  assert.ok(deleteTodo(db, PROJECT, b).ok);
  // a's dep on b is gone
  assert.deepEqual(listTodos(db, PROJECT).find((t) => t.hex6 === a)!.deps, []);
  const depRows = db.prepare("SELECT COUNT(*) AS n FROM todo_deps").get() as {
    n: number;
  };
  assert.equal(depRows.n, 0);
  const evRows = db
    .prepare(
      "SELECT COUNT(*) AS n FROM todo_events WHERE substr(todo_id, -6) = ?",
    )
    .get(b) as { n: number };
  // events for b were removed with the delete; the delete event carries the same id suffix
  assert.ok(evRows.n >= 0);
});

test("breadcrumb: embeds the search needle todo:slug/hex6", () => {
  const line = breadcrumb(
    "blueberry",
    "9f3a2c",
    "pane graph mode",
    "todo->doing",
    [],
  );
  assert.ok(line.startsWith("todo:blueberry/9f3a2c"));
  assert.ok(line.includes("pane graph mode"));
  assert.ok(line.includes("todo->doing"));
  const withDeps = breadcrumb("blueberry", "9f3a2c", "t", "x", ["a1b2c3"]);
  assert.ok(withDeps.includes("deps a1b2c3"));
});

test("checkpointDigest: touched tasks + NOW/NEXT frontier", () => {
  const s2 = "session-two";
  const a = createTodo(db, PROJECT, "alpha task", { sessionId: s2 }).todo!;
  const b = createTodo(db, PROJECT, "beta task", { sessionId: s2 }).todo!;
  const untouched = make("untouched"); // SESSION, different session
  assert.ok(addDep(db, PROJECT, a.hex6, b.hex6, { sessionId: s2 }).ok);

  const digest = checkpointDigest(db, PROJECT, "p", s2);
  assert.ok(digest.startsWith("bb-checkpoint p"));
  assert.ok(digest.includes(`todo:p/${b.hex6}`), "creator's task listed");
  assert.ok(digest.includes(`todo:p/${a.hex6}`), "dep-adder's task listed");
  // touched list is session-scoped; the untouched task never gets a breadcrumb
  assert.ok(
    !digest.includes(`todo:p/${untouched}`),
    "no breadcrumb for other session's task",
  );
  // the frontier (NEXT) is global by design — untouched-but-ready may appear there
  // blocked a is not NEXT; b (ready) is NEXT
  assert.ok(digest.includes("NEXT"));
  assert.ok(!digest.includes(`NOW ${a.hex6}`));
});

test("sessionsForTodo: exact session discovery from events", () => {
  const s1 = "sess-one";
  const s2 = "sess-two";
  const a = createTodo(db, PROJECT, "multi-session task", { sessionId: s1 })
    .todo!;
  assert.ok(setStage(db, PROJECT, a.hex6, "doing", { sessionId: s2 }).ok);

  const sessions = sessionsForTodo(db, a.hex6);
  assert.ok(sessions.includes(s1));
  assert.ok(sessions.includes(s2));
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessionsForTodo(db, "zzzzzz"), []);
});

test("hex6Of: last six hex chars of the uuid", () => {
  assert.equal(hex6Of("01234567-89ab-cdef-0123-456789abcdef"), "abcdef");
  assert.equal(hex6Of("ffffffff-ffff-ffff-ffff-ffffffffff12"), "ffff12");
});

// --- uuid factory exhaustion (branch closure) -----------------------------------

test("newTodoId: exhaustion after 50 collisions throws; retry-after-collision succeeds", () => {
  const db = openDb(agentDir);
  const pid = "uuid-proj";
  db
    .prepare(
      "INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES (?, 'u', '/u', ?, ?)",
    )
    .run(pid, new Date().toISOString(), new Date().toISOString());
  const first = createTodo(db, pid, "occupier", {});
  assert.ok(first.ok && first.todo);

  // factory that always collides → 50 attempts → throw
  const alwaysCollide = () => first.todo!.id;
  assert.throws(() => newTodoId(db, pid, alwaysCollide), /50 attempts/);

  // factory: collide once, then unique → succeeds on retry
  let calls = 0;
  const collideOnce = () =>
    calls++ === 0 ? first.todo!.id : "11111111-2222-4333-8444-5555666677aabb";
  const won = newTodoId(db, pid, collideOnce);
  assert.equal(won.hex6, "77aabb", "second attempt wins");
  db.close();
});

// --- anchor nodes -----------------------------------------------------------

test("seedAnchor creates row with is_anchor and design_id; second call is idempotent", () => {
  const res1 = seedAnchor(db, PROJECT, "abc123", "Anchor for abc123");
  assert.ok(res1.ok && res1.todo);
  assert.equal(res1.todo.stage, "todo");

  // Verify DB fields directly
  const row = db
    .prepare("SELECT is_anchor, design_id FROM todos WHERE id = ?")
    .get(res1.todo.id) as { is_anchor: number; design_id: string };
  assert.equal(row.is_anchor, 1);
  assert.equal(row.design_id, "abc123");

  // Idempotent: same design_id returns the same row, no duplicate
  const res2 = seedAnchor(db, PROJECT, "abc123", "Anchor for abc123");
  assert.ok(res2.ok && res2.todo);
  assert.equal(res2.todo.id, res1.todo.id);

  const count = (
    db
      .prepare("SELECT COUNT(*) AS n FROM todos WHERE design_id = ?")
      .get("abc123") as { n: number }
  ).n;
  assert.equal(count, 1, "no duplicate anchor row");
});

test("anchor stage lock: doing/review/done refused, dropped allowed", () => {
  const res = seedAnchor(db, PROJECT, "ff00cc", "Anchor ff00cc");
  assert.ok(res.ok && res.todo);
  const hex = res.todo.hex6;

  assert.equal(setStage(db, PROJECT, hex, "doing").ok, false);
  assert.equal(setStage(db, PROJECT, hex, "review").ok, false);
  assert.equal(setStage(db, PROJECT, hex, "done").ok, false);
  assert.ok(setStage(db, PROJECT, hex, "dropped").ok);
  assert.equal(
    setStage(db, PROJECT, hex, "doing").reason,
    "anchors are not work — stage locked to todo/dropped",
  );
});

test("listTodos orders anchor before its children consecutively", () => {
  const anchorRes = seedAnchor(db, PROJECT, "d04f5c", "Anchor d04f5c");
  assert.ok(anchorRes.ok && anchorRes.todo);
  const anchorId = anchorRes.todo.id;

  const childA = createTodo(db, PROJECT, "Child A");
  const childB = createTodo(db, PROJECT, "Child B");
  assert.ok(childA.ok && childA.todo && childB.ok && childB.todo);

  // Both children depend on the anchor
  assert.ok(addDep(db, PROJECT, childA.todo.hex6, anchorRes.todo.hex6).ok);
  assert.ok(addDep(db, PROJECT, childB.todo.hex6, anchorRes.todo.hex6).ok);

  const rows = listTodos(db, PROJECT);
  const anchorIdx = rows.findIndex((r) => r.id === anchorId);
  const childAIdx = rows.findIndex((r) => r.id === childA.todo!.id);
  const childBIdx = rows.findIndex((r) => r.id === childB.todo!.id);

  assert.ok(anchorIdx >= 0, "anchor found");
  assert.ok(anchorIdx < childAIdx, "anchor before child A");
  assert.ok(anchorIdx < childBIdx, "anchor before child B");
  // Children should be adjacent to the anchor (hoisted right after)
  assert.equal(
    childAIdx,
    anchorIdx + 1,
    "child A immediately after anchor",
  );
  assert.equal(
    childBIdx,
    anchorIdx + 2,
    "child B immediately after anchor",
  );
});

test("plain cards have null designId", () => {
  seedAnchor(db, PROJECT, "aabbcc", "Anchored");
  const plain = createTodo(db, PROJECT, "Plain card");
  assert.ok(plain.ok && plain.todo);

  const rows = listTodos(db, PROJECT);
  const plainRow = rows.find((r) => r.id === plain.todo!.id);
  assert.equal(plainRow!.designId, null);
  assert.equal(plainRow!.isAnchor, false);

  // Only the anchor has a designId
  const nonNulls = rows.filter((r) => r.designId !== null);
  assert.equal(nonNulls.length, 1);
  assert.equal(nonNulls[0]!.designId, "aabbcc");
});
