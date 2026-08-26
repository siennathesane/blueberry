import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  formatDeeplink,
  parseDeeplink,
  osc8,
  shimAppDir,
  appleScriptShim,
  shimInfoPlist,
  desktopEntry,
  registerScheme,
  unregisterScheme,
  type RegisterOpts,
  type UnregisterOpts,
} from "../src/core/deeplink.ts";
import { openDb } from "../src/core/db.ts";
import { createTodo } from "../src/core/todo-store.ts";
import { main, defaultDeps, type CliDeps } from "../src/cli/main.ts";
import { cleanup, tmpAgentDir, tmpDir } from "./helpers.ts";

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

// --- scheme registration -------------------------------------------------------

function fakeRegisterOpts(): {
  written: Map<string, string>;
  ran: string[];
  readMap: Map<string, string>;
  chmodPaths: string[];
  opts: RegisterOpts;
} {
  const written = new Map<string, string>();
  const ran: string[] = [];
  const readMap = new Map<string, string>();
  const chmodPaths: string[] = [];
  const opts: RegisterOpts = {
    write: (path: string, content: string) => {
      written.set(path, content);
    },
    run: (cmd: string) => {
      ran.push(cmd);
    },
    read: (path: string) => readMap.get(path) ?? null,
    chmod: (path: string) => {
      chmodPaths.push(path);
    },
  };
  return { written, ran, readMap, chmodPaths, opts };
}

function fakeUnregisterOpts(): {
  removed: string[];
  ran: string[];
  opts: UnregisterOpts;
} {
  const removed: string[] = [];
  const ran: string[] = [];
  const opts: UnregisterOpts = {
    remove: (path: string) => removed.push(path),
    run: (cmd: string) => ran.push(cmd),
  };
  return { removed, ran, opts };
}

test("registerScheme macOS writes launcher, Info.plist, applescript and runs osacompile and open", () => {
  const { written, ran, opts } = fakeRegisterOpts();
  const home = "/Users/test";
  const result = registerScheme(home, "darwin", opts);
  assert.equal(result.ok, true);
  assert.ok(result.detail.includes("macOS shim"));

  const dir = shimAppDir(home);
  assert.equal(
    written.get(join(dir, "Contents", "MacOS", "Blueberry Deep Link")),
    `#!/bin/sh\nexec osascript "${join(dir, "Contents", "Resources", "main.scpt")}" "$@"\n`,
  );
  assert.equal(
    written.get(join(dir, "Contents", "Info.plist")),
    shimInfoPlist(),
  );
  assert.equal(
    written.get(join(dir, "Contents", "Resources", "main.applescript")),
    appleScriptShim(),
  );
  assert.equal(written.size, 3);

  // osacompile + open -a
  assert.equal(ran.length, 2);
  assert.ok(ran[0]!.includes("osacompile"));
  assert.ok(ran[1]!.includes("open -a"));
});

test("registerScheme macOS is idempotent: second call does not add writes", () => {
  const { written, readMap, opts } = fakeRegisterOpts();
  const home = "/Users/test";
  const dir = shimAppDir(home);
  const launcherPath = join(dir, "Contents", "MacOS", "Blueberry Deep Link");

  // First call
  const r1 = registerScheme(home, "darwin", opts);
  assert.equal(r1.ok, true);
  const sizeAfterFirst = written.size;

  // Seed the read map with the launcher content so idempotency kicks in
  readMap.set(
    launcherPath,
    written.get(launcherPath)!,
  );

  // Second call
  const r2 = registerScheme(home, "darwin", opts);
  assert.equal(r2.ok, true);
  assert.equal(written.size, sizeAfterFirst, "no new writes on second call");
});

test("unregisterScheme macOS removes the shim dir", () => {
  const { removed, opts } = fakeUnregisterOpts();
  const home = "/Users/test";
  const result = unregisterScheme(home, "darwin", opts);
  assert.equal(result.ok, true);
  assert.ok(result.detail.includes("unregistered"));
  assert.deepEqual(removed, [shimAppDir(home)]);
});

