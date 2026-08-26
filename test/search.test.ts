import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRegistryDb, openDb, saveRegistrySync } from "../src/core/db.ts";
import { ingestSessionFile } from "../src/core/sync.ts";
import { loadRegistry, mutations } from "../src/core/registry.ts";
import {
  formatSessionHits,
  indexFileLines,
  indexProject,
  searchCode,
  searchSessionsWithContext,
} from "../src/core/search.ts";
import { getCentralStoreDir } from "../src/core/agent-dir.ts";
import {
  cleanup,
  fakeRepo,
  fakeSession,
  tmpAgentDir,
  tmpDir,
} from "./helpers.ts";

let agentDir: string;
let area: string;
let db: ReturnType<typeof openDb>;
let root: string;
let store: string;
let projectId: string;

beforeEach(() => {
  agentDir = tmpAgentDir();
  area = tmpDir("bb-search-");
  const r = loadRegistry(agentDir);
  root = fakeRepo(area, "srchproj", "git");
  mutations.register(r, { root });
  saveRegistrySync(agentDir, r);
  db = openDb(agentDir);
  projectId = loadRegistryDb(db).projects[0]!.id;
  store = getCentralStoreDir(agentDir, "srchproj");
  mkdirSync(store, { recursive: true });
});
afterEach(() => {
  db.close();
  cleanup(agentDir, area);
});

function ingestAll() {
  for (const f of readdirSync(store).filter((x) => x.endsWith(".jsonl"))) {
    const res = ingestSessionFile(
      db,
      join(store, f),
      (cwd) => cwd === root ? projectId : null,
    );
    if (res.status === "error") throw new Error(`ingest failed: ${res.detail}`);
  }
}

test("search with context: neighborhood 3-before/5-after, hit marked, timestamps", () => {
  // build a session with a hit in the middle of a story
  const file = `${store}/story.jsonl`;
  const ts = (n: number) => new Date(Date.UTC(2026, 0, 1, 10, n)).toISOString();
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "story-id-0001",
      timestamp: ts(0),
      cwd: root,
    }),
    JSON.stringify({
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: ts(1),
      message: { role: "user", content: "step one context", timestamp: 1 },
    }),
    JSON.stringify({
      type: "message",
      id: "e2",
      parentId: "e1",
      timestamp: ts(2),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "step two context" }],
        timestamp: 2,
      },
    }),
    JSON.stringify({
      type: "message",
      id: "e3",
      parentId: "e2",
      timestamp: ts(3),
      message: {
        role: "user",
        content: "the golden needle appears here",
        timestamp: 3,
      },
    }),
    JSON.stringify({
      type: "message",
      id: "e4",
      parentId: "e3",
      timestamp: ts(4),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "after one" }],
        timestamp: 4,
      },
    }),
    JSON.stringify({
      type: "message",
      id: "e5",
      parentId: "e4",
      timestamp: ts(5),
      message: { role: "user", content: "after two", timestamp: 5 },
    }),
    JSON.stringify({
      type: "message",
      id: "e6",
      parentId: "e5",
      timestamp: ts(6),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "after three" }],
        timestamp: 6,
      },
    }),
  ];
  writeFileSync(file, lines.join("\n") + "\n");
  ingestAll();

  const hits = searchSessionsWithContext(db, "golden needle");
  assert.equal(hits.length, 1);
  const hit = hits[0]!;
  assert.equal(hit.sessionId, "story-id-0001");
  assert.ok(
    hit.messages.some((m) => m.isHit && m.text.includes("golden needle")),
    "hit present and marked",
  );
  // neighborhood: e1..e6 = seq 0..5 (3 before seq-3 hit, 5 after, clipped by bounds)
  const seqs = hit.messages.map((m) => m.seq);
  assert.deepEqual(seqs, [0, 1, 2, 3, 4, 5]);
  // timestamps survive into the neighborhood
  assert.ok(
    hit.messages.every((m) => m.ts !== null),
    "timestamps attached",
  );
  // roles carried
  assert.equal(hit.messages[0]!.role, "user");
});

test("search with context: todo-tag needles find breadcrumbs + checkpoints", () => {
  const file = `${store}/tagged.jsonl`;
  const ts = new Date().toISOString();
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "tagged-id-01",
      timestamp: ts,
      cwd: root,
    }),
    JSON.stringify({
      type: "message",
      id: "c1",
      parentId: null,
      timestamp: ts,
      message: {
        role: "custom",
        customType: "bb-todo",
        content: "todo:srchproj/9f3a2c · pane graph mode · todo->doing",
        display: false,
        timestamp: 1,
      },
    }),
    JSON.stringify({
      type: "message",
      id: "c2",
      parentId: "c1",
      timestamp: ts,
      message: {
        role: "custom",
        customType: "bb-checkpoint",
        content:
          "bb-checkpoint srchproj\ntodo:srchproj/9f3a2c · pane graph mode · doing",
        display: false,
        timestamp: 2,
      },
    }),
  ];
  writeFileSync(file, lines.join("\n") + "\n");
  ingestAll();

  const hits = searchSessionsWithContext(db, "todo:srchproj/9f3a2c");
  assert.ok(
    hits.length >= 1,
    "breadcrumb + checkpoint both found (one neighborhood)",
  );
  const rendered = formatSessionHits(hits);
  assert.ok(rendered.includes("▶"), "hit line marked");
  assert.ok(rendered.includes("pane graph mode"));
});

