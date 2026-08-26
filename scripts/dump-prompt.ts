/**
 * scripts/dump-prompt.ts — render the CURRENT composed system prompt.
 *
 * Composes exactly what a live session builds: the fork's buildSystemPrompt
 * with the real extension surfaces (snippets + guidelines extracted from the
 * tool sources) and blueberry's Rail-1 identity, all probe options ENABLED
 * (lsp installed, design lifecycle present, todos exist).
 *
 * Run:  env -u BLUEBERRY_DB deno run -A --config deno.json scripts/dump-prompt.ts
 *
 * To preview a FUTURE prompt (before landing prompt changes), edit the probe
 * or append candidate sections to `identity` below — this script is a canvas,
 * not a snapshot: it always composes from the live sources.
 */
import { buildSystemPrompt } from "../pi/packages/coding-agent/src/core/system-prompt.ts";
import { composeIdentity } from "../src/core/context-composer.ts";

/** Extract promptSnippet/promptGuidelines from a tool source file. */
function surfacesOf(path: string): { snippets: string[]; guidelines: string[] } {
	const src = Deno.readTextFileSync(path);
	const snippets: string[] = [];
	const guidelines: string[] = [];
	for (const m of src.matchAll(/promptSnippet:\s*"((?:[^"\\]|\\.)*)"/g)) {
		if (!snippets.includes(m[1]!)) snippets.push(m[1]!);
	}
	const g = /promptGuidelines:\s*\[([\s\S]*?)\]/.exec(src);
	if (g) {
		for (const q of g[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
			if (!guidelines.includes(q[1]!)) guidelines.push(q[1]!);
		}
	}
	return { snippets, guidelines };
}

const TOOL_SOURCES = [
	"src/core/tools/search.ts",
	"extensions/library/index.ts",
	"extensions/lsp/index.ts",
	"extensions/todo/index.ts",
];

const snippets: string[] = [];
const guidelines: string[] = [];
for (const src of TOOL_SOURCES) {
	const s = surfacesOf(src);
	snippets.push(...s.snippets.filter((x) => !snippets.includes(x)));
	guidelines.push(...s.guidelines.filter((x) => !guidelines.includes(x)));
}

// probe: everything enabled — the maximal prompt
const identity = composeIdentity({
	cwd: Deno.cwd(),
	lspLanguages: ["typescript"],
	hasDesignLifecycle: true,
	hasTodos: true,
});

const prompt = buildSystemPrompt({
	cwd: Deno.cwd(),
	selectedTools: ["bash", "edit", "write", "read", "grep", "find", "ls"],
	toolSnippets: snippets,
	promptGuidelines: guidelines,
	appendSystemPrompt: identity,
});

console.log(prompt);
