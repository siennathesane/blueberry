/**
 * Terminal title interceptor: the transport-level fix for the tab header.
 *
 * pi writes OSC 0 title sequences from 8 internal call sites (including
 * async startup .finally() paths no extension event can observe). Hook-based
 * re-claiming loses that race. Instead we wrap process.stdout.write and
 * rewrite ANY title sequence that isn't ours, at the byte level — pi's
 * writes never reach the terminal as-is.
 *
 * Also rewrites pi's exit resume hint to the blueberry command surface.
 *
 * Pure functions (testable without a real terminal) + one install function.
 */

export interface TitleRewriterOptions {
	/** The title blueberry claims (from identity.terminalTitle). */
	title: string;
}

/** Build the OSC 0 sequence for a title. */
export function titleSequence(title: string): string {
	return `\x1b]0;${title}\x07`;
}

/**
 * Rewrite one stdout chunk: every OSC 0/2 title sequence NOT equal to ours
 * becomes ours. Non-title bytes pass through untouched. Pure.
 */
export function rewriteTitles(chunk: string, ours: string): string {
	if (!chunk.includes("\x1b]")) return chunk;
	const osc = titleSequence(ours);
	// OSC 0;...BEL and OSC 2;...BEL forms
	// deno-lint-ignore no-control-regex
	return chunk.replace(/\x1b\][02];[^\x07]*\x07/g, (match) => {
		return match === osc ? match : osc;
	});
}

/**
 * Rewrite pi's exit resume hint to the blueberry launcher surface.
 * `pi --session-dir <dir> --session <id>` → `bb --session <id>`.
 * Pure.
 */
export function rewriteResumeHint(chunk: string): string {
	if (!chunk.includes("To resume this session:")) return chunk;
	// Tolerates ANSI styling between the label and the command (the fork
	// dims the label: \x1b[2m...\x1b[22m) and PRESERVES --session-dir —
	// custom stores (scratchpad/--here) need it or resume lands in the
	// wrong store. [^\n]*? stays line-bounded so we never over-match.
	return chunk.replace(
		/(?:\x1b\[2m)?To resume this session:[^\n]*?pi (--session-dir \S+ )?--session (\S+)/g,
		"To resume this session: bb $1--session $2",
	);
}

/** Full chunk pipeline: titles + resume hint. Pure. */
export function rewriteChunk(chunk: string, ours: string): string {
	return rewriteResumeHint(rewriteTitles(chunk, ours));
}

/** Minimal writable surface for the interceptor (stream-compatible). */
interface WritableLike {
	write(...args: unknown[]): boolean;
}

const installedStreams = new WeakSet<object>();

/**
 * Install the interceptor on a writable stream (process.stdout in prod,
 * a PassThrough in tests). Returns a restore function. Idempotent per stream
 * (WeakSet marker) so double-install can't double-wrap.
 */
export function installInterceptor(
	stream: WritableLike & object,
	title: string,
): () => void {
	if (installedStreams.has(stream)) return () => {};
	installedStreams.add(stream);
	const orig = stream.write.bind(stream);
	const wrapped = (...args: unknown[]): boolean => {
		const chunk = args[0];
		if (typeof chunk === "string" && chunk.includes("\x1b]")) {
			return orig(rewriteChunk(chunk, title), ...args.slice(1));
		}
		return orig(...args);
	};
	stream.write = wrapped;
	return () => {
		if (stream.write === wrapped) stream.write = orig as WritableLike["write"];
		installedStreams.delete(stream);
	};
}
