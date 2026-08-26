import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { formatDeeplink, parseDeeplink, osc8 } from "../src/core/deeplink.ts";
import { openDb } from "../src/core/db.ts";
import { createTodo } from "../src/core/todo-store.ts";
import { cleanup, tmpAgentDir } from "./helpers.ts";

// --- formatDeeplink / parseDeeplink round-trip ----------------------------------

test("formatDeeplink produces canonical bb://todo/slug/hex6", () => {
  const url = formatDeeplink("blueberry", "ab12cd");
  assert.equal(url, "bb://todo/blueberry/ab12cd");
});

test("parseDeeplink round-trips with formatDeeplink", () => {
  const url = formatDeeplink("blueberry", "ab12cd");
  const parsed = parseDeeplink(url);
  assert.deepEqual(parsed, { kind: "todo", slug: "blueberry", hex6: "ab12cd" });
});

// --- parseDeeplink rejection cases (all return null, never throw) -------------

test("parseDeeplink rejects wrong scheme", () => {
  assert.equal(parseDeeplink("http://todo/blueberry/ab12cd"), null);
  assert.equal(parseDeeplink("bb://x/blueberry/ab12cd"), null);
});

test("parseDeeplink rejects wrong kind", () => {
  assert.equal(parseDeeplink("bb://card/blueberry/ab12cd"), null);
  assert.equal(parseDeeplink("bb://TODO/blueberry/ab12cd"), null);
});

test("parseDeeplink rejects uppercase hex", () => {
  assert.equal(parseDeeplink("bb://todo/blueberry/AB12CD"), null);
  assert.equal(parseDeeplink("bb://todo/blueberry/Ab12cd"), null);
});

test("parseDeeplink rejects short hex", () => {
  assert.equal(parseDeeplink("bb://todo/blueberry/abc"), null);
  assert.equal(parseDeeplink("bb://todo/blueberry/abcdef01"), null);
});

test("parseDeeplink rejects extra segments", () => {
  assert.equal(parseDeeplink("bb://todo/blueberry/ab12cd/extra"), null);
  assert.equal(parseDeeplink("bb://todo/blueberry"), null);
});

test("parseDeeplink rejects garbage input", () => {
  assert.equal(parseDeeplink(""), null);
  assert.equal(parseDeeplink("not a url"), null);
  assert.equal(parseDeeplink("bb://todo/blueberry/ghijkl"), null);
  assert.equal(parseDeeplink("bb://todo/UPPER/ab12cd"), null);
});

// --- osc8 ----------------------------------------------------------------------

test("osc8 wraps text with OSC 8 hyperlink escapes", () => {
  const result = osc8("click me", "bb://todo/blueberry/ab12cd");
  const esc = "\x1b]8;;bb://todo/blueberry/ab12cd\x07click me\x1b]8;;\x07";
  assert.equal(result, esc);
});

// --- todo show behavior at the store seam --------------------------------------

let agentDir: string;
let db: ReturnType<typeof openDb>;
const PROJECT = "proj-deeplink-test";

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

test("createTodo + appendEvent: todo_events row has expected kind and ts", () => {
  const res = createTodo(db, PROJECT, "deep link test card");
  assert.ok(res.ok && res.todo);
  const todoId = res.todo.id;
  const hex6 = res.todo.hex6;

  const events = db
    .prepare(
      "SELECT kind, ts, note FROM todo_events WHERE todo_id = ? ORDER BY seq",
    )
    .all(todoId) as Array<Record<string, unknown>>;
  assert.equal(events.length, 1);
  assert.equal(events[0]!["kind"], "create");
  assert.equal(events[0]!["note"], "deep link test card");
  assert.ok(typeof events[0]!["ts"] === "string");
  assert.doesNotThrow(() => new Date(String(events[0]!["ts"])).getTime());

  // The hex6 is valid for a deep link
  const url = formatDeeplink("p", hex6);
  const parsed = parseDeeplink(url);
  assert.deepEqual(parsed, { kind: "todo", slug: "p", hex6 });
});
