import test from "node:test";
import assert from "node:assert/strict";

process.env.API_TOKEN ||= "test-public-api-token";
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
  assert.equal(requestBody.tools[0].type, "web_search");
  assert.ok(requestBody.max_output_tokens > 0);
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
  }), /途中で終了/);
});
