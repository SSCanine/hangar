// Claude Code stores a pasted message in the transcript wrapped as
//   <pasted_content id="N">\n...the text...\n</pasted_content id="N">
// The chat shows it without the wrapper, and the outbox must match it against what was typed
// (which never had the wrapper), or a "Sent" bubble stays pinned under every later message.

const TAG = /<\/?pasted_content(?:\s+id="[^"]*")?>/g;

/** The message as typed: pasted-content wrapper tags removed, outer whitespace trimmed. */
export function stripPasted(text: string): string {
  return text.replace(TAG, "").trim();
}

/** Key for "is this transcript message the one that was typed": no wrapper, whitespace collapsed. */
export function messageKey(text: string): string {
  return stripPasted(text).replace(/\s+/g, " ");
}

/** How many user messages in the transcript are the typed text. */
export function countSaid(messages: { role: string; text: string }[], typed: string): number {
  const k = messageKey(typed);
  return messages.filter((m) => m.role === "user" && messageKey(m.text) === k).length;
}
