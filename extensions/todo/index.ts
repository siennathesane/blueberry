/**
 * blueberry todo — VISUAL PREVIEW SCAFFOLD (design iteration only).
 *
 * Renders the §Todo round-2 mini-kanban with MOCK data so we can iterate the
 * pane's look live (/reload + /todo). No DB, no state — when §Data lands this
 * file is replaced by the real thing.
 *
 * Mock = blueberry's actual roadmap, so proportions are honest.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";

type Stage = "todo" | "doing" | "review" | "done";

interface MockTask {
	id: string;
	title: string;
	stage: Stage;
	age: string;
	ready?: boolean;
	blockedBy?: string[];
}

const MOCK: MockTask[] = [
	{ id: "9f3a2c", title: "dag core + persistence", stage: "doing", age: "4h" },
	{ id: "a11b02", title: "quiet opener polish", stage: "review", age: "2h" },
	{ id: "c7d4e9", title: "bb sync catch-up walk", stage: "review", age: "1d" },
	{
		id: "5e8f31",
		title: "fts5 schema + migration",
		stage: "todo",
		age: "new",
		ready: true,
	},
	{
		id: "3b9k77",
		title: "bb_search tool",
		stage: "todo",
		age: "new",
		blockedBy: ["5e8f31"],
	},
	{
		id: "d2c4a8",
		title: "symbol index",
		stage: "todo",
		age: "new",
		blockedBy: ["5e8f31"],
	},
	{
		id: "f6g1h3",
		title: "native lsp",
		stage: "todo",
		age: "new",
		blockedBy: ["d2c4a8"],
	},
	{
		id: "7i5j9k",
		title: "plan file format",
		stage: "todo",
		age: "new",
		ready: true,
	},
	{
		id: "1k2l3m",
		title: "tool gate (read-only)",
		stage: "todo",
		age: "new",
		blockedBy: ["7i5j9k"],
	},
	{
		id: "4n5o6p",
		title: "approval flow",
		stage: "todo",
		age: "new",
		blockedBy: ["7i5j9k"],
	},
	{
		id: "8q9r0s",
		title: "pane graph mode",
		stage: "todo",
		age: "new",
		blockedBy: ["9f3a2c"],
	},
	{ id: "2t3u4v", title: "session registry", stage: "done", age: "2d" },
	{ id: "6w7x8y", title: "cross-project library", stage: "done", age: "2d" },
	{ id: "0z1a2b", title: "/exit + opener", stage: "done", age: "1d" },
];

const COLS: Array<{ key: Stage; label: string; cap?: number }> = [
	{ key: "todo", label: "todo" },
	{ key: "doing", label: "doing", cap: 5 },
	{ key: "review", label: "review" },
	{ key: "done", label: "done" },
];

function card(t: MockTask, theme: Theme): string {
	const glyph =
		t.stage === "done"
			? theme.fg("dim", "✓")
			: t.stage === "doing"
				? theme.fg("accent", "◉")
				: t.stage === "review"
					? theme.fg("warning", "◷")
					: t.ready
						? theme.fg("success", "▣")
						: theme.fg("dim", "▧");
	const title = t.stage === "done" ? theme.fg("dim", t.title) : t.title;
	const age = theme.fg("dim", t.age);
	const deps = t.blockedBy?.length
		? theme.fg("dim", ` ⟵${t.blockedBy.length}`)
		: "";
	return `${glyph} ${title} ${age}${deps}`;
}

/** Truncate to visible width, preserving the leading glyph's color. */
function truncate(s: string, width: number): string {
	const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
	if (plain.length <= width) return s;
	// cut plain, keep first color code if present so the glyph stays colored
	const firstColor = /^\x1b\[[0-9;]*m/.exec(s);
	return (firstColor ? firstColor[0] : "") + plain.slice(0, width - 1) + "…";
}

const MAXROWS = 8;

function columnItems(stage: Stage): MockTask[] {
	const items = MOCK.filter((t) => t.stage === stage);
	if (stage === "todo") {
		return [...items].sort(
			(a, b) => Number(Boolean(b.ready)) - Number(Boolean(a.ready)),
		);
	}
	if (stage === "review") {
		return [...items].sort((a, b) => (a.age > b.age ? -1 : 1)); // oldest first (rough)
	}
	if (stage === "done") {
		return items.slice(0, 4); // recent few
	}
	return items;
}

function renderPane(width: number, theme: Theme, cursor: number): string[] {
	const gap = "  ";
	const colW = Math.max(12, Math.floor((width - 2 - 3 * gap.length) / 4));
	const lines: string[] = [];

	const total = MOCK.length;
	const done = MOCK.filter((t) => t.stage === "done").length;
	const ready = MOCK.filter((t) => t.stage === "todo" && t.ready).length;
	const blocked = MOCK.filter((t) => t.stage === "todo" && !t.ready).length;
	lines.push(
		theme.fg("accent", theme.bold(" ⬡ todos")) +
			theme.fg(
				"muted",
				`  ${done}/${total} done · ${ready} ready · ${blocked} blocked`,
			),
	);
	lines.push(theme.fg("dim", "─".repeat(width)));

	const headers = COLS.map((c) => {
		const n = MOCK.filter((t) => t.stage === c.key).length;
		const cap = c.cap ? theme.fg("dim", `/${c.cap}`) : "";
		return theme.bold(`${c.label} ${theme.fg("muted", String(n))}${cap}`);
	});
	lines.push(" " + headers.map((h) => truncate(h, colW)).join(gap));
	lines.push(theme.fg("dim", " " + COLS.map(() => "─".repeat(colW)).join(gap)));

	const byCol = COLS.map((c) => columnItems(c.key));
	// flatten visible cells in column-major order for cursor indexing
	const flat: Array<{ col: number; row: number; task: MockTask }> = [];
	byCol.forEach((items, col) => {
		items.slice(0, MAXROWS).forEach((task, row) => flat.push({ col, row, task }));
	});

	for (let row = 0; row < MAXROWS; row++) {
		const cells = byCol.map((items, col) => {
			const t = items[row];
			if (!t) return " ".repeat(colW);
			const base = truncate(card(t, theme), colW);
			const flatIdx = flat.findIndex((f) => f.col === col && f.row === row);
			const isCursor = flatIdx === cursor;
			if (!isCursor) return base.padEnd(colW, " ");
			// cursor: accent bracket around the card's plain text
			const plain = base.replace(/\x1b\[[0-9;]*m/g, "");
			return truncate(
				theme.fg("accent", "▸") + base + theme.fg("accent", "◂"),
				colW,
			).padEnd(Math.max(colW, plain.length + 2), " ");
		});
		if (!byCol.some((items) => items[row])) break;
		lines.push(" " + cells.join(gap));
	}

	const overflow = byCol
		.map((items, i) =>
			items.length > MAXROWS ? `+${items.length - MAXROWS} ${COLS[i]!.label}` : "",
		)
		.filter(Boolean);
	if (overflow.length > 0)
		lines.push(theme.fg("dim", ` ${overflow.join(" · ")}`));

	const cur = flat[cursor];
	if (cur) {
		lines.push("");
		lines.push(
			theme.fg("muted", ` → ${cur.task.id} · ${cur.task.title}`) +
				theme.fg(
					"dim",
					cur.task.blockedBy?.length
						? ` · blocked by ${cur.task.blockedBy.join(", ")}`
						: cur.task.ready
							? " · ready"
							: "",
				),
		);
	}

	lines.push("");
	lines.push(
		theme.fg(
			"dim",
			" h/l j/k move · enter detail · g graph · n new · q close  (preview · mock data)",
		),
	);
	return lines;
}

/** Flat list of visible cells (column-major) — shared by pane + detail. */
function flatVisible(): Array<{ col: number; row: number; task: MockTask }> {
	const byCol = COLS.map((c) => columnItems(c.key));
	const flat: Array<{ col: number; row: number; task: MockTask }> = [];
	byCol.forEach((items, col) => {
		items.slice(0, MAXROWS).forEach((task, row) => flat.push({ col, row, task }));
	});
	return flat;
}

/** Detail card: the "into" view. Backspace/escape returns to the pane. */
function renderDetail(width: number, theme: Theme, cursor: number): string[] {
	const flat = flatVisible();
	const cur = flat[Math.min(cursor, flat.length - 1)];
	if (!cur) return ["(no task)"];
	const t = cur.task;
	const innerW = Math.min(width - 4, 60);

	const stageColor =
		t.stage === "doing" ? "accent" : t.stage === "review" ? "warning" : t.stage === "done" ? "dim" : "muted";

	const blockers = MOCK.filter((m) => t.blockedBy?.includes(m.id));
	const unlocks = MOCK.filter((m) => m.blockedBy?.includes(t.id));

	const lines: string[] = [];
	lines.push(theme.fg("dim", "┌─ ") + theme.bold(t.title) + " " + theme.fg(stageColor, `· ${t.stage}`) + " " + theme.fg("dim", "─".repeat(Math.max(0, innerW - t.title.length - 12)) + "┐"));
	lines.push(theme.fg("dim", "│") + ` id ${t.id} · ${t.age} · preview mock`.padEnd(innerW + 2).slice(0, innerW + 2) + theme.fg("dim", "│"));
	lines.push(theme.fg("dim", "│ ") + "".padEnd(innerW) + theme.fg("dim", " │"));
	const row = (label: string, value: string): string =>
		theme.fg("dim", "│ ") + theme.fg("muted", label.padEnd(10)) + value + theme.fg("dim", " │");
	lines.push(
		blockers.length > 0
			? row("waits on", blockers.map((b) => `${b.id} ${theme.fg("dim", b.title)}`).join(" · "))
			: row("waits on", theme.fg("success", "nothing — ready")),
	);
	lines.push(
		unlocks.length > 0
			? row("unlocks", unlocks.map((u) => `${u.id} ${theme.fg("dim", u.title)}`).join(" · "))
			: row("unlocks", theme.fg("dim", "(nothing yet)")),
	);
	lines.push(row("context", theme.fg("dim", `session 01a03552 · DESIGN.md §Todo`)));
	lines.push(theme.fg("dim", "└" + "─".repeat(innerW + 2) + "┘"));
	lines.push("");
	lines.push(theme.fg("dim", " ⌫ back · (preview · mock data)"));
	return lines;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("todo", {
		description: "Todo pane (design preview — mock data)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("todo pane preview requires interactive mode", "warning");
				return;
			}
			let cursor = 0;
			let detail = false; // inside the detail card
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				let cachedLines: string[] | undefined;
				const component: Component = {
					render(width: number): string[] {
						let lines = cachedLines;
						if (!lines) {
							lines = detail
								? renderDetail(width, theme, cursor)
								: renderPane(width, theme, cursor);
							cachedLines = lines;
						}
						return lines;
					},
					invalidate(): void {
						cachedLines = undefined;
					},
					handleInput(data: string): void {
						if (detail) {
							// inside: backspace/escape/q pops back to the pane
							if (
								matchesKey(data, Key.backspace) ||
								matchesKey(data, Key.escape) ||
								data === "q"
							) {
								detail = false;
								cachedLines = undefined;
								tui.requestRender();
								return;
							}
							return; // other keys: no-op in the preview detail
						}
						// pane level
						if (matchesKey(data, Key.escape) || data === "q") {
							done();
							return;
						}
						if (matchesKey(data, Key.enter)) {
							detail = true; // enter = into
							cachedLines = undefined;
							tui.requestRender();
							return;
						}
						if (
							matchesKey(data, Key.left) ||
							matchesKey(data, Key.up) ||
							data === "h" ||
							data === "j"
						) {
							cursor = Math.max(0, cursor - 1);
						}
						if (
							matchesKey(data, Key.right) ||
							matchesKey(data, Key.down) ||
							data === "l" ||
							data === "k"
						) {
							cursor = Math.min(MOCK.length - 1, cursor + 1);
						}
						cachedLines = undefined;
						tui.requestRender();
					},
				};
				return component;
			});
		},
	});
}
