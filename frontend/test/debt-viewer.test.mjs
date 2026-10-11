import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("返済共有ページはhidden属性をCSSのdisplay指定より優先する", () => {
  const css = readFileSync(new URL("../src/debt/style.css", import.meta.url), "utf8");
  assert.match(css, /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/);
});
