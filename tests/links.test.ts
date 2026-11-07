// Run: npm test (Node's own test runner; Node 22.18+ runs .ts files directly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { externalHref } from "../src/lib/links.ts";

test("web and mail links go to the browser", () => {
  assert.equal(externalHref("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(externalHref("http://127.0.0.1:4321/"), "http://127.0.0.1:4321/");
  assert.equal(externalHref("mailto:a@example.com"), "mailto:a@example.com");
});

test("everything else is not followed", () => {
  for (const href of [undefined, null, "", "docs/x.md", "/x", "#top", "javascript:alert(1)", "file:///C:/Windows/System32/calc.exe", "ms-settings:", "search-ms:query=x", "hangar://chat/x"]) {
    assert.equal(externalHref(href), null, String(href));
  }
});
