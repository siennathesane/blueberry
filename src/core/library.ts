/**
 * Cross-project session access: the query vocabulary over existing stores.
 *
 * Principles (DESIGN.md §Library):
 * - Read-only across project boundaries. The only cross-store write is fork,
 *   which lands in the READER's store via copy mode and never touches the source.
 * - No new state: registry + stores already exist; this module only reads them.
 * - Extracts, not dumps: every view is rendered text with byte/line budgets.
 * - Everything inspectable: a `message` view exists for full single-message
 *   content (thinking, tool arguments, tool results included).
 *
 * Addressing: `<project>/<selector>`; bare selector = current project.
 * Selector grammar: list index (1-based, newest first), uuid prefix (>=4),
 * exact session name. Duplicate names within a store refuse and list candidates.
 */
import type { Registry, Project } from "./registry.ts";
import { findBySlug } from "./registry.ts";
import { storeDirFor } from "./resolution.ts";
import {
	listSessions,
	moveSession,
	renameSession,
	type SessionInfo,
} from "./sessions.ts";
import type { MoveOptions } from "./sessions.ts";
import { readFileSync } from "node:fs";

export const MAX_VIEW_BYTES = 50_000;
export const MAX_VIEW_LINES = 2000;

// --- parsing -------------------------------------------------------------------

export interface ParsedLine {
	type?: string;
	id?: string;
	parentId?: string | null;
	[key: string]: unknown;
}

export interface ParsedSession {
	header: Record<string, unknown>;
	entries: ParsedLine[];
}

