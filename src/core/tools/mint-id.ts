/**
 * blueberry id minter — bb_mint_id (design 006 §The id minter).
 *
 * Mints a collision-free hex6 design id from the lifecycle registry and
 * registers it immediately. Use when writing acceptance tests or requirement
 * patches that need an id the design never minted.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { openDb } from "../db.ts";
import { mintId, registerId } from "../lifecycle.ts";

function agentDir(): string {
  return process.env["PI_CODING_AGENT_DIR"] ?? "";
}

/** Pure helper: mint + register in one call. Exported for testing. */
export function mintAndRegister(
  db: import("node:sqlite").DatabaseSync,
  note?: string,
): { id: string } {
  const id = mintId(db);
  registerId(db, id, {
    designDoc: "(out-of-band)",
    paragraph: note ?? "(minted via bb_mint_id)",
  });
  return { id };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "bb_mint_id",
    label: "Mint id",
    description:
      "Mint a collision-free [hex6] design id from the lifecycle registry. " +
      "Call this when writing an acceptance test or a requirement patch that " +
      "needs an id the design never minted — never hand-pick hex strings.",
    promptSnippet:
      "Mint a collision-free design id for acceptance tests and requirement patches",
    promptGuidelines: [
      "Use bb_mint_id whenever a test or patch needs a design id — never hand-pick a hex string.",
    ],
    parameters: Type.Object({
      note: Type.Optional(
        Type.String({ description: "recorded with the id in the registry" }),
      ),
    }),
    // deno-lint-ignore require-await
    async execute(_toolCallId, params) {
      const dir = agentDir();
      if (dir === "") {
        throw new Error("PI_CODING_AGENT_DIR not set — launch via bb");
      }
      const db = openDb(dir);
      try {
        const { id } = mintAndRegister(db, params.note as string | undefined);
        return {
          content: [
            {
              type: "text",
              text:
                `minted [${id}] — registered in the lifecycle registry. Note: ` +
                `requirement paragraphs normally mint at design-decide time; ` +
                `out-of-band ids are exceptional.`,
            },
          ],
          details: { id, note: params.note ?? null },
        };
      } finally {
        db.close();
      }
    },
  });
}
