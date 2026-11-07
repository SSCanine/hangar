// Run: npm test (Node's own test runner; Node 22.18+ runs .ts files directly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hubOf, includedIn, listedTools, toolMap } from "../src/lib/partof.ts";
import type { Tool } from "../src/lib/types.ts";

const tool = (id: string, part_of?: string): Tool =>
  ({ id, name: id.toUpperCase(), theme: "image", description: "", kind: "web", embed: true, stoppable: true, gpu: false, part_of }) as Tool;

const ids = (ts: Tool[]) => ts.map((t) => t.id);

test("merged tools leave the theme list and show on their hub", () => {
  const tools = [tool("slop"), tool("render", "slop"), tool("atlas", "slop"), tool("swap")];
  assert.deepEqual(ids(listedTools(tools)), ["slop", "swap"]);
  assert.deepEqual(ids(includedIn(tools[0], tools)), ["render", "atlas"]);
  assert.deepEqual(includedIn(tools[3], tools), []);
  assert.equal(hubOf(tools[1], toolMap(tools))?.id, "slop");
  assert.equal(hubOf(tools[0], toolMap(tools)), undefined);
});

test("a chain lists under the top hub", () => {
  const tools = [tool("hub"), tool("mid", "hub"), tool("leaf", "mid")];
  assert.deepEqual(ids(listedTools(tools)), ["hub"]);
  assert.deepEqual(ids(includedIn(tools[0], tools)), ["mid", "leaf"]);
  assert.deepEqual(includedIn(tools[1], tools), []);
});

test("broken links keep the tool visible", () => {
  const tools = [tool("self", "self"), tool("orphan", "gone"), tool("a", "b"), tool("b", "a"), tool("empty", "")];
  assert.deepEqual(ids(listedTools(tools)), ["self", "orphan", "a", "b", "empty"]);
  for (const t of tools) assert.deepEqual(includedIn(t, tools), []);
});