/** Parse a session file into header + entries, skipping malformed lines. */
export function parseSessionFile(file: string): ParsedSession | null {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const lines = raw.split("\n");
	const headerLine = lines.shift();
	if (headerLine === undefined) return null;
	let header: Record<string, unknown>;
	try {
		header = JSON.parse(headerLine) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (header["type"] !== "session" || typeof header["id"] !== "string")
		return null;
	const entries: ParsedLine[] = [];
	for (const line of lines) {
		if (line.trim() === "") continue;
		try {
			const parsed = JSON.parse(line) as ParsedLine;
			if (parsed.type === "session") continue;
			entries.push(parsed);
		} catch {
			// skip malformed body lines; views tolerate gaps
		}
	}
	return { header, entries };
}

// --- budget --------------------------------------------------------------------

export interface Capped {
	text: string;
	truncated: boolean;
	totalLines: number;
	shownLines: number;
}

export function capTail(
	text: string,
	maxBytes = MAX_VIEW_BYTES,
	maxLines = MAX_VIEW_LINES,
): Capped {
	const lines = text.split("\n");
	const totalLines = lines.length;
	let out = lines;
	let truncated = false;
	if (out.length > maxLines) {
		out = out.slice(out.length - maxLines);
		truncated = true;
	}
	let joined = out.join("\n");
	if (joined.length > maxBytes) {
		joined = joined.slice(joined.length - maxBytes);
		truncated = true;
	}
	return { text: joined, truncated, totalLines, shownLines: out.length };
}

export function capHead(
	text: string,
	maxBytes = MAX_VIEW_BYTES,
	maxLines = MAX_VIEW_LINES,
): Capped {
	const lines = text.split("\n");
	const totalLines = lines.length;
	let out = lines;
	let truncated = false;
	if (out.length > maxLines) {
		out = out.slice(0, maxLines);
		truncated = true;
	}
	let joined = out.join("\n");
	if (joined.length > maxBytes) {
		joined = joined.slice(0, maxBytes);
		truncated = true;
	}
	return { text: joined, truncated, totalLines, shownLines: out.length };
}

// --- addressing ------------------------------------------------------------------

export interface Address {
	project?: string;
	selector: string;
}

export function parseAddress(addr: string): Address {
	const trimmed = addr.trim();
	const slash = trimmed.indexOf("/");
	if (slash === -1) return { selector: trimmed };
	const project = trimmed.slice(0, slash);
	const selector = trimmed.slice(slash + 1);
	if (project === "" || selector === "") {
		throw new Error(
			`invalid address '${addr}' (expected <project>/<selector> or <selector>)`,
		);
	}
	return { project, selector };
}

export interface ResolvedAddress {
	project: Project;
	session: SessionInfo;
}

/** Resolve an address to a project + session. Current project used when bare. */
export function resolveAddress(
	registry: Registry,
	agentDir: string,
	currentSlug: string,
	addr: string,
): ResolvedAddress {
	const { project, selector } = parseAddress(addr);
	const target = project
		? findBySlug(registry, project)
		: findBySlug(registry, currentSlug);
	if (!target) {
		const known = registry.projects.map((p) => p.slug).join(", ") || "none";
		throw new Error(`no project '${project ?? currentSlug}' (known: ${known})`);
	}

	const sessions = listSessions(storeDirFor(agentDir, target));
	const trimmed = selector.trim();
	if (trimmed === "") throw new Error("empty selector");

	if (/^\d+$/.test(trimmed)) {
		const idx = Number(trimmed) - 1;
		const session = sessions[idx];
		if (!session)
			throw new Error(
				`index ${trimmed} out of range (project '${target.slug}' has ${sessions.length})`,
			);
		return { project: target, session };
	}

	if (trimmed.length >= 4) {
		const byId =
			sessions.find((s) => s.id === trimmed) ??
			sessions.find((s) => s.id.startsWith(trimmed));
		if (byId) return { project: target, session: byId };
	}

	const nameMatches = sessions.filter((s) => s.name === trimmed);
	if (nameMatches.length === 1)
		return { project: target, session: nameMatches[0]! };
	if (nameMatches.length > 1) {
		const list = nameMatches
			.map(
				(s, i) =>
					`${i + 1}. ${s.id.slice(0, 8)} ${new Date(s.mtimeMs).toISOString().slice(0, 16)}`,
			)
			.join("\n");
		throw new Error(
			`ambiguous name '${trimmed}' in '${target.slug}' — use index or uuid prefix:\n${list}`,
		);
	}

	throw new Error(`no session matching '${trimmed}' in '${target.slug}'`);
}

// --- views ------------------------------------------------------------------------

export type ViewKind = "summary" | "tree" | "messages" | "message";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => {
				if (
					typeof c === "object" &&
					c !== null &&
					(c as { type?: string }).type === "text"
				) {
					return (c as { text?: string }).text ?? "";
				}
				return "";
			})
			.filter((s) => s !== "")
			.join("\n");
	}
	return "";
}

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(content))
		return content.filter((c) => typeof c === "object" && c !== null) as Array<
			Record<string, unknown>
		>;
	return [];
}

function messageEntry(
	e: ParsedLine,
): ({ role?: string } & Record<string, unknown>) | null {
	if (e.type !== "message") return null;
	const m = e.message as { role?: string } | undefined;
	if (!m || typeof m.role !== "string") return null;
	return m as { role?: string } & Record<string, unknown>;
}

export function renderSummary(
	session: SessionInfo,
	parsed: ParsedSession,
): string {
	const models = new Set<string>();
	let labels = 0;
	let compactions = 0;
	let branchSummaries = 0;
	let thinkingChanges = 0;
	for (const e of parsed.entries) {
		if (e.type === "model_change") models.add(`${e.provider}/${e.modelId}`);
		if (e.type === "label" && e.label) labels++;
		if (e.type === "compaction") compactions++;
		if (e.type === "branch_summary") branchSummaries++;
		if (e.type === "thinking_level_change") thinkingChanges++;
	}
	const lines = [
		`name:       ${session.name ?? "(unnamed)"}`,
		`id:         ${session.id}`,
		`cwd:        ${session.cwd ?? "(none)"}`,
		`project:    (store) ${session.file.split("/").slice(-2, -1)[0] ?? "?"}`,
		`modified:   ${new Date(session.mtimeMs).toISOString()}`,
		`messages:   ${session.messageCount}`,
		`size:       ${session.sizeBytes} bytes`,
		`first msg:  ${oneLine(session.firstUserText ?? "(none)", 80)}`,
		models.size > 0
			? `models:     ${[...models].join(", ")}`
			: `models:     (header only)`,
		`labels: ${labels}  compactions: ${compactions}  branch summaries: ${branchSummaries}  thinking changes: ${thinkingChanges}`,
		`entries:    ${parsed.entries.length}`,
	];
	return lines.join("\n");
}

