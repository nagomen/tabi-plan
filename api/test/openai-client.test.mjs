import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-that-is-longer-than-32-characters";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
process.env.OPENAI_KEY ||= "test-openai-key";
process.env.OPENAI_MAX_RETRIES ||= "2";

const { structuredResponse } = await import("../dist/openai-client.js");

const schema = {
  type: "object", additionalProperties: false, required: ["ok"],
  properties: { ok: { type: "boolean" } },
};

function successResponse() {
  return new Response(JSON.stringify({
    id: "resp_test",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
    usage: { input_tokens: 10, output_tokens: 4 },
  }), { status: 200, headers: { "x-request-id": "req_test" } });
}

test("Responses APIへ保存無効・構造化出力・Web検索・出力上限を送る", async () => {
  let requestBody;
  const result = await structuredResponse({
    schemaName: "test_schema", schema, system: "system", user: "user", webSearch: true,
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return successResponse();
    },
  });
  assert.deepEqual(result.value, { ok: true });
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.text.format.type, "json_schema");
  assert.equal(requestBody.text.verbosity, "low");
  assert.equal(requestBody.reasoning.effort, "none");
  assert.equal(requestBody.tools[0].type, "web_search");
  assert.equal(requestBody.max_output_tokens, 30000);
  assert.equal(result.meta.requestId, "req_test");
});

test("429はRetry-Afterを尊重して限定再試行する", async () => {
  let calls = 0;
  const waits = [];
  const result = await structuredResponse({
    schemaName: "test_schema", schema, system: "system", user: "user",
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ error: { code: "rate_limit" } }), {
          status: 429, headers: { "retry-after": "0" },
        })
        : successResponse();
    },
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.equal(result.value.ok, true);
  assert.equal(calls, 2);
  assert.equal(waits.length, 1);
});

test("refusalと不完全応答を通常のJSONとして扱わない", async () => {
  await assert.rejects(() => structuredResponse({
    schemaName: "test_schema", schema, system: "system", user: "user",
    fetchImpl: async () => new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "cannot" }] }],
    }), { status: 200 }),
  }), /この条件ではAIが/);

  await assert.rejects(() => structuredResponse({
    schemaName: "test_schema", schema, system: "system", user: "user",
    fetchImpl: async () => new Response(JSON.stringify({
      status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [],
    }), { status: 200 }),
    sleep: async () => {},
  }), (error) => error.code === "ai_output_too_long" && error.retryable === false && error.action === "revise_input");
});

test("認証・課金・content filterは再試行せず管理者/入力対応として分類する", async () => {
  let calls = 0;
  await assert.rejects(() => structuredResponse({
    schemaName: "test_schema", schema, system: "system", user: "user",
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), { status: 401 });
    },
    sleep: async () => {},
  }), (error) => error.code === "ai_authentication_failed" && error.retryable === false && error.action === "contact_support");
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(() => structuredResponse({
    schemaName: "test_schema", schema, system: "system", user: "user",
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), { status: 429 });
    },
    sleep: async () => {},
  }), (error) => error.code === "ai_quota_exceeded" && error.retryable === false && error.action === "contact_support");
  assert.equal(calls, 1, "課金枯渇の429は一時的な429と区別して再試行しない");

  await assert.rejects(() => structuredResponse({
    schemaName: "test_schema", schema, system: "system", user: "user",
    fetchImpl: async () => new Response(JSON.stringify({
      status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [],
    }), { status: 200 }),
    sleep: async () => {},
  }), (error) => error.code === "ai_content_filtered" && error.retryable === false && error.action === "revise_input");
});

test("解消しない429はRetry-Afterと問い合わせIDを利用者向け契約へ引き継ぐ", async () => {
  let calls = 0;
  await assert.rejects(() => structuredResponse({
    schemaName: "test_schema", schema, system: "system", user: "user",
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
        status: 429, headers: { "retry-after": "42", "x-request-id": "req_rate" },
      });
    },
    sleep: async () => {},
  }), (error) => error.code === "ai_rate_limited" && error.retryable === true &&
    error.retryAfter === 42 && error.requestId === "req_rate" && error.action === "retry_later");
  assert.equal(calls, 3, "初回 + OPENAI_MAX_RETRIES(2) 回で打ち切る");
});

test("接続不能は再試行後にネットワーク障害として分類する", async () => {
  let calls = 0;
  await assert.rejects(() => structuredResponse({
    schemaName: "test_schema", schema, system: "system", user: "user",
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    },
    sleep: async () => {},
  }), (error) => error.code === "ai_network_failed" && error.retryable === true);
  assert.equal(calls, 3);
});

test("モデル不在と空応答を区別して分類する", async () => {
  await assert.rejects(() => structuredResponse({
    schemaName: "test_schema", schema, system: "system", user: "user",
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: "model_not_found" } }), { status: 404 }),
    sleep: async () => {},
  }), (error) => error.code === "ai_model_unavailable" && error.retryable === false);

  await assert.rejects(() => structuredResponse({
    schemaName: "test_schema", schema, system: "system", user: "user",
    fetchImpl: async () => new Response(JSON.stringify({ status: "completed", output: [] }), {
      status: 200, headers: { "x-request-id": "req_empty" },
    }),
    sleep: async () => {},
  }), (error) => error.code === "ai_empty_response" && error.retryable === true && error.requestId === "req_empty");
});