test("registerScheme linux writes the desktop entry and runs xdg-mime", () => {
  const { written, ran, opts } = fakeRegisterOpts();
  const home = "/home/test";
  const result = registerScheme(home, "linux", opts);
  assert.equal(result.ok, true);
  assert.ok(result.detail.includes("Linux"));

  const desktopPath = join(
    home,
    ".local",
    "share",
    "applications",
    "blueberry-deeplink.desktop",
  );
  assert.equal(written.get(desktopPath), desktopEntry());
  assert.equal(written.size, 1);
  assert.equal(ran.length, 1);
  assert.ok(ran[0]!.includes("xdg-mime"));
});

test("registerScheme win32 returns ok:false", () => {
  const { opts } = fakeRegisterOpts();
  const result = registerScheme("/home/test", "win32", opts);
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes("windows"));
});

test("registerScheme unknown platform returns ok:false", () => {
  const { opts } = fakeRegisterOpts();
  const result = registerScheme("/home/test", "freebsd", opts);
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes("freebsd"));
});

test("registerScheme macOS returns ok:false when osacompile fails", () => {
  const { opts } = fakeRegisterOpts();
  opts.run = () => {
    throw new Error("osacompile: command not found");
  };
  const result = registerScheme("/Users/test", "darwin", opts);
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes("osacompile"));
});

test("registerScheme linux returns ok:false when xdg-mime fails", () => {
  const { opts } = fakeRegisterOpts();
  opts.run = () => {
    throw new Error("xdg-mime: command not found");
  };
  const result = registerScheme("/home/test", "linux", opts);
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes("xdg-mime"));
});

// --- deeplink open shares code path with todo show ----------------------------

let deeplinkAgentDir: string;
let deeplinkArea: string;
let deeplinkOutLines: string[];
let deeplinkErrLines: string[];
const DL_PROJECT = "proj-dl-cli-test";

function deeplinkDeps(): CliDeps {
  return {
    ...defaultDeps(),
    agentDir: deeplinkAgentDir,
    cwd: deeplinkArea,
    out: (l: string) => void deeplinkOutLines.push(l),
    err: (l: string) => void deeplinkErrLines.push(l),
    // deno-lint-ignore require-await
    runPi: (async () => 0) as ReturnType<typeof defaultDeps>["runPi"],
  };
}

beforeEach(() => {
  deeplinkAgentDir = tmpAgentDir();
  deeplinkArea = tmpDir("bb-dlcli-");
  deeplinkOutLines = [];
  deeplinkErrLines = [];
  const db = openDb(deeplinkAgentDir);
  db
    .prepare(
      "INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      DL_PROJECT,
      DL_PROJECT,
      deeplinkArea,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  const res = createTodo(db, DL_PROJECT, "deeplink CLI test card");
  assert.ok(res.ok && res.todo);
  // store hex6 for use in tests
  (globalThis as Record<string, unknown>).__dlHex6 = res.todo.hex6;
  db.close();
});

afterEach(() => {
  cleanup(deeplinkArea, deeplinkAgentDir);
});

test("deeplink open shares output with todo show", async () => {
  const hex6 = (globalThis as Record<string, unknown>).__dlHex6 as string;
  const url = `bb://todo/${DL_PROJECT}/${hex6}`;

  const d = deeplinkDeps();
  const rc = await main(["deeplink", "open", url], d);
  assert.equal(rc, 0);
  const openOutput = [...deeplinkOutLines];

  deeplinkOutLines = [];
  const rc2 = await main(["todo", "show", DL_PROJECT, hex6], d);
  assert.equal(rc2, 0);
  const showOutput = [...deeplinkOutLines];

  assert.deepEqual(openOutput, showOutput);
});
