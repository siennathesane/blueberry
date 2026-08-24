/**
 * blueberry core — identity and small behaviors.
 *
 * Currently: minimal branding so you can see blueberry is alive.
 * Planned (see DESIGN.md): custom startup header, footer identity.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const VERSION = "0.1.0";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.notify(`🫐 blueberry v${VERSION} — with orange juice`, "info");
    }
  });
}
