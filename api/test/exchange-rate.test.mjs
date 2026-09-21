import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-0123456789-abcdef";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { BadRequest, ExchangeRateUnavailable } = await import("../dist/errors.js");
const { fetchHistoricalUnitRate, unitRateToFxRate } = await import("../dist/exchange-rate-repo.js");

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

test("主要通貨単位の違いを含めて最小単位の換算倍率を求める", () => {
  assert.equal(unitRateToFxRate(20.765, "CNY", "JPY"), 0.20765);
  assert.equal(unitRateToFxRate(151.7, "USD", "JPY"), 1.517);
  assert.equal(unitRateToFxRate(3.2, "KWD", "JPY"), 0.0032);
  assert.throws(() => unitRateToFxRate(0, "CNY", "JPY"), ExchangeRateUnavailable);
});

test("土日でも支払日と完全一致する履歴レートだけを受け入れる", async () => {
  let requested = "";
  // 2025-09-06は土曜日。営業日に丸めず、その暦日を問い合わせる。
  const rate = await fetchHistoricalUnitRate("2025-09-06", "CNY", "JPY", async (url) => {
    requested = String(url);
    return jsonResponse({ date: "2025-09-06", base: "CNY", quote: "JPY", rate: 20.765 });
  });
  assert.match(requested, /rate\/cny\/jpy\?date=2025-09-06$/);
  assert.deepEqual(rate, { unitRate: 20.765, sourceDate: "2025-09-06" });

  // 日曜日も同じ規則。配信元がその日付を返した場合だけ採用する。
  const sunday = await fetchHistoricalUnitRate("2025-09-07", "CNY", "JPY", async () =>
    jsonResponse({ date: "2025-09-07", base: "CNY", quote: "JPY", rate: 20.77 }));
  assert.deepEqual(sunday, { unitRate: 20.77, sourceDate: "2025-09-07" });
});

test("近い営業日の応答を支払日のレートとして保存しない", async () => {
  await assert.rejects(
    fetchHistoricalUnitRate("2025-09-06", "CNY", "JPY", async () =>
      jsonResponse({ date: "2025-09-05", base: "CNY", quote: "JPY", rate: 20.766 })),
    ExchangeRateUnavailable,
  );
});

test("未対応通貨は入力エラー、配信元障害は再試行可能な障害に分ける", async () => {
  await assert.rejects(
    fetchHistoricalUnitRate("2025-09-06", "ABC", "JPY", async () => jsonResponse({}, 404)),
    BadRequest,
  );
  await assert.rejects(
    fetchHistoricalUnitRate("2025-09-06", "CNY", "JPY", async () => { throw new Error("offline"); }),
    ExchangeRateUnavailable,
  );
});
