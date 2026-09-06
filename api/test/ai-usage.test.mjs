import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-that-is-longer-than-32-characters";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { pool } = await import("../dist/db.js");
const { refundAiRequest, recordAiTokens } = await import("../dist/ai-usage-repo.js");

test("AI枠の返却は当日のカウントを下限0で戻し、クールダウンは触らない", async (t) => {
  const captured = [];
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    captured.push({ sql: String(sql), params });
    return [{ affectedRows: 1 }, []];
  };
  t.after(() => { pool.query = originalQuery; });

  await refundAiRequest("usr_1", "itinerary");
  assert.match(captured[0].sql, /GREATEST\(0, request_count - 1\)/);
  assert.match(captured[0].sql, /itinerary_count/);
  assert.doesNotMatch(captured[0].sql, /last_itinerary_at/);
  assert.deepEqual(captured[0].params, ["usr_1"]);

  await refundAiRequest("usr_1", "options");
  assert.match(captured[1].sql, /options_count/);
});

test("トークン計上は負値を0へ丸める", async (t) => {
  const captured = [];
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    captured.push({ sql: String(sql), params });
    return [{ affectedRows: 1 }, []];
  };
  t.after(() => { pool.query = originalQuery; });

  await recordAiTokens("usr_1", -5, 120.4);
  assert.deepEqual(captured[0].params, [0, 120, "usr_1"]);
});
