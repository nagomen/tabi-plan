import type mysql from "mysql2/promise";
import { config } from "./config.js";
import { pool, withTransaction } from "./db.js";

export type AiScope = "options" | "itinerary";

interface UsageRow extends mysql.RowDataPacket {
  request_count: number;
  token_count: number;
  cooldown_remaining: number;
  daily_retry_after: number;
}

/** 複数APIプロセス間でも共有される、ユーザー単位の原子的な利用枠確保。 */
export async function reserveAiRequest(userId: string, scope: AiScope): Promise<{ allowed: boolean; retryAfter: number }> {
  return withTransaction(async (connection) => {
    await connection.query(
      `INSERT IGNORE INTO ai_usage_daily
         (user_id, usage_date, request_count, options_count, itinerary_count, input_tokens, output_tokens)
       VALUES (?, CURRENT_DATE(), 0, 0, 0, 0, 0)`,
      [userId],
    );
    const lastColumn = scope === "options" ? "last_options_at" : "last_itinerary_at";
    const [rows] = await connection.query<UsageRow[]>(
      `SELECT request_count, input_tokens + output_tokens AS token_count,
              GREATEST(0, ? - COALESCE(TIMESTAMPDIFF(SECOND, ${lastColumn}, CURRENT_TIMESTAMP(3)), ?)) AS cooldown_remaining,
              GREATEST(1, TIMESTAMPDIFF(SECOND, CURRENT_TIMESTAMP(), DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY))) AS daily_retry_after
         FROM ai_usage_daily
        WHERE user_id = ? AND usage_date = CURRENT_DATE()
        FOR UPDATE`,
      [config.ai.cooldownSeconds, config.ai.cooldownSeconds, userId],
    );
    const usage = rows[0];
    if (!usage) throw new Error("AI usage row was not created");
    if (Number(usage.request_count) >= config.ai.dailyRequestsPerUser ||
        Number(usage.token_count) >= config.ai.dailyTokensPerUser) {
      return { allowed: false, retryAfter: Number(usage.daily_retry_after) || 3600 };
    }
    if (Number(usage.cooldown_remaining) > 0) {
      return { allowed: false, retryAfter: Math.ceil(Number(usage.cooldown_remaining)) };
    }
    const scopeColumn = scope === "options" ? "options_count" : "itinerary_count";
    await connection.query(
      `UPDATE ai_usage_daily
          SET request_count = request_count + 1,
              ${scopeColumn} = ${scopeColumn} + 1,
              ${lastColumn} = CURRENT_TIMESTAMP(3)
        WHERE user_id = ? AND usage_date = CURRENT_DATE()`,
      [userId],
    );
    return { allowed: true, retryAfter: 0 };
  });
}

export async function recordAiTokens(userId: string, inputTokens: number, outputTokens: number): Promise<void> {
  await pool.query(
    `UPDATE ai_usage_daily
        SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?
      WHERE user_id = ? AND usage_date = CURRENT_DATE()`,
    [Math.max(0, Math.round(inputTokens)), Math.max(0, Math.round(outputTokens)), userId],
  );
}
