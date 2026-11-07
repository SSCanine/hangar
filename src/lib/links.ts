// Links inside rendered markdown (assistant replies, inbox, chats). Hangar's window has
// no address bar or back button, so a plain <a> click would replace Hangar with the linked page
// until a restart. Web and mail links go to the default browser instead; anything else
// (relative paths, file:, custom schemes) is not followed.
// No imports: tests/links.test.ts runs this file straight under Node.

/** The link to hand to the default browser, or null when it should not be followed. */
export function externalHref(href: string | undefined | null): string | null {
  if (!href) return null;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null; // relative: nothing sensible to open from inside Hangar
  }
  return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.href : null;
}
