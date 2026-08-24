/**
 * The todo pane: pure rendering + interaction for the §Todo mini-kanban.
 *
 * Everything here is side-effect free and theme-injected so tests can verify
 * alignment and behavior without a terminal. The extension (and, later, the
 * real store) feeds it TodoCards; the layout contract is exported so UI tests
 * can assert column geometry against the same numbers the renderer used.
 */
import { padEndVisible, stripAnsi, truncateVisible, visibleWidth } from "./ansi.ts";

export type Stage = "todo" | "doing" | "review" | "done";

export interface TodoCard {
	id: string; // hex6
	title: string;
	stage: Stage;
	age: string;
	ready?: boolean;
	blockedBy?: string[];
}

export type PaneColor = "accent" | "dim" | "muted" | "success" | "warning";

/** Minimal theme surface pi's Theme satisfies structurally. */
export interface PaneTheme {
	fg(color: PaneColor, s: string): string;
	bold(s: string): string;
}

export const COLUMNS: Array<{ key: Stage; label: string; cap?: number }> = [
	{ key: "todo", label: "todo" },
	{ key: "doing", label: "doing", cap: 5 },
	{ key: "review", label: "review" },
	{ key: "done", label: "done" },
];

export const MAX_ROWS = 8;
const DONE_SHOWN = 4;
const GAP = 2;
const LEFT_PAD = 1;

export interface PaneLayout {
	/** Visible width of each column. */
	colW: number;
	/** Visible column start offsets within a rendered line. */
	offsets: number[];
}

/** Compute the column geometry for a terminal width (the layout contract). */
export function layoutFor(width: number): PaneLayout {
	const usable = width - LEFT_PAD - GAP * (COLUMNS.length - 1);
	const colW = Math.max(12, Math.floor(usable / COLUMNS.length));
	const offsets = COLUMNS.map((_, i) => LEFT_PAD + i * (colW + GAP));
	return { colW, offsets };
}

/** Per-stage card ordering. */
export function columnItems(cards: TodoCard[], stage: Stage): TodoCard[] {
	const items = cards.filter((c) => c.stage === stage);
	if (stage === "todo") {
		return [...items].sort((a, b) => Number(Boolean(b.ready)) - Number(Boolean(a.ready)));
	}
	if (stage === "review") {
		// oldest first: "1d" sorts before "2h" is wrong — parse rough age units
		return [...items].sort((a, b) => ageMs(b.age) - ageMs(a.age));
	}
	if (stage === "done") {
		return items.slice(0, DONE_SHOWN);
	}
	return items;
}

/** Rough age string → ms for ordering ("new"=0, "4h", "2d"). */
function ageMs(age: string): number {
	const m = /^(\d+)([smhd])$/.exec(age);
	if (!m) return 0;
	const n = Number(m[1]);
	switch (m[2]) {
		case "s": return n * 1_000;
		case "m": return n * 60_000;
		case "h": return n * 3_600_000;
		case "d": return n * 86_400_000;
		default: return 0;
	}
}

/** Visible cells in column-major order — the cursor's address space. */
export function visibleCells(cards: TodoCard[]): TodoCard[] {
	const out: TodoCard[] = [];
	for (const col of COLUMNS) {
		out.push(...columnItems(cards, col.key).slice(0, MAX_ROWS));
	}
	return out;
}

// --- state machine -------------------------------------------------------------

export interface PaneState {
	cursor: number;
	detail: boolean;
}

export type Intent = "prev" | "next" | "enter" | "back" | "close";

export const CLOSED: unique symbol = Symbol("closed");
export type StepResult = PaneState | typeof CLOSED;

/**
 * Pure input reducer. "close" only closes from pane level (escape/q);
 * back from detail returns to the pane. Cursor clamps to visible cells.
 */
export function applyInput(state: PaneState, intent: Intent, cellCount: number): StepResult {
	switch (intent) {
		case "close":
			return state.detail ? { ...state, detail: false } : CLOSED;
		case "back":
			return state.detail ? { ...state, detail: false } : state;
		case "enter":
			return cellCount > 0 ? { ...state, detail: true } : state;
		case "prev":
			return { ...state, cursor: clamp(state.cursor - 1, cellCount), detail: false };
		case "next":
			return { ...state, cursor: clamp(state.cursor + 1, cellCount), detail: false };
	}
}

function clamp(n: number, cellCount: number): number {
	if (cellCount <= 0) return 0;
	return Math.min(Math.max(0, n), cellCount - 1);
}

// --- rendering -----------------------------------------------------------------

function card(t: TodoCard, theme: PaneTheme): string {
	const glyph = glyphFor(t, theme);
	const title = t.stage === "done" ? theme.fg("dim", t.title) : t.title;
	const age = theme.fg("dim", t.age);
	const deps = t.blockedBy?.length ? theme.fg("dim", ` ⟵${t.blockedBy.length}`) : "";
	return `${glyph} ${title} ${age}${deps}`;
}

function glyphFor(t: TodoCard, theme: PaneTheme): string {
	if (t.stage === "done") return theme.fg("dim", "✓");
	if (t.stage === "doing") return theme.fg("accent", "◉");
	if (t.stage === "review") return theme.fg("warning", "◷");
	return t.ready ? theme.fg("success", "▣") : theme.fg("dim", "▧");
}

