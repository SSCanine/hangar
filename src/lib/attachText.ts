// How attached files are written into a chat message (same block as the phone page's attachBlock).

/** The message as Claude gets it: the text, then one line per attached path. */
export function attachBlock(text: string, paths: string[]): string {
  const t = text.trim();
  if (!paths.length) return t;
  const block = "Attached files:\n" + paths.map((p) => `- ${p}`).join("\n");
  return t ? `${t}\n\n${block}` : block;
}

/** Last part of a Windows or POSIX path. */
export const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
export const isImage = (p: string) => IMAGE.test(p);
