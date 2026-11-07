import { test } from "node:test";
import assert from "node:assert/strict";
import { countSaid, messageKey, stripPasted } from "../src/lib/pasted.ts";

const typed = "Report line one\n\nLine two: done\n  indented";
const stored = `  <pasted_content id="1626">\n${typed}\n</pasted_content id="1626">`;

test("the pasted-content wrapper is removed for display", () => {
  assert.equal(stripPasted(stored), typed.trim());
  assert.equal(stripPasted("plain message "), "plain message");
});

test("a wrapped transcript message matches the text that was typed", () => {
  assert.equal(messageKey(stored), messageKey(typed));
  assert.equal(countSaid([{ role: "user", text: stored }], typed), 1);
});

test("assistant messages and different text don't count", () => {
  const msgs = [
    { role: "assistant", text: stored },
    { role: "user", text: "something else" },
    { role: "user", text: stored },
    { role: "user", text: `<pasted_content id="7">\n${typed}\n</pasted_content id="7">` },
  ];
  assert.equal(countSaid(msgs, typed), 2);
});

test("plain (unwrapped) messages still match as before", () => {
  assert.equal(countSaid([{ role: "user", text: "  hi there " }], "hi there"), 1);
});
