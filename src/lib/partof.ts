// Tools merged into a hub app (`part_of` in the tool list). Theme lists hide them and
// show them on the hub's row as "Includes: ..."; everything else (start, stop, health,
// process attribution) still treats them as their own tool.
// Only `import type` here: tests/partof.test.ts runs this file straight under Node.
import type { Tool } from "./types";

/**
 * The top hub a tool is merged into, following part_of up the chain.
 * Undefined when the tool isn't merged, or its link is broken (unknown id, itself, a loop),
 * so a bad entry shows up as a normal row instead of vanishing.
 */
export function hubOf(t: Tool, byId: Map<string, Tool>): Tool | undefined {
  let hub: Tool | undefined;
  const seen = new Set([t.id]);
  let id = t.part_of;
  while (id) {
    if (seen.has(id)) return undefined;
    const next = byId.get(id);
    if (!next) return undefined;
    seen.add(id);
    hub = next;
    id = next.part_of;
  }
  return hub;
}

export const toolMap = (tools: Tool[]) => new Map(tools.map((t) => [t.id, t]));

/** Tools that get their own row: everything not merged into a hub. */
export function listedTools(tools: Tool[]): Tool[] {
  const byId = toolMap(tools);
  return tools.filter((t) => !hubOf(t, byId));
}

/** Tools merged into this hub (including ones merged into those), in tool-list order. */
export function includedIn(hub: Tool, tools: Tool[]): Tool[] {
  const byId = toolMap(tools);
  return tools.filter((t) => t.id !== hub.id && hubOf(t, byId)?.id === hub.id);
}
