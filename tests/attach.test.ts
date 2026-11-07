import { test } from "node:test";
import assert from "node:assert/strict";
import { attachBlock, baseName, isImage } from "../src/lib/attachText.ts";

test("no files leaves the message as typed (trimmed)", () => {
  assert.equal(attachBlock("  hello \n", []), "hello");
});

test("files go after the text in the phone page's block", () => {
  assert.equal(attachBlock("look at these", ["C:\\a b\\x.png", "D:\\y.mp4"]), "look at these\n\nAttached files:\n- C:\\a b\\x.png\n- D:\\y.mp4");
});

test("files alone still make a message", () => {
  assert.equal(attachBlock("   ", ["C:\\x.png"]), "Attached files:\n- C:\\x.png");
});

test("names and image check", () => {
  assert.equal(baseName("C:\\Users\\me\\paste-1.png"), "paste-1.png");
  assert.equal(baseName("D:/Projects/notes.md"), "notes.md");
  assert.equal(baseName("C:\\folder\\"), "folder");
  assert.ok(isImage("x.JPG") && isImage("a.webp") && !isImage("a.mp4"));
});
