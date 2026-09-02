import test from "node:test";
import assert from "node:assert/strict";

process.env.API_TOKEN ||= "test-api-token";
process.env.SESSION_SECRET ||= "test-session-secret-0123456789-abcdef";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { BadRequest, VersionConflict, describeError } = await import("../dist/errors.js");
const { rateLimitCheck, rateLimited } = await import("../dist/rate-limit.js");
const { paidOnOrNull, computeAmounts } = await import("../dist/expense-repo.js");

const withCode = (code) => Object.assign(new Error(code), { code });

test("業務エラーと衝突は利用者向けの契約（message/action）へ変換される", () => {
  const bad = describeError(new BadRequest("入力が正しくありません"), "req1");
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "bad_request");
  assert.equal(bad.body.message, "入力が正しくありません");
  assert.equal(bad.body.action, "revise_input");

  const conflict = describeError(new VersionConflict("計画が別の端末で更新されています", 7), "req1");
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, "plan_version_conflict");
  assert.equal(conflict.body.action, "reload");
  assert.equal(conflict.body.current_version, 7);

  const dup = describeError(withCode("ER_DUP_ENTRY"), "req1");
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, "ER_DUP_ENTRY", "slug衝突の自動リトライが使うコードを維持する");
});

test("DBの一時障害・接続断は再試行可能な503として返す", () => {
  const deadlock = describeError(withCode("ER_LOCK_DEADLOCK"), "req1");
  assert.equal(deadlock.status, 503);
  assert.equal(deadlock.body.error, "server_busy");
  assert.equal(deadlock.body.retryable, true);
  assert.ok(deadlock.body.retry_after > 0);

  const down = describeError(withCode("ECONNREFUSED"), "req1");
  assert.equal(down.status, 503);
  assert.equal(down.body.error, "db_unavailable");
  assert.equal(down.body.retryable, true);

  const queue = describeError(new Error("Queue limit reached"), "req1");
  assert.equal(queue.status, 503);
  assert.equal(queue.body.error, "db_unavailable");
});

test("不正入力由来のDBエラーは500ではなく400として説明する", () => {
  for (const code of ["ER_DATA_TOO_LONG", "ER_TRUNCATED_WRONG_VALUE", "ER_WARN_DATA_OUT_OF_RANGE"]) {
    const result = describeError(withCode(code), "req1");
    assert.equal(result.status, 400, code);
    assert.equal(result.body.action, "revise_input");
  }
  assert.equal(describeError(new Error("PAYLOAD_TOO_LARGE"), "r").status, 413);
  assert.equal(describeError(new Error("INVALID_JSON"), "r").status, 400);
});

test("想定外のエラーは内部情報を出さず、問い合わせ番号だけ返す", () => {
  const secret = new Error("connect ECONNREFUSED db-user@10.0.0.5:3306 password=xyz");
  const result = describeError(secret, "req_abc");
  // 「接続断コード付き」ではない生メッセージは 500 契約に落ちる
  assert.equal(result.status, 500);
  assert.equal(result.body.request_id, "req_abc");
  assert.ok(!JSON.stringify(result.body).includes("10.0.0.5"));
  assert.ok(!JSON.stringify(result.body).includes("password"));
});

test("レート制限は拒否時に窓の残り秒数を返す", () => {
  const buckets = new Map();
  const now = 1_000_000;
  assert.equal(rateLimitCheck(buckets, "ip", 2, now), 0);
  assert.equal(rateLimitCheck(buckets, "ip", 2, now + 1000), 0);
  const wait = rateLimitCheck(buckets, "ip", 2, now + 2000);
  assert.ok(wait >= 1 && wait <= 60, `残り秒数を返す: ${wait}`);
  // 窓が切り替わればまた通る
  assert.equal(rateLimitCheck(buckets, "ip", 2, now + 61_000), 0);
  // 既存の boolean 版も同じ判定を返す
  assert.equal(rateLimited(buckets, "ip2", 1, now), false);
  assert.equal(rateLimited(buckets, "ip2", 1, now + 1), true);
});

test("支払日と換算レートはDBに届く前に検証される", () => {
  assert.equal(paidOnOrNull(""), null);
  assert.equal(paidOnOrNull("2026-10-09"), "2026-10-09");
  assert.throws(() => paidOnOrNull("10/09/2026"), /支払日/);
  assert.throws(() => paidOnOrNull("次の金曜"), /支払日/);

  assert.deepEqual(computeAmounts({ amount_minor: 1000 }), { amount: 1000, rate: 1, base: 1000 });
  assert.throws(() => computeAmounts({ amount_minor: 100, fx_rate: Infinity }), /換算レート/);
  assert.throws(() => computeAmounts({ amount_minor: 100, fx_rate: 0 }), /換算レート/);
  assert.throws(() => computeAmounts({ amount_minor: 100, fx_rate: -2 }), /換算レート/);
});
