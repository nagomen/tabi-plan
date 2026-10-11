import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createDebtShareToken, debtShareTokenHash, isDebtShareToken } from "../dist/debt-share-token.js";

test("返済共有トークンは256 bitで、DBには同じ長さのハッシュだけを保存する", () => {
  const first = createDebtShareToken();
  const second = createDebtShareToken();
  assert.equal(first.length, 43);
  assert.equal(isDebtShareToken(first), true);
  assert.notEqual(first, second);
  assert.equal(debtShareTokenHash(first).length, 32);
  assert.equal(debtShareTokenHash(first).equals(debtShareTokenHash(first)), true);
  assert.equal(debtShareTokenHash(first).equals(debtShareTokenHash(second)), false);
  assert.equal(isDebtShareToken("short-token"), false);
});

test("閲覧APIはメールアドレスを選択せず、PDFも同じ共有トークンで保護する", async () => {
  const source = await readFile(new URL("../src/debt-share-repo.ts", import.meta.url), "utf8");
  const publicSelect = source.match(/SELECT p\.borrower_name[\s\S]*?LIMIT 1/)?.[0] || "";
  assert.ok(publicSelect);
  assert.equal(publicSelect.includes("borrower_email"), false);
  assert.equal(publicSelect.includes("creditor_email"), false);
  assert.match(source, /loadSharedDebtPdf/);
  assert.match(source, /l\.token_hash = \?/);
  assert.match(source, /l\.revoked_at IS NULL/);
});
