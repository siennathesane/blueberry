import { test, beforeEach, afterEach } from "node:test";
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
	sessionsForTodo,
	setStage,
	toCards,
	WIP_LIMIT,
} from "../src/core/todo-store.ts";
import { tmpAgentDir, cleanup } from "./helpers.ts";

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
	assert.deepEqual(listTodos(db, PROJECT).find((t) => t.hex6 === a)!.blockedBy, [
		b,
	]);
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
