/**
 * UI tests for the todo pane: alignment invariants and interaction behavior.
 *
 * The pane module is pure and theme-injected; tests use an identity theme
 * (fg/bold are no-ops) so geometry checks are exact, and a color-emitting
 * theme to prove alignment survives ANSI codes — the original misalignment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyInput,
	CLOSED,
	columnItems,
	layoutFor,
	renderDetail,
	renderPane,
	renderTodoPane,
	visibleCells,
	type PaneState,
	type PaneTheme,
	type TodoCard,
} from "../src/core/todo-pane.ts";
import { stripAnsi, visibleWidth } from "../src/core/ansi.ts";

const identity: PaneTheme = {
	fg: (_c, s) => s,
	bold: (s) => s,
};

/** Theme that emits real ANSI codes — alignment must survive these. */
const colored: PaneTheme = {
	fg: (c, s) =>
		`\x1b[${c === "accent" ? 35 : c === "success" ? 32 : c === "warning" ? 33 : 90}m${s}\x1b[0m`,
	bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const CARDS: TodoCard[] = [
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
		id: "7i5j9k",
		title: "plan file format",
		stage: "todo",
		age: "new",
		ready: true,
	},
	{
		id: "1k2l3m",
		title: "tool gate",
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

const WIDTH = 100;

// --- layout contract ---------------------------------------------------------

test("layout: offsets are monotonic, evenly gapped, within width", () => {
	for (const w of [60, 80, 100, 140, 200]) {
		const { colW, offsets } = layoutFor(w);
		assert.ok(colW >= 12, `colW >= 12 at width ${w}`);
		for (let i = 1; i < offsets.length; i++) {
			assert.equal(
				offsets[i]! - offsets[i - 1]!,
				colW + 2,
				`gap constant at width ${w} col ${i}`,
			);
		}
		assert.ok(
			offsets[offsets.length - 1]! + colW <= w,
			`columns fit in width ${w}`,
		);
	}
});

// --- alignment invariants (the regression test for the misalignment) ----------

test("pane: every data row starts columns at the exact layout offsets (ANSI-colored)", () => {
	const { offsets } = layoutFor(WIDTH);
	const lines = renderPane(WIDTH, colored, CARDS, { cursor: 3, detail: false });

	// data rows begin after header(2) + column header + divider
	const dataRows = lines
		.slice(3)
		.filter((l) => stripAnsi(l).includes("◉") || /[▣▧✓◷]/.test(stripAnsi(l)));
	assert.ok(dataRows.length > 0, "found data rows");

	for (const row of dataRows) {
		assert.ok(
			visibleWidth(row) <= WIDTH,
			`row within width: '${stripAnsi(row).slice(0, 30)}' ${visibleWidth(row)}`,
		);
		// each column's cell is exactly colW wide: chars at offset+colW are the gap
		for (let i = 0; i < offsets.length - 1; i++) {
			const plain = stripAnsi(row);
			const gapStart = offsets[i + 1]! - 2;
			assert.equal(
				plain.slice(gapStart, offsets[i + 1]!),
				"  ",
				`gap before column ${i + 1} is blank at '${plain.slice(gapStart, gapStart + 6)}'`,
			);
		}
	}
});

test("pane: identity and colored renders have identical plain text", () => {
	const a = renderPane(WIDTH, identity, CARDS, { cursor: 0, detail: false }).map(
		stripAnsi,
	);
	const b = renderPane(WIDTH, colored, CARDS, { cursor: 0, detail: false }).map(
		stripAnsi,
	);
	assert.deepEqual(a, b, "coloring never changes content or geometry");
});

test("pane: header row counts match data (per-stage totals)", () => {
	const lines = renderPane(WIDTH, identity, CARDS, { cursor: 0, detail: false });
	const header = lines[2]!;
	assert.ok(header.includes("todo 6"), "todo count");
	assert.ok(header.includes("doing 1/5"), "doing count + cap");
	assert.ok(header.includes("review 2"), "review count");
	assert.ok(header.includes("done 3"), "done count");
	// summary line
	assert.ok(lines[0]!.includes("3/12 done · 2 ready · 4 blocked"));
});

test("pane: exactly one cursor marker, on the cursor row", () => {
	const lines = renderPane(WIDTH, identity, CARDS, { cursor: 4, detail: false });
	const marked = lines.filter((l) => l.includes("▸"));
	assert.equal(marked.length, 1, "one marked row");
	// flat cell 4 = first todo item (doing column has 1 card, review 2) → 3rd data row region
	const cell = visibleCells(CARDS)[4]!;
	assert.ok(marked[0]!.includes(cell.title), "marker on the cursor task");
});

test("pane: todo column orders ready-first; review orders oldest-first; done caps at 4", () => {
	const todo = columnItems(CARDS, "todo").map((c) => c.ready ?? false);
	assert.deepEqual(
		todo,
		[true, true, false, false, false, false],
		"ready cards first",
	);

	const review = columnItems(CARDS, "review").map((c) => c.age);
	assert.deepEqual(review, ["1d", "2h"], "1d (older) before 2h");

	const many: TodoCard[] = Array.from({ length: 9 }, (_, i) => ({
		id: `d${i}`,
		title: `done ${i}`,
		stage: "done" as const,
		age: "1d",
	}));
	assert.equal(columnItems(many, "done").length, 4, "done column capped");
});

test("pane: overflow indicators appear when a column exceeds MAX_ROWS", () => {
	const many: TodoCard[] = Array.from({ length: 11 }, (_, i) => ({
		id: `x${i}`,
		title: `task ${i}`,
		stage: "todo" as const,
		age: "new",
	}));
	const lines = renderPane(WIDTH, identity, many, { cursor: 0, detail: false });
	assert.ok(
		lines.some((l) => l.includes("+3 todo")),
		"overflow count shown",
	);
});

test("pane: rows never exceed width even with long titles", () => {
	const long: TodoCard[] = [
		{ id: "aa0001", title: "x".repeat(80), stage: "todo", age: "new" },
		{ id: "aa0002", title: "y".repeat(80), stage: "doing", age: "9h" },
	];
	for (const w of [60, 100]) {
		const lines = renderPane(w, colored, long, { cursor: 0, detail: false });
		for (const l of lines) {
			assert.ok(
				visibleWidth(l) <= w,
				`width ${w}: '${stripAnsi(l).slice(0, 20)}' is ${visibleWidth(l)}`,
			);
		}
	}
});

// --- detail card ---------------------------------------------------------------

test("detail: box rows are width-exact and show waits-on/unlocks", () => {
	const flat = visibleCells(CARDS);
	const idx = flat.findIndex((c) => c.id === "1k2l3m"); // blocked card
	const lines = renderDetail(WIDTH, colored, CARDS, {
		cursor: idx,
		detail: true,
	});

	const boxRows = lines.filter((l) => l.includes("│"));
	assert.ok(boxRows.length >= 4, "box has content rows");
	for (const row of boxRows) {
		assert.equal(
			visibleWidth(row),
			visibleWidth(boxRows[0]!),
			`box row width uniform: '${stripAnsi(row).slice(0, 24)}'`,
		);
	}
	const joined = lines.join("\n");
	assert.ok(joined.includes("7i5j9k"), "blocker id shown");
	// unlocks direction: 5e8f31 unlocks two cards; a true leaf shows (nothing yet)
	const readyIdx = flat.findIndex((c) => c.id === "5e8f31");
	const readyCard = renderDetail(WIDTH, identity, CARDS, {
		cursor: readyIdx,
		detail: true,
	}).join("\n");
	assert.ok(readyCard.includes("nothing — ready"), "ready card shows ready");
	assert.ok(readyCard.includes("3b9k77"), "unlocks lists dependents");
	const leafIdx = flat.findIndex((c) => c.id === "3b9k77");
	const leafCard = renderDetail(WIDTH, identity, CARDS, {
		cursor: leafIdx,
		detail: true,
	}).join("\n");
	assert.ok(
		leafCard.includes("(nothing yet)"),
		"leaf card shows nothing unlocks",
	);
	// a done/unblocked card shows ready state without blockers row noise
	const doingIdx = flat.findIndex((c) => c.id === "9f3a2c");
	const doingCard = renderDetail(WIDTH, identity, CARDS, {
		cursor: doingIdx,
		detail: true,
	}).join("\n");
	assert.ok(doingCard.includes("nothing — ready"), "unblocked card shows ready");
	assert.ok(doingCard.includes("8q9r0s"), "doing card unlocks its dependent");
});

test("detail: renders (no task) for empty board", () => {
	const lines = renderDetail(WIDTH, identity, [], { cursor: 0, detail: true });
	assert.deepEqual(lines, ["(no task)"]);
});

// --- state machine -------------------------------------------------------------

test("input: arrows clamp, enter goes in, back comes out, close closes", () => {
	const cells = visibleCells(CARDS).length;
	let s: PaneState | typeof CLOSED = { cursor: 0, detail: false };

	s = applyInput(s as PaneState, "next", cells);
	assert.deepEqual(s, { cursor: 1, detail: false });

	s = applyInput(s as PaneState, "prev", cells);
	assert.deepEqual(s, { cursor: 0, detail: false });
	s = applyInput(s as PaneState, "prev", cells); // clamps at 0
	assert.deepEqual(s, { cursor: 0, detail: false });

	s = applyInput(s as PaneState, "next", cells);
	s = applyInput(s as PaneState, "enter", cells);
	assert.deepEqual(s, { cursor: 1, detail: true });

	s = applyInput(s as PaneState, "next", cells); // moving while in detail pops out and moves
	assert.deepEqual(s, { cursor: 2, detail: false });

	s = applyInput(s as PaneState, "enter", cells);
	s = applyInput(s as PaneState, "back", cells); // backspace pops to pane
	assert.deepEqual(s, { cursor: 2, detail: false });

	s = applyInput(s as PaneState, "enter", cells);
	s = applyInput(s as PaneState, "close", cells); // close from detail → pane
	assert.deepEqual(s, { cursor: 2, detail: false });

	const closed = applyInput(s as PaneState, "close", cells); // close from pane → CLOSED
	assert.equal(closed, CLOSED);

	// back at pane level is a no-op
	s = applyInput(s as PaneState, "back", cells);
	assert.deepEqual(s, { cursor: 2, detail: false });
});

test("input: last-cell clamp and empty-board behavior", () => {
	const cells = visibleCells(CARDS).length;
	let s: PaneState = { cursor: cells - 1, detail: false };
	s = applyInput(s, "next", cells) as PaneState;
	assert.equal(s.cursor, cells - 1, "clamped at last cell");

	// empty board: enter does nothing, prev/next stay at 0
	let e: PaneState | typeof CLOSED = { cursor: 0, detail: false };
	e = applyInput(e as PaneState, "enter", 0) as PaneState;
	assert.deepEqual(e, { cursor: 0, detail: false });
	e = applyInput(e as PaneState, "next", 0) as PaneState;
	assert.deepEqual(e, { cursor: 0, detail: false });
});

test("renderTodoPane dispatches by state", () => {
	const pane = renderTodoPane(WIDTH, identity, CARDS, {
		cursor: 0,
		detail: false,
	});
	const detail = renderTodoPane(WIDTH, identity, CARDS, {
		cursor: 0,
		detail: true,
	});
	assert.ok(pane[0]!.includes("⬡ todos"));
	assert.ok(
		detail.some((l) => l.includes("waits on") || l.includes("(no task)")),
	);
});

test("visibleCells: column-major order matches column composition", () => {
	const cells = visibleCells(CARDS).map((c) => c.id);
	// display order: todo (ready first), doing, review (oldest first), done
	assert.deepEqual(
		cells.slice(0, 2),
		["5e8f31", "7i5j9k"],
		"ready pair leads todo",
	);
	assert.deepEqual(cells.slice(6, 7), ["9f3a2c"], "doing follows");
	assert.deepEqual(
		cells.slice(7, 9),
		["c7d4e9", "a11b02"],
		"review oldest-first",
	);
});
