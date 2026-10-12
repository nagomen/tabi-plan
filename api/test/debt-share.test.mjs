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

process.env.SESSION_SECRET ||= "test-session-secret-0123456789-abcdef";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
const { toSharedDebt } = await import("../dist/debt-share-repo.js");
const { DataIntegrityError, describeError } = await import("../dist/errors.js");

const validRow = () => ({
  borrower_name: "借りた人",
  creditor_name: "貸した人",
  principal_yen: "100000",
  interest_yen: 0,
  total_yen: "100000",
  paid_yen: 20000,
  schedule_json: JSON.stringify([
    { number: 1, due_date: "2026-11-21", amount_yen: 20000, paid_at: "2026-11-20" },
    { number: 2, due_date: "2026-12-21", amount_yen: 0, paid_at: null },
  ]),
  document_json: Buffer.from(JSON.stringify({ submitted_on: "2026-10-01" })),
  updated_at: new Date("2026-10-10T01:02:03Z"),
});

test("返済共有の行は文字列の金額・Buffer の JSON・Date を画面向けの形へそろえる", () => {
  const shared = toSharedDebt(validRow());
  assert.equal(shared.principal_yen, 100000);
  assert.equal(shared.total_yen, 100000);
  assert.equal(shared.schedule.length, 2);
  assert.equal(shared.schedule[1].paid_at, null);
  assert.equal(shared.document.submitted_on, "2026-10-01");
  assert.equal(shared.updated_at, "2026-10-10T01:02:03.000Z");
});

test("壊れた返済データは途中まで返さず data_corrupted(500) にする", () => {
  const cases = [
    { schedule_json: "{壊れたJSON" },
    { schedule_json: JSON.stringify({ not: "array" }) },
    { schedule_json: JSON.stringify([{ number: 1, due_date: "来月", amount_yen: 1 }]) },
    { schedule_json: JSON.stringify([{ number: 1, due_date: "2026-11-21", amount_yen: -5 }]) },
    { schedule_json: null },
    { document_json: JSON.stringify([1, 2]) },
    { total_yen: "abc" },
  ];
  for (const patch of cases) {
    assert.throws(() => toSharedDebt({ ...validRow(), ...patch }), DataIntegrityError, JSON.stringify(patch));
  }
  const described = describeError(new DataIntegrityError("返済計画のデータを読み取れませんでした。"), "req-debt");
  assert.equal(described.status, 500);
  assert.equal(described.body.error, "data_corrupted");
  assert.equal(described.body.retryable, false);
  assert.equal(described.body.action, "contact_support");
  assert.equal(described.body.request_id, "req-debt");
});

test("PDF未登録は無効リンクと区別して案内する", async () => {
  const source = await readFile(new URL("../src/debt-share-repo.ts", import.meta.url), "utf8");
  assert.match(source, /原本PDFはまだ登録されていません/);
});
