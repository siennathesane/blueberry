/**
 * bb:// deep-link scheme for todo cards.
 *
 * Canonical form: bb://todo/<project-slug>/<hex6>
 * Slug: [a-z0-9-]+, hex6: [0-9a-f]{6}.
 */

import { join, dirname } from "node:path";
import { homedir } from "node:os";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { execSync } from "node:child_process";

export function formatDeeplink(slug: string, hex6: string): string {
  return `bb://todo/${slug}/${hex6}`;
}

export function parseDeeplink(
  url: string,
): { kind: "todo"; slug: string; hex6: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "bb:") return null;
    if (u.hostname !== "todo") return null;
    // pathname is /<slug>/<hex6>
    const parts = u.pathname.replace(/^\//, "").split("/");
    if (parts.length !== 2) return null;
    const [slug, hex6] = parts;
    if (!/^[a-z0-9-]+$/.test(slug)) return null;
    if (!/^[0-9a-f]{6}$/.test(hex6)) return null;
    return { kind: "todo", slug, hex6 };
  } catch {
    return null;
  }
}

export function osc8(text: string, url: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

// --- link capability fallback chain --------------------------------------------

export type LinkCapability = "scheme" | "matcher" | "inline";

/**
 * Probe the current environment for the best available link capability.
 *
 * - "scheme": the bb:// shim is registered (LaunchServices / xdg-mime)
 * - "matcher": Ghostty is the active terminal (env detection)
 * - "inline": no link support — render content in-line
 *
 * All IO is injected for testability.
 */
export function probeLinkCapability(
  env: Record<string, string | undefined> = Deno.env.toObject(),
  opts: { isRegistered?: () => boolean } = {},
): LinkCapability {
  const isRegistered = opts.isRegistered ?? (() => existsSync(shimAppDir(homedir())));
  if (isRegistered()) return "scheme";
  if (
    env["TERM_PROGRAM"] === "ghostty" ||
    env["GHOSTTY_RESOURCES_DIR"] !== undefined
  ) {
    return "matcher";
  }
  return "inline";
}

export interface CardRefInput {
  hex6: string;
  title: string;
  stage: string;
  slug: string;
}

/**
 * Render a card reference according to the detected link capability.
 *
 * - scheme + tty: OSC 8 hyperlink
 * - scheme + no tty: markdown link
 * - matcher: bare bb:// URL (Ghostty's URL matcher catches it)
 * - inline: card summary with show command
 */
export function renderCardRef(
  card: CardRefInput,
  cap: LinkCapability,
  opts: { tty?: boolean } = {},
): string {
  const url = formatDeeplink(card.slug, card.hex6);
  if (cap === "scheme") {
    if (opts.tty) {
      return osc8(`${card.hex6} ${card.title}`, url);
    }
    return `[${card.hex6} ${card.title}](${url})`;
  }
  if (cap === "matcher") {
    return url;
  }
  // inline
  return `${card.hex6} [${card.stage}] ${card.title} (card summary — open with: blueberry todo show ${card.slug} ${card.hex6})`;
}

// --- scheme registration (SYSTEM-INTEGRATION artifacts only) -------------------

/** macOS shim app location: ~/Applications/Blueberry Deep Link.app */
export function shimAppDir(home: string): string {
  return join(home, "Applications", "Blueberry Deep Link.app");
}

/** AppleScript body for the URL handler (on open location). */
export function appleScriptShim(): string {
  return `on open location theURL
  set cmd to "blueberry deeplink open " & quoted form of theURL
  do shell script cmd
end open location
`;
}

/** Minimal Info.plist declaring the bb:// URL scheme. */
export function shimInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>bb</string>
      </array>
      <key>CFBundleURLName</key>
      <string>com.blueberry.deeplink</string>
    </dict>
  </array>
  <key>CFBundleExecutable</key>
  <string>Blueberry Deep Link</string>
  <key>CFBundleName</key>
  <string>Blueberry Deep Link</string>
  <key>CFBundleDisplayName</key>
  <string>Blueberry Deep Link</string>
  <key>CFBundleIdentifier</key>
  <string>com.blueberry.deeplink</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;
}

/** Linux .desktop entry declaring the bb:// scheme handler. */
export function desktopEntry(): string {
  return `[Desktop Entry]
Type=Application
Name=Blueberry Deep Link
Exec=blueberry deeplink open %u
MimeType=x-scheme-handler/bb;
NoDisplay=true
`;
}

