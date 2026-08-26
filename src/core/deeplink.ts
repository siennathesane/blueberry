/**
 * bb:// deep-link scheme for todo cards.
 *
 * Canonical form: bb://todo/<project-slug>/<hex6>
 * Slug: [a-z0-9-]+, hex6: [0-9a-f]{6}.
 */

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