function oneLine(s: string, max: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export function renderTree(parsed: ParsedSession): string {
	const byId = new Map<string, ParsedLine>();
	const children = new Map<string | null, ParsedLine[]>();
	for (const e of parsed.entries) {
		if (typeof e.id !== "string") continue;
		byId.set(e.id, e);
		const key = typeof e.parentId === "string" ? e.parentId : null;
		const list = children.get(key) ?? [];
		list.push(e);
		children.set(key, list);
	}

	const describe = (e: ParsedLine): string => {
		// entries without string ids are skipped by the walk, so id is always a string here
		const id = String(e.id);
		switch (e.type) {
			case "message": {
				const m = messageEntry(e);
				const role = m?.role ?? "?";
				if (role === "user")
					return `[user] ${oneLine(textOf(m?.content), 60)} (${id})`;
				if (role === "assistant")
					return `[assistant] ${oneLine(textOf(m?.content), 60)} (${id})`;
				if (role === "toolResult")
					return `[toolResult] ${String(m?.toolName ?? "?")} (${id})`;
				if (role === "bashExecution")
					return `[bash] ${oneLine(String(m?.command ?? ""), 50)} (${id})`;
				return `[${role}] (${id})`;
			}
			case "compaction":
				return `[compaction] ${String(e.tokensBefore ?? "?")} tokens before (${id})`;
			case "branch_summary":
				return `[branch summary] from ${String(e.fromId ?? "?")} (${id})`;
			case "label":
				return `[label] ${String(e.label ?? "")} -> ${String(e.targetId ?? "?")}`;
			case "model_change":
				return `[model] ${String(e.provider)}/${String(e.modelId)} (${id})`;
			case "thinking_level_change":
				return `[thinking] ${String(e.thinkingLevel)} (${id})`;
			case "session_info":
				return `[session info] ${String(e.name ?? "")} (${id})`;
			default:
				return `[${String(e.type)}] (${id})`;
		}
	};

	const out: string[] = [];
	const walk = (parent: string | null, depth: number): void => {
		const kids = children.get(parent) ?? [];
		for (const kid of kids) {
			out.push("  ".repeat(depth) + describe(kid));
			const branchPoint = (children.get(kid.id as string) ?? []).length > 1;
			if (branchPoint) out.push("  ".repeat(depth + 1) + "┄ branch point");
			if (typeof kid.id === "string") walk(kid.id, depth + 1);
		}
	};
	walk(null, 0);
	const capped = capHead(out.join("\n") || "(empty)");
	return capped.truncated ? capped.text + "\n… [tree truncated]" : capped.text;
}

/** Numbered message entries in file order (visible ones for pagination). */
export interface NumberedMessage {
	n: number; // 1-based
	entry: ParsedLine;
	role: string;
}

export function numberMessages(parsed: ParsedSession): NumberedMessage[] {
	const out: NumberedMessage[] = [];
	let n = 0;
	for (const e of parsed.entries) {
		const m = messageEntry(e);
		if (!m) continue;
		const role = m.role ?? "?";
		if (role === "bashExecution" && m.excludeFromContext === true) continue;
		n++;
		out.push({ n, entry: e, role });
	}
	return out;
}

export function renderMessages(
	parsed: ParsedSession,
	offset = 0,
	limit = 80,
): string {
	const numbered = numberMessages(parsed);
	const slice = numbered.slice(offset, offset + limit);
	const out: string[] = [];
	for (const item of slice) {
		const m = messageEntry(item.entry)!;
		switch (item.role) {
			case "user":
				out.push(`--- #${item.n} user ---`);
				out.push(textOf(m.content) || "(empty)");
				break;
			case "assistant": {
				out.push(`--- #${item.n} assistant ---`);
				const text = textOf(m.content);
				if (text !== "") out.push(text);
				for (const b of contentBlocks(m.content)) {
					if (b["type"] === "toolCall") {
						out.push(
							`  · tool ${b["name"]} (${typeof b["id"] === "string" ? b["id"].slice(0, 8) : "?"})`,
						);
					}
				}
				if (text === "") out.push("(tool calls only)");
				break;
			}
			case "toolResult": {
				const blocks = contentBlocks(m.content);
				const bytes = JSON.stringify(m.content ?? "").length;
				const ok = m.isError ? "error" : "ok";
				out.push(
					`--- #${item.n} toolResult ${m.toolName} → ${ok} (${bytes}b, ${blocks.length} block(s)) ---`,
				);
				break;
			}
			case "bashExecution":
				out.push(`--- #${item.n} bash ---`);
				out.push(`$ ${m.command}`);
				break;
			case "custom":
				out.push(`--- #${item.n} custom ${m.customType} ---`);
				out.push(oneLine(textOf(m.content), 120));
				break;
			case "branchSummary":
				out.push(`--- #${item.n} branch summary ---`);
				out.push(oneLine(String(m.summary ?? ""), 200));
				break;
			case "compactionSummary":
				out.push(`--- #${item.n} compaction summary ---`);
				out.push(oneLine(String(m.summary ?? ""), 200));
				break;
			default:
				out.push(`--- #${item.n} ${item.role} ---`);
		}
	}
	const header = `[messages ${slice.length > 0 ? `${slice[0]!.n}..${slice[slice.length - 1]!.n}` : "none"} of ${numbered.length} total]`;
	const body = out.length > 0 ? out.join("\n") : "(no messages in range)";
	const capped = capTail(`${header}\n${body}`);
	return capped.truncated
		? capped.text +
				`\n… [truncated; total ${capped.totalLines} lines — narrow with --offset/--limit]`
		: capped.text;
}

/** Full content of one numbered message — everything, including thinking. */
export function renderMessage(
	parsed: ParsedSession,
	messageNumber: number,
): string {
	const numbered = numberMessages(parsed);
	const item = numbered.find((m) => m.n === messageNumber);
	if (!item) {
		throw new Error(`no message #${messageNumber} (range 1..${numbered.length})`);
	}
	const m = messageEntry(item.entry)!;
	const out: string[] = [`=== message #${item.n} role=${item.role} ===`];

	if (item.role === "assistant") {
		for (const b of contentBlocks(m.content)) {
			const t = b["type"];
			if (t === "thinking") {
				out.push("--- thinking ---");
				out.push(String(b["thinking"] ?? ""));
			} else if (t === "text") {
				out.push("--- text ---");
				out.push(String(b["text"] ?? ""));
			} else if (t === "toolCall") {
				out.push(`--- toolCall ${b["name"]} (id ${b["id"]}) ---`);
				out.push(JSON.stringify(b["arguments"] ?? {}, null, 2));
			} else if (t === "image") {
				out.push(`[image ${b["mimeType"] ?? "?"}]`);
			}
		}
	} else if (item.role === "toolResult") {
		out.push(`tool: ${m.toolName}  isError: ${String(Boolean(m.isError))}`);
		for (const b of contentBlocks(m.content)) {
			if (b["type"] === "text") out.push(String(b["text"] ?? ""));
			else if (b["type"] === "image") out.push(`[image ${b["mimeType"] ?? "?"}]`);
		}
		if (m.details !== undefined) {
			out.push("--- details ---");
			out.push(JSON.stringify(m.details, null, 2));
		}
	} else if (item.role === "bashExecution") {
		out.push(`$ ${m.command}`);
		out.push("--- output ---");
		out.push(String(m.output ?? ""));
		if (m.exitCode !== undefined) out.push(`--- exit ${m.exitCode} ---`);
	} else {
		if (item.role === "custom")
			out.push(`customType: ${String(m.customType ?? "?")}`);
		if (item.role === "branchSummary")
			out.push(`from: ${String(m.fromId ?? "?")}`);
		if (item.role === "compactionSummary")
			out.push(`tokensBefore: ${String(m.tokensBefore ?? "?")}`);
		out.push(JSON.stringify(m.content ?? null, null, 2));
		if (m.usage !== undefined) {
			out.push("--- usage ---");
			out.push(JSON.stringify(m.usage, null, 2));
		}
	}
	const capped = capTail(out.join("\n"));
	return capped.truncated ? capped.text + "\n… [truncated]" : capped.text;
}

// --- search ------------------------------------------------------------------------

export interface SearchHit {
	project: string;
	session: string; // name or id8
	file: string;
	messageNumber: number; // 0 when not a message
	snippet: string;
}

export function searchSessions(
	registry: Registry,
	agentDir: string,
	query: string,
	opts: { all: boolean; currentSlug: string },
): SearchHit[] {
	const needle = query.toLowerCase();
	if (needle === "") return [];
	const projects = opts.all
		? registry.projects
		: registry.projects.filter((p) => p.slug === opts.currentSlug);
	const hits: SearchHit[] = [];

	for (const project of projects) {
		const store = storeDirFor(agentDir, project);
		for (const session of listSessions(store)) {
			const parsed = parseSessionFile(session.file);
			if (!parsed) continue;
			if (session.name && session.name.toLowerCase().includes(needle)) {
				hits.push({
					project: project.slug,
					session: session.name,
					file: session.file,
					messageNumber: 0,
					snippet: `(session name) ${session.name}`,
				});
			}
			for (const item of numberMessages(parsed)) {
				const m = messageEntry(item.entry)!;
				const texts: string[] = [];
				if (
					item.role === "user" ||
					item.role === "assistant" ||
					item.role === "custom"
				) {
					texts.push(textOf(m.content));
				}
				for (const t of texts) {
					const lower = t.toLowerCase();
					const at = lower.indexOf(needle);
					if (at >= 0) {
						const start = Math.max(0, at - 40);
						const snippet = t
							.slice(start, at + needle.length + 80)
							.replace(/\s+/g, " ");
						hits.push({
							project: project.slug,
							session: session.name ?? session.id.slice(0, 8),
							file: session.file,
							messageNumber: item.n,
							snippet,
						});
						break;
					}
				}
			}
		}
	}
	return hits;
}

export function formatSearchHits(hits: SearchHit[]): string {
	if (hits.length === 0) return "no matches";
	const capped = capHead(
		hits
			.map((h) => `${h.project}/${h.session} #${h.messageNumber}: ${h.snippet}`)
			.join("\n"),
	);
	return capped.truncated ? capped.text + "\n… [truncated]" : capped.text;
}

// --- fork ---------------------------------------------------------------------------

export interface ForkResult {
	file: string;
	name: string;
}

/**
 * Fork a session into a target project's store. Copy-only: the source store is
 * never touched. parentSession is cleared (it would dangle across stores).
 * The new session is named `<name>@<source-slug>` via a pi-native rename.
 */
export function forkSession(opts: {
	agentDir: string;
	sourceFile: string;
	sourceProject: Project;
	sourceSession: SessionInfo;
	targetProject: Project;
}): ForkResult {
	const targetStore = storeDirFor(opts.agentDir, opts.targetProject);
	const base = (
		opts.sourceSession.name ??
		opts.sourceSession.firstUserText?.trim() ??
		opts.sourceSession.id.slice(0, 8)
	)
		.replace(/\//g, "-")
		.slice(0, 48)
		.replace(/^-*|-*$/g, "");
	const name = `${base || "session"}@${opts.sourceProject.slug}`;

	const moveOpts: MoveOptions = { newCwd: opts.targetProject.canonicalPath };
	moveOpts.copy = true;
	const placed = moveSession(opts.sourceFile, targetStore, moveOpts);
	renameSession(placed, name);
	return { file: placed, name };
}
