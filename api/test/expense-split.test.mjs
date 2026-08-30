import test from "node:test";
import assert from "node:assert/strict";

process.env.API_TOKEN ||= "test-api-token";
process.env.SESSION_SECRET ||= "test-session-secret-0123456789-abcdef";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { computeAmounts, normalizeShares, validateShares } = await import("../dist/expense-repo.js");

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
