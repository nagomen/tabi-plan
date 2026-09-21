import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.SESSION_SECRET ||= "test-session-secret-0123456789-abcdef";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const {
  computeAmounts, normalizeShares, validateShares, validateSettlementAgainstBalances,
} = await import("../dist/expense-repo.js");

test("computeAmounts rounds, applies the fx rate, and rejects non-positive amounts", () => {
  assert.deepEqual(computeAmounts({ amount_minor: 1000 }), { amount: 1000, rate: 1, base: 1000 });
  assert.deepEqual(computeAmounts({ amount_minor: 100, fx_rate: 1.5 }), { amount: 100, rate: 1.5, base: 150 });
  assert.throws(() => computeAmounts({ amount_minor: 0 }), /1以上/);
  assert.throws(() => computeAmounts({ amount_minor: -5 }), /1以上/);
});

test("normalizeShares merges duplicate users and drops empty/non-positive rows", () => {
  assert.deepEqual(
    normalizeShares([
      { user_id: "a", amount_base_minor: 100 },
      { user_id: "a", amount_base_minor: 50 },
      { user_id: "b", amount_base_minor: 0 },
      { user_id: "", amount_base_minor: 10 },
    ]),
    [{ user_id: "a", amount_base_minor: 150 }],
  );
});

const members = new Set(["u1", "u2", "u3"]);

test("validateShares accepts a split whose total equals the payment", () => {
  const result = validateShares(
    { payer_user_id: "u1", split_method: "equal_all", shares: [
      { user_id: "u1", amount_base_minor: 600 },
      { user_id: "u2", amount_base_minor: 400 },
    ] },
    1000,
    members,
  );
  assert.equal(result.splitMethod, "equal_all");
  assert.equal(result.shares.length, 2);
});

test("validateShares rejects a share total that does not equal the payment", () => {
  assert.throws(
    () => validateShares({ payer_user_id: "u1", shares: [{ user_id: "u1", amount_base_minor: 500 }] }, 1000, members),
    /一致していません/,
  );
});

test("validateShares 'none' forbids any shares", () => {
  assert.doesNotThrow(() => validateShares({ payer_user_id: "u1", split_method: "none", shares: [] }, 1000, members));
  assert.throws(
    () => validateShares({ payer_user_id: "u1", split_method: "none", shares: [{ user_id: "u2", amount_base_minor: 10 }] }, 1000, members),
    /精算不要/,
  );
});

test("validateShares requires the payer and every share user to be an active member", () => {
  assert.throws(() => validateShares({ payer_user_id: "stranger", shares: [] }, 0, members), /支払者/);
  assert.throws(
    () => validateShares({ payer_user_id: "u1", shares: [{ user_id: "ghost", amount_base_minor: 1000 }] }, 1000, members),
    /負担者/,
  );
});

test("validateShares names the real problem when nobody bears the cost", () => {
  // 0人のときに「合計が一致しない」と言われても、利用者は原因へたどり着けない。
  assert.throws(
    () => validateShares({ payer_user_id: "u1", split_method: "equal_all", shares: [] }, 1000, members),
    /負担する人が1人もいません/,
  );
});

test("computeAmounts rejects a converted amount beyond the safe integer range", () => {
  assert.throws(() => computeAmounts({ amount_minor: Number.MAX_SAFE_INTEGER, fx_rate: 100 }), /扱える範囲/);
});

test("精算登録は現在の債権・債務の範囲だけを許可する", () => {
  const members = new Set(["payer", "creditor"]);
  assert.doesNotThrow(() => validateSettlementAgainstBalances(
    { from_user_id: "payer", to_user_id: "creditor", amount_base_minor: 500 },
    members,
    { payer: -500, creditor: 500 },
  ));
  assert.throws(() => validateSettlementAgainstBalances(
    { from_user_id: "payer", to_user_id: "creditor", amount_base_minor: 501 },
    members,
    { payer: -500, creditor: 500 },
  ), /一致しません/);
  assert.throws(() => validateSettlementAgainstBalances(
    { from_user_id: "payer", to_user_id: "creditor", amount_base_minor: 499 },
    members,
    { payer: -500, creditor: 500 },
  ), /一致しません/);
});

test("同じ精算を再送しても解消済み残高には登録できない", () => {
  assert.throws(() => validateSettlementAgainstBalances(
    { from_user_id: "payer", to_user_id: "creditor", amount_base_minor: 500 },
    new Set(["payer", "creditor"]),
    { payer: 0, creditor: 0 },
  ), /更新されています/);
});

test("旅行から外れた会計メンバーでも残債の精算対象にできる", () => {
  // 呼び出し側はactiveだけでなく、その計画に残る全plan_membersを渡す。
  assert.doesNotThrow(() => validateSettlementAgainstBalances(
    { from_user_id: "removed", to_user_id: "owner", amount_base_minor: 200 },
    new Set(["owner", "removed"]),
    { removed: -200, owner: 200 },
  ));
});

test("金額を扱う書き込みはIDをサーバーで採番し、精算額も整数の範囲で受け取る", () => {
  const repo = fs.readFileSync(new URL("../src/expense-repo.ts", import.meta.url), "utf8");
  // クライアント指定のIDを通すと、衝突が500になり他計画のIDの存在判定にも使える。
  assert.doesNotMatch(repo, /input\.id/);
  assert.match(repo, /const id = newId\("exp"\)/);
  assert.match(repo, /createSettlement[\s\S]*Number\.isSafeInteger\(amount\)/);
  assert.match(repo, /createSettlement[\s\S]*validateSettlementAgainstBalances/);
  assert.match(repo, /previousPayer[\s\S]*allowedMemberIds\.add/);
  assert.match(repo, /previousShares[\s\S]*allowedMemberIds\.add/);
});
