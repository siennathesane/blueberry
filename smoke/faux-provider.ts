/**
 * Hermetic smoke provider — release pipeline only (bin/compile.sh).
 *
 * Registers pi's deterministic faux provider with one scripted reply so the
 * DB-only persistence proof needs no network, no credentials, and no ambient
 * env (the auth-stub approach failed on CI: an invalid key aborts before the
 * agent loop persists anything; faux always completes).
 *
 * Invoked by the compiled binary itself, which doubles as the proof that
 * extension loading (jiti) works in `deno compile` binaries:
 *
 *   blueberry --extension <this file> --model faux/faux-1 -p "..."
 *
 * Imports are relative to the fork sources on disk (the smoke always runs
 * from a checkout; no node_modules resolution involved).
 */
import {
 fauxAssistantMessage,
 fauxProvider,
} from "../pi/packages/ai/src/providers/faux.ts";
import type { ExtensionAPI } from "../pi/packages/coding-agent/src/core/extensions/types.ts";

export default function (pi: ExtensionAPI): void {
 const handle = fauxProvider({
  models: [
   {
    id: "faux-1",
    name: "Faux Smoke Model",
    reasoning: false,
    input: ["text"],
   },
  ],
 });
 handle.setResponses([fauxAssistantMessage("compile-smoke-ok")]);
 pi.registerProvider(handle.provider);
}