test("search with context: one neighborhood per session even with many hits", () => {
  const file = `${store}/many.jsonl`;
  const ts = new Date().toISOString();
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "many-id-0001",
      timestamp: ts,
      cwd: root,
    }),
  ];
  for (let i = 1; i <= 12; i++) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `m${i}`,
        parentId: `m${i - 1}`,
        timestamp: ts,
        message: {
          role: "user",
          content: `needle occurrence number ${i}`,
          timestamp: i,
        },
      }),
    );
  }
  writeFileSync(file, lines.join("\n") + "\n");
  ingestAll();

  const hits = searchSessionsWithContext(db, "needle");
  assert.equal(hits.length, 1, "grouped per session");
  assert.ok(hits[0]!.messages.filter((m) => m.isHit).length >= 1);
});

test("search with context: empty and hostile queries", () => {
  fakeSession(store, { cwd: root, firstUserText: "some content" });
  ingestAll();
  assert.deepEqual(searchSessionsWithContext(db, ""), []);
  assert.deepEqual(searchSessionsWithContext(db, '"unbalanced OR *'), []);
  assert.equal(formatSessionHits([]), "no matches");
});

test("formatSessionHits: renders project/name header, timestamps, role columns", () => {
  const file = `${store}/fmt.jsonl`;
  const ts = new Date(Date.UTC(2026, 4, 5, 12, 30)).toISOString();
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "fmt-id-000001",
      timestamp: ts,
      cwd: root,
    }),
    JSON.stringify({
      type: "message",
      id: "f1",
      parentId: null,
      timestamp: ts,
      message: {
        role: "user",
        content: "formatting check needle",
        timestamp: 1,
      },
    }),
    JSON.stringify({
      type: "session_info",
      id: "f2",
      parentId: "f1",
      timestamp: ts,
      name: "the formatted session",
    }),
  ];
  writeFileSync(file, lines.join("\n") + "\n");
  ingestAll();

  const rendered = formatSessionHits(
    searchSessionsWithContext(db, "formatting check"),
  );
  assert.ok(
    rendered.includes("srchproj/the formatted session"),
    "project/name header",
  );
  assert.ok(rendered.includes("05-05 12:30"), "timestamp column");
  assert.ok(rendered.includes("▶"), "hit marker");
  assert.ok(rendered.includes("user"), "role column");
});

// --- repo code search ---------------------------------------------------------------

test("code search: index lines, bm25 hits with file:line, re-index replaces", () => {
  const src = join(area, "example.ts");
  const v1 = ["function alpha() {", "\tconst golden = needle();", "}", ""].join(
    "\n",
  );
  writeFileSync(src, v1);
  const count = indexFileLines(db, src, v1);
  assert.equal(count, 3, "blank line skipped");

  const hits = searchCode(db, "golden needle");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.path, src);
  assert.equal(hits[0]!.line, 2);
  assert.ok(hits[0]!.text.includes("golden"));

  // re-index with changed content replaces prior rows
  const v2 = ["function alpha() {", "\tconst changed = value();", "}", ""].join(
    "\n",
  );
  writeFileSync(src, v2);
  indexFileLines(db, src, v2);
  assert.deepEqual(searchCode(db, "golden needle"), [], "old lines gone");
  assert.equal(searchCode(db, "changed = value").length, 1);

  // hostile queries safe
  assert.deepEqual(searchCode(db, 'OR * "'), []);
  const files = db.prepare("SELECT path FROM files").all() as Array<
    Record<string, unknown>
  >;
  assert.equal(files.length, 1);
});

test("indexProject: walks a project, indexes changed files only, skips SKIP_DIRS", () => {
  const root = join(area, "proj");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "src", "main.ts"), "export const anchor = 1;\n");
  writeFileSync(join(root, "notes.md"), "the markdown anchor note\n");
  writeFileSync(join(root, "binary.bin"), "anchor\n"); // not indexable
  writeFileSync(
    join(root, "node_modules", "dep", "dep.ts"),
    "export const depAnchor = 2;\n",
  );

  // first run indexes the two eligible files (one non-blank line each)
  const first = indexProject(db, root);
  assert.equal(first, 2);
  const hits = searchCode(db, "anchor");
  const paths = new Set(hits.map((h) => h.path));
  assert.ok(paths.has(join(root, "src", "main.ts")), "ts file indexed");
  assert.ok(paths.has(join(root, "notes.md")), "md file indexed");
  assert.ok(
    !hits.some((h) => h.path.includes("node_modules")),
    "SKIP_DIRS honored",
  );
  assert.ok(
    !hits.some((h) => h.path.endsWith(".bin")),
    "unindexable extension skipped",
  );

  // second run with no changes is incremental: zero new lines
  assert.equal(indexProject(db, root), 0, "unchanged files not re-indexed");

  // touching a file re-indexes exactly it
  writeFileSync(
    join(root, "src", "main.ts"),
    "export const anchor = 2; // v2\n",
  );
  assert.ok(indexProject(db, root) >= 1, "changed file re-indexed");
  assert.ok(searchCode(db, "v2").length >= 1, "new content searchable");
});
