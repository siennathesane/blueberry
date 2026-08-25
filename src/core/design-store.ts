/**
 * Design lifecycle store (§Design): scaffold, completeness gate, transitions.
 *
 * The FILE is content truth; this store manages creation (scaffold), the
 * completeness parser (REQUIRED sections non-empty after comment strip),
 * transitions with breadcrumbs, and genealogy (supersede). The designs DB
 * row comes from doc-index ingest — this module writes files + events.
 */
import type { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hex6Of } from "./todo-store.ts";
import { parseFrontmatter } from "./doc-index.ts";

// --- the scaffold ------------------------------------------------------------------

/** Required design-doc sections (§Design template; Summary is the only optional one). */
export const REQUIRED_SECTIONS = [
	"Audience",
	"Problem",
	"Goal",
	"Non-goals",
	"Approaches considered",
	"Decision",
	"Risks & open questions",
	"Requirements",
	"Verification",
] as const;

export type RequiredSection = (typeof REQUIRED_SECTIONS)[number];

export const DESIGN_SCAFFOLD = `---
id: {{ID}}
title: {{TITLE}}
status: open
date: {{DATE}}
---

# {{TITLE}}

## Summary
<!-- 3-5 sentences, the commit message for this design: what, for whom,
     why now. A reader decides whether to keep reading here. -->

## Audience
<!-- Precisely who this is for — "if it's for everyone, it's for no one."
     What do they have today? What will they get? Write from their side. -->

## Problem
<!-- What's broken or missing, and why does it matter NOW? Write for a
     reader who has never thought about this problem. Context only —
     this is NOT where the design goes. -->

## Goal
<!-- What will be true when this ships? One paragraph, testable. -->

## Non-goals
<!-- What we are explicitly NOT doing. Scope fences; leaving this blank
     is how scope creep wins. -->

## Approaches considered
<!-- At least two approaches, each with a verdict. Rejected ones KEEP
     their rejection reasons — this is the gold in six months. -->
### Approach A: <name>
- Pros: ...
- Cons: ...
- Verdict: chosen | rejected — because ...

## Decision
<!-- Which approach won and why. Reference the verdicts above. -->

## Risks & open questions
<!-- "none identified" is a valid answer — but say it explicitly -->

## Requirements
<!-- Numbered, keyworded (RFC 2119), testable — the contract section.
     R1. The system MUST ...        (absolute; violating = the design failed)
     R2. The system SHOULD ...      (strong default; ignoring needs a reason)
     R3. The system MAY ...         (truly optional)
     R4. The system MUST NOT ...    (absolute prohibition)
     "The system SHOULD BE fast" is not testable;
     "sync MUST complete under 2s for 100k sessions" is. -->

## Verification
<!-- "When this ships, ..." — commands, tests, signals, written from the
     future. Each MUST requirement needs at least one verification line. -->
`;

/** Scaffold a new design doc; returns the file path. */
/**
 * Next zero-padded sequence number for docs/design/*.md (001, 002, ...).
 * Files are ordered by number, never by date in the filename (user call:
 * dates in names churn; numbers keep directory listing in creation order).
 * Sequence files are exactly-3-digit-prefixed (\d{3}-) — legacy date-named
 * files (2026-08-25-...) do NOT match the shape and stay out of the sequence.
 * (Past 999 designs the pad widens to 4 digits and those files no longer
 * match the 3-digit probe — acceptable boundary, documented here.)
 */
function nextDesignNumber(dir: string): number {
	let max = 0;
	try {
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".md")) continue;
			const m = /^(\d{3})-/.exec(f);
			if (m) max = Math.max(max, Number(m[1]));
		}
	} catch {
		// no dir yet → 001
	}
	return max + 1;
}

export function scaffoldDesign(
	projectRoot: string,
	title: string,
): { path: string; id: string } {
	const id = randomUUID();
	const hex6 = hex6Of(id);
	const date = new Date().toISOString().slice(0, 10);
	const slugBase =
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "design";
	const dir = join(projectRoot, "docs", "design");
	mkdirSync(dir, { recursive: true });
	const num = String(nextDesignNumber(dir)).padStart(3, "0");
	const path = join(dir, `${num}-${slugBase}.md`);
	const body = DESIGN_SCAFFOLD.replaceAll("{{ID}}", hex6)
		.replaceAll("{{TITLE}}", title)
		.replaceAll("{{DATE}}", date);
	writeFileSync(path, body);
	return { path, id: hex6 };
}

// --- completeness parser ---------------------------------------------------------------

export interface CompletenessReport {
	/** Sections with ≥1 content line after comment strip. */
	complete: string[];
	/** Required sections empty or missing — the gate blockers. */
	unanswered: string[];
	/** Requirements MUST count and Verification coverage check. */
	requirements: { musts: string[]; uncoveredMusts: string[] };
}

