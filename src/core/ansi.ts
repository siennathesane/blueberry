/**
 * ANSI-aware string measurement and padding.
 *
 * Terminal escape sequences are zero-width; String.prototype.padEnd/truncate
 * count them, which misaligns any colored column layout. Everything that
 * renders colored columns goes through these.
 */
// deno-lint-ignore no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Visible width of a string (escape sequences count as zero). */
export function visibleWidth(s: string): number {
	return s.replace(ANSI, "").length;
}

/** Strip all escape sequences. */
export function stripAnsi(s: string): string {
	return s.replace(ANSI, "");
}

/** Pad on the right to a visible width. */
export function padEndVisible(s: string, width: number, pad = " "): string {
	const w = visibleWidth(s);
	if (w >= width) return s;
	return s + pad.repeat(width - w);
}

/**
 * Truncate to a visible width, preserving any leading escape sequence so a
 * colored glyph keeps its color. Content is truncated from the plain text;
 * colors inside the cut region are dropped.
 */
export function truncateVisible(
	s: string,
	maxWidth: number,
	ellipsis = "…",
): string {
	const plain = stripAnsi(s);
	if (plain.length <= maxWidth) return s;
	// deno-lint-ignore no-control-regex
	const lead = /^\x1b\[[0-9;]*[A-Za-z]/.exec(s);
	const keep = Math.max(0, maxWidth - ellipsis.length);
	const body = plain.slice(0, keep) + ellipsis;
	return (lead ? lead[0] : "") + body;
}

/** Center a string in a visible width (left-biased). */
export function centerVisible(s: string, width: number): string {
	const w = visibleWidth(s);
	if (w >= width) return s;
	const left = Math.floor((width - w) / 2);
	return " ".repeat(left) + s + " ".repeat(width - w - left);
}