/** Render the kanban pane. All lines are padEnd-aligned per the layout contract. */
export function renderPane(width: number, theme: PaneTheme, cards: TodoCard[], state: PaneState): string[] {
	const { colW } = layoutFor(width);
	const lines: string[] = [];

	const total = cards.length;
	const done = cards.filter((c) => c.stage === "done").length;
	const ready = cards.filter((c) => c.stage === "todo" && c.ready).length;
	const blocked = cards.filter((c) => c.stage === "todo" && !c.ready).length;
	lines.push(
		theme.fg("accent", theme.bold(" ⬡ todos")) +
			theme.fg("muted", `  ${done}/${total} done · ${ready} ready · ${blocked} blocked`),
	);
	lines.push(theme.fg("dim", "─".repeat(width)));

	const headers = COLUMNS.map((c) => {
		const n = cards.filter((t) => t.stage === c.key).length;
		const cap = c.cap ? theme.fg("dim", `/${c.cap}`) : "";
		return padEndVisible(truncateVisible(theme.bold(`${c.label} ${theme.fg("muted", String(n))}${cap}`), colW), colW);
	});
	const leftPad = " ".repeat(LEFT_PAD); // first column offset; offsets[0] is always LEFT_PAD
	lines.push(leftPad + headers.join(" ".repeat(GAP)));
	lines.push(theme.fg("dim", leftPad + COLUMNS.map(() => "─".repeat(colW)).join(" ".repeat(GAP))));

	const byCol = COLUMNS.map((c) => columnItems(cards, c.key));
	const flat = visibleCells(cards);

	for (let row = 0; row < MAX_ROWS; row++) {
		if (!byCol.some((items) => items[row])) break;
		const cells = byCol.map((items) => {
			const t = items[row];
			if (!t) return " ".repeat(colW);
			const flatIdx = flat.indexOf(t);
			const isCursor = flatIdx === state.cursor;
			let cell = card(t, theme);
			if (isCursor) cell = theme.fg("accent", "▸") + cell + theme.fg("accent", "◂");
			return padEndVisible(truncateVisible(cell, colW), colW);
		});
		lines.push(leftPad + cells.join(" ".repeat(GAP)));
	}
	const overflow = byCol
		.map((items, i) => {
			const col = COLUMNS[i];
			if (!col || items.length <= MAX_ROWS) return "";
			return `+${items.length - MAX_ROWS} ${col.label}`;
		})
		.filter(Boolean);
	if (overflow.length > 0) lines.push(theme.fg("dim", ` ${overflow.join(" · ")}`));

	const cur = flat[state.cursor];
	if (cur && !state.detail) {
		lines.push("");
		const foot =
			theme.fg("muted", ` → ${cur.id} · ${cur.title}`) +
			theme.fg(
				"dim",
				cur.blockedBy?.length
					? ` · blocked by ${cur.blockedBy.join(", ")}`
					: cur.ready
						? " · ready"
						: "",
			);
		lines.push(truncateVisible(foot, width, ""));
	}

	lines.push("");
	lines.push(theme.fg("dim", " arrows move · enter into · ⌫ out · q close"));
	return lines;
}

function stageColorFor(stage: Stage): PaneColor {
	if (stage === "doing") return "accent";
	if (stage === "review") return "warning";
	if (stage === "done") return "dim";
	return "muted";
}

/** Render the detail card for the cursor task. Box rows are width-exact. */
export function renderDetail(width: number, theme: PaneTheme, cards: TodoCard[], state: PaneState): string[] {
	const flat = visibleCells(cards);
	const cur = flat[Math.min(state.cursor, flat.length - 1)];
	if (!cur) return [theme.fg("dim", "(no task)")];

	const t = cur;
	const innerW = Math.max(20, Math.min(width - 4, 58));
	// top border: 3 ("┌─ ") + title + 1 + stageLen + 1 + repeat + 1 ("┐") == innerW + 4
	const stageLen = `· ${t.stage}`.length;
	const top = "─".repeat(Math.max(0, innerW + 4 - t.title.length - stageLen - 6));
	const stageColor = stageColorFor(t.stage);

	const edge = theme.fg("dim", "│");
	const boxLine = (content: string): string =>
		edge + " " + padEndVisible(truncateVisible(content, innerW), innerW) + " " + edge;

	const lines: string[] = [];
	lines.push(
		theme.fg("dim", "┌─ ") + theme.bold(t.title) + " " + theme.fg(stageColor, `· ${t.stage}`) + " " + theme.fg("dim", top + "┐"),
	);
	lines.push(boxLine(theme.fg("dim", `id ${t.id} · ${t.age}`)));

	const blockers = cards.filter((c) => t.blockedBy?.includes(c.id));
	const unlocks = cards.filter((c) => c.blockedBy?.includes(t.id));

	const row = (label: string, value: string): string =>
		theme.fg("muted", label.padEnd(10)) + value;

	lines.push(boxLine(""));
	lines.push(
		boxLine(
			blockers.length > 0
				? row("waits on", blockers.map((b) => `${b.id} ${theme.fg("dim", b.title)}`).join(" · "))
				: row("waits on", theme.fg("success", "nothing — ready")),
		),
	);
	lines.push(
		boxLine(
			unlocks.length > 0
				? row("unlocks", unlocks.map((u) => `${u.id} ${theme.fg("dim", u.title)}`).join(" · "))
				: row("unlocks", theme.fg("dim", "(nothing yet)")),
		),
	);
	lines.push(boxLine(row("context", theme.fg("dim", "session 01a03552 · DESIGN.md §Todo"))));
	lines.push(theme.fg("dim", "└" + "─".repeat(innerW + 2) + "┘"));
	lines.push("");
	lines.push(theme.fg("dim", " ⌫ back to pane"));
	return lines;
}

/** Render according to state (pane or detail). */
export function renderTodoPane(width: number, theme: PaneTheme, cards: TodoCard[], state: PaneState): string[] {
	return state.detail ? renderDetail(width, theme, cards, state) : renderPane(width, theme, cards, state);
}

export { stripAnsi, visibleWidth };