/** Strip HTML comments (the scaffold questions) from a doc body. */
export function stripComments(body: string): string {
	return body.replace(/<!--[\s\S]*?-->/g, "");
}

/** Extract section content (between h2 headers) after comment stripping. */
function sectionContent(body: string, section: string): string | null {
	const stripped = stripComments(body);
	const pattern = new RegExp(
		`^##\\s+${section.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*$`,
		"m",
	);
	const match = pattern.exec(stripped);
	if (!match) return null;
	const after = stripped.slice(match.index + match[0].length);
	const next = /^##\s/m.exec(after);
	return next ? after.slice(0, next.index) : after;
}

/** Check a design body: all REQUIRED sections non-empty, MUSTs covered. */
export function checkCompleteness(body: string): CompletenessReport {
	const complete: string[] = [];
	const unanswered: string[] = [];
	for (const section of REQUIRED_SECTIONS) {
		const content = sectionContent(body, section);
		const hasContent = content !== null && content.trim() !== "";
		if (hasContent) complete.push(section);
		else unanswered.push(section);
	}

	// Requirements ↔ Verification cross-check
	const reqContent = sectionContent(body, "Requirements") ?? "";
	const musts = [...reqContent.matchAll(/R\d+\.\s+.*\bMUST\b(?! NOT)/g)].map(
		(m) => m[0].trim(),
	);
	const verContent = sectionContent(body, "Verification") ?? "";
	const uncoveredMusts: string[] = [];
	for (const m of musts) {
		// a MUST with no matching verification line: heuristically, any mention
		// of its R# in Verification, or ≥1 verification line at all when MUSTs exist
		const ridMatch = /^(R\d+)/.exec(m);
		const rid = ridMatch ? ridMatch[1] : null;
		if (rid && !verContent.includes(rid) && verContent.trim() === "") {
			uncoveredMusts.push(m);
		} else if (!rid && verContent.trim() === "") {
			uncoveredMusts.push(m);
		}
	}

	return { complete, unanswered, requirements: { musts, uncoveredMusts } };
}

// --- transitions -------------------------------------------------------------------------

export type DesignStatus = "open" | "decided" | "superseded" | "abandoned";

export interface DesignDoc {
	path: string;
	id: string;
	title: string;
	status: DesignStatus;
	supersedes: string | null;
	supersededBy: string | null;
	body: string;
}

export function readDesignDoc(path: string): DesignDoc | null {
	if (!existsSync(path)) return null;
	const raw = readFileSync(path, "utf8");
	const parsed = parseFrontmatter(raw);
	if (!parsed) return null;
	return {
		path,
		id: parsed.fm.id,
		title: parsed.fm.title ?? "",
		status: (parsed.fm.status as DesignStatus) ?? "open",
		supersedes: parsed.fm.supersedes ?? null,
		supersededBy: parsed.fm["superseded-by"] ?? null,
		body: parsed.body,
	};
}

/** Write a status transition into the doc's frontmatter (file stays truth). */
export function writeDesignStatus(
	path: string,
	status: DesignStatus,
	extra: { supersededBy?: string } = {},
): void {
	const raw = readFileSync(path, "utf8");
	// replace the status line in frontmatter
	const updated = raw.replace(/^(\s*status:\s*).+$/m, `$1${status}`);
	if (extra.supersededBy !== undefined) {
		if (/^superseded-by:/m.test(updated)) {
			writeFileSync(
				path,
				updated.replace(/^(\s*superseded-by:\s*).+$/m, `$1${extra.supersededBy}`),
			);
			return;
		}
		// insert before the CLOSING --- of frontmatter (the second one, line-oriented)
		const lines = updated.split("\n");
		let dashesSeen = 0;
		let closeIdx = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i]!.trim() === "---") {
				dashesSeen++;
				if (dashesSeen === 2) {
					closeIdx = i;
					break;
				}
			}
		}
		if (closeIdx === -1) {
			writeFileSync(path, updated); // malformed: leave as-is
			return;
		}
		lines.splice(closeIdx, 0, `superseded-by: ${extra.supersededBy}`);
		writeFileSync(path, lines.join("\n"));
		return;
	}
	writeFileSync(path, updated);
}

/** The open design doc for a project, if any (one-open rule). */
export function findOpenDesign(
	db: DatabaseSync,
	projectId: string,
): DesignDoc | null {
	const row = db
		.prepare(
			"SELECT path FROM designs WHERE project_id = ? AND status = 'open' ORDER BY ingested_at DESC LIMIT 1",
		)
		.get(projectId) as { path: string } | undefined;
	if (!row) return null;
	return readDesignDoc(row.path);
}

/** breadcrumb needle for design transitions. */
export function designBreadcrumb(
	slug: string,
	hex6: string,
	title: string,
	transition: string,
): string {
	return `design:${slug}/${hex6} · ${title} · ${transition}`;
}