export interface RegisterOpts {
  write?: (path: string, content: string) => void;
  run?: (cmd: string) => void;
  read?: (path: string) => string | null;
  chmod?: (path: string) => void;
}

export interface UnregisterOpts {
  remove?: (path: string) => void;
  run?: (cmd: string) => void;
}

const defaultRead = (path: string): string | null => {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};

const defaultWrite = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const defaultChmod = (path: string) => {
  chmodSync(path, 0o755);
};

const defaultRun = (cmd: string) => {
  execSync(cmd, { stdio: "ignore" });
};

const defaultRemove = (path: string) => {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
};

/**
 * Register the bb:// URL scheme handler.
 * All filesystem and subprocess operations go through injected opts.
 */
export function registerScheme(
  home: string,
  platform: string,
  opts: RegisterOpts = {},
): { ok: boolean; detail: string } {
  const wr = opts.write ?? defaultWrite;
  const rn = opts.run ?? defaultRun;
  const rd = opts.read ?? defaultRead;
  const cm = opts.chmod ?? defaultChmod;

  switch (platform) {
    case "darwin": {
      const dir = shimAppDir(home);
      const launcherPath = join(dir, "Contents", "MacOS", "Blueberry Deep Link");
      const launcher =
        `#!/bin/sh\nexec osascript "${join(dir, "Contents", "Resources", "main.scpt")}" "$@"\n`;

      // idempotent: if launcher matches, skip writes
      const existing = rd(launcherPath);
      if (existing !== launcher) {
        wr(launcherPath, launcher);
        cm(launcherPath);
        wr(join(dir, "Contents", "Info.plist"), shimInfoPlist());
        wr(
          join(dir, "Contents", "Resources", "main.applescript"),
          appleScriptShim(),
        );
      }

      // compile AppleScript
      const srcPath = join(dir, "Contents", "Resources", "main.applescript");
      const scptPath = join(dir, "Contents", "Resources", "main.scpt");
      let osacompileOk = true;
      try {
        rn(`osacompile -o "${scptPath}" "${srcPath}"`);
      } catch {
        osacompileOk = false;
      }
      if (!osacompileOk) {
        return {
          ok: false,
          detail: "osacompile not available — cannot compile AppleScript shim",
        };
      }

      // register with LaunchServices
      try {
        rn(`open -a "${dir}"`);
      } catch {
        // non-fatal
      }

      return { ok: true, detail: "registered bb:// scheme (macOS shim app)" };
    }

    case "linux": {
      const desktopPath = join(
        home,
        ".local",
        "share",
        "applications",
        "blueberry-deeplink.desktop",
      );
      wr(desktopPath, desktopEntry());
      let xdgOk = true;
      try {
        rn(
          `xdg-mime default blueberry-deeplink.desktop x-scheme-handler/bb`,
        );
      } catch {
        xdgOk = false;
      }
      if (!xdgOk) {
        return {
          ok: false,
          detail: "xdg-mime not available — cannot register scheme handler on Linux",
        };
      }
      return { ok: true, detail: "registered bb:// scheme (Linux .desktop)" };
    }

    case "win32":
      return {
        ok: false,
        detail: "windows registration not implemented — easy path pending",
      };

    default:
      return {
        ok: false,
        detail: `unknown platform '${platform}'`,
      };
  }
}

/**
 * Unregister the bb:// URL scheme handler.
 * All filesystem and subprocess operations go through injected opts.
 */
export function unregisterScheme(
  home: string,
  platform: string,
  opts: UnregisterOpts = {},
): { ok: boolean; detail: string } {
  const rm = opts.remove ?? defaultRemove;
  const rn = opts.run ?? defaultRun;

  switch (platform) {
    case "darwin": {
      const dir = shimAppDir(home);
      rm(dir);
      return {
        ok: true,
        detail: "unregistered bb:// scheme (removed macOS shim app)",
      };
    }
    case "linux": {
      const desktopPath = join(
        home,
        ".local",
        "share",
        "applications",
        "blueberry-deeplink.desktop",
      );
      rm(desktopPath);
      try {
        rn(`xdg-mime uninstall --mode user blueberry-deeplink.desktop`);
      } catch {
        // xdg-mime not available; removal of file is still ok
      }
      return {
        ok: true,
        detail: "unregistered bb:// scheme (removed Linux .desktop)",
      };
    }
    case "win32":
      return {
        ok: false,
        detail: "windows registration not implemented — easy path pending",
      };
    default:
      return { ok: false, detail: `unknown platform '${platform}'` };
  }
}
