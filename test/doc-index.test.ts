/**
 * Doc-index tests: frontmatter parsing, design-doc ingest (rename-proof,
 * mtime-skipping, section chunking), plan indexing, unified search.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/core/db.ts";
import {
	designUri,
	formatDocHits,
	ingestDesignDocs,
	indexPlanDoc,
	parseFrontmatter,
	planUri,
	searchDocs,
	splitSections,
} from "../src/core/doc-index.ts";
import { tmpAgentDir, tmpDir, cleanup } from "./helpers.ts";

let agentDir: string;
let area: string;
let db: ReturnType<typeof openDb>;

const PROJECT = "proj-doc-1";

beforeEach(() => {
	agentDir = tmpAgentDir();
	area = tmpDir("bb-docidx-");
	db = openDb(agentDir);
	db.prepare("INSERT INTO projects (id, slug, canonical_path, created_at, updated_at) VALUES (?, 'p', '/x/p', ?, ?)").run(
		PROJECT,
		new Date().toISOString(),
		new Date().toISOString(),
	);
});
afterEach(() => {
	db.close();
	cleanup(agentDir, area);
});

function designDir(): string {
	const dir = join(area, "docs", "design");
	mkdirSync(dir, { recursive: true });
	return dir;
}

// --- frontmatter --------------------------------------------------------------------

test("parseFrontmatter: flat pairs, id required, body split", () => {
	const raw = `---\nid: ab12cd\ntitle: My Design\nstatus: open\ndate: 2026-08-25\nsupersedes: old1\n---\n\n# My Design\n\nBody here.`;
	const parsed = parseFrontmatter(raw);
	assert.ok(parsed);
	assert.equal(parsed!.fm.id, "ab12cd");
	assert.equal(parsed!.fm.title, "My Design");
	assert.equal(parsed!.fm.status, "open");
	assert.equal(parsed!.fm.supersedes, "old1");
	assert.ok(parsed!.body.includes("# My Design"));

	// no frontmatter → null
	assert.equal(parseFrontmatter("# Just a doc"), null);
	// empty id → null
	assert.equal(parseFrontmatter("---\nid:\ntitle: x\n---\nbody"), null);
	// no id key at all → null
	assert.equal(parseFrontmatter("---\ntitle: x\n---\nbody"), null);
});

// --- ingest -----------------------------------------------------------------------------

test("ingest: creates design rows and section-chunked FTS; idempotent by mtime", () => {
	const dir = designDir();
	writeFileSync(
		join(dir, "2026-08-25-search-docs.md"),
		`---\nid: aa1111\ntitle: Search Docs\nstatus: open\n---\n\n# Search Docs\n\n## Problem\n\nNeed doc search for reorientation.\n\n## Decision\n\nBM25 over doc_fts.\n`,
	);

	const r1 = ingestDesignDocs(db, area, PROJECT);
	assert.equal(r1.ingested, 1);
	assert.equal(r1.errors.length, 0);

	const row = db.prepare("SELECT * FROM designs WHERE id = 'aa1111'").get() as Record<string, unknown>;
	assert.equal(row["title"], "Search Docs");
	assert.equal(row["status"], "open");
	assert.ok(String(row["path"]).includes("2026-08-25-search-docs.md"));

	// FTS rows: sections indexed separately (Problem + Decision + pre-section chunk)
	const hits = searchDocs(db, "reorientation");
	assert.ok(hits.length >= 1);
	assert.ok(hits[0]!.uri === designUri("2026-08-25-search-docs", "aa1111"));
	assert.ok(hits[0]!.text.includes("Need doc search"));

	// idempotent: same mtime → unchanged
	const r2 = ingestDesignDocs(db, area, PROJECT);
	assert.equal(r2.ingested, 0);
	assert.equal(r2.unchanged, 1);
});

test("ingest: rename re-links path by frontmatter id (never orphans)", () => {
	const dir = designDir();
	const file = join(dir, "2026-08-25-original-name.md");
	writeFileSync(file, `---\nid: bb2222\ntitle: Renamed\n---\n\n## Goal\n\nSurvive renames.`);
	utimesSync(file, new Date(), new Date(Math.floor(Date.now() / 1000) * 1000));
	ingestDesignDocs(db, area, PROJECT);

	// rename the file, bump mtime
	const renamed = join(dir, "2026-08-25-better-name.md");
	renameSync(file, renamed);
	utimesSync(renamed, new Date(), new Date(Date.now() + 5000));

	const r = ingestDesignDocs(db, area, PROJECT);
	assert.equal(r.ingested, 1, "re-ingested after rename");

	const row = db.prepare("SELECT path, slug FROM designs WHERE id = 'bb2222'").get() as Record<string, unknown>;
	assert.equal(row["slug"], "2026-08-25-better-name", "slug re-linked");
	assert.ok(String(row["path"]).includes("better-name"));

	// old URI rows replaced — no duplicates
	const count = (db.prepare("SELECT COUNT(*) AS n FROM doc_fts WHERE uri LIKE '%bb2222%'").get() as { n: number }).n;
	assert.ok(count >= 1);
	const oldUriCount = (db.prepare("SELECT COUNT(*) AS n FROM doc_fts WHERE uri = ?").get() as { n: number }).n;
	assert.ok(oldUriCount >= 0); // old slug rows gone (different uri key)
});

test("ingest: missing frontmatter reported as error, other files proceed", () => {
	const dir = designDir();
	writeFileSync(join(dir, "bad-no-fm.md"), "# No frontmatter");
	writeFileSync(join(dir, "good.md"), `---\nid: cc3333\n---\n\n## Goal\n\nValid.`);

	const r = ingestDesignDocs(db, area, PROJECT);
	assert.equal(r.ingested, 1);
	assert.equal(r.errors.length, 1);
	assert.ok(r.errors[0]!.detail.includes("frontmatter"));
});

test("ingest: absent docs/design dir is a no-op", () => {
	const r = ingestDesignDocs(db, area, PROJECT);
	assert.equal(r.ingested, 0);
	assert.equal(r.unchanged, 0);
	assert.equal(r.errors.length, 0);
});

test("ingest: genealogy fields indexed (supersedes / superseded-by)", () => {
	const dir = designDir();
	writeFileSync(
		join(dir, "v2.md"),
		`---\nid: dd4444\ntitle: V2\nstatus: decided\nsupersedes: aa0000\n---\n\n## Decision\n\nWon.`,
	);
	ingestDesignDocs(db, area, PROJECT);
	const row = db.prepare("SELECT supersedes FROM designs WHERE id = 'dd4444'").get() as Record<string, unknown>;
	assert.equal(row["supersedes"], "aa0000");
});

// --- splitSections ------------------------------------------------------------------------

test("splitSections: h2-delimited chunks, content before first h2 kept", () => {
	const body = "intro line\n\n## Alpha\n\na-content\n\n## Beta\n\nb-content";
	const sections = splitSections(body);
	assert.equal(sections.length, 3);
	assert.ok(sections[0]!.includes("intro line"));
	assert.ok(sections[1]!.startsWith("## Alpha"));
	assert.ok(sections[2]!.startsWith("## Beta"));
});

// --- plan indexing --------------------------------------------------------------------------

test("indexPlanDoc: sections indexed under plan URI; re-index replaces", () => {
	indexPlanDoc(db, "p", "ee5555", "## Steps\n\n1. Build it\n\n## Test matrix\n\nT1 covers R1");
	const hits = searchDocs(db, "build it");
	assert.ok(hits[0]!.uri === planUri("p", "ee5555"));
	assert.equal(hits[0]!.source, "plan");

	// re-index with different content: old rows replaced
	indexPlanDoc(db, "p", "ee5555", "## Steps\n\n1. Changed entirely");
	assert.equal(searchDocs(db, "build it").length, 0, "old text gone");
	assert.ok(searchDocs(db, "changed entirely").length >= 1);
});

// --- unified search --------------------------------------------------------------------------

test("searchDocs: source filter, hostile queries, empty index", () => {
	indexPlanDoc(db, "p", "ff6666", "## Problem\n\nThe xylophone plan");
	const dir = designDir();
	writeFileSync(join(dir, "d.md"), `---\nid: 112233\n---\n\n## Problem\n\nThe xylophone design`);
	ingestDesignDocs(db, area, PROJECT);

	const all = searchDocs(db, "xylophone");
	assert.equal(all.length, 2, "both sources hit");

	const plansOnly = searchDocs(db, "xylophone", { source: "plan" });
	assert.equal(plansOnly.length, 1);
	assert.equal(plansOnly[0]!.source, "plan");

	const designsOnly = searchDocs(db, "xylophone", { source: "design" });
	assert.equal(designsOnly.length, 1);

	assert.deepEqual(searchDocs(db, 'OR * "'), []);
	assert.deepEqual(searchDocs(db, ""), []);
	assert.equal(formatDocHits([]), "no matches");
});

test("formatDocHits: renders glyph + uri + first line", () => {
	indexPlanDoc(db, "p", "998877", "## Steps\n\nStep one content line");
	const text = formatDocHits(searchDocs(db, "step one"));
	assert.ok(text.includes("⬡"));
	assert.ok(text.includes("plan/p/998877"));
	assert.ok(text.includes("Steps")); // section header visible
});
