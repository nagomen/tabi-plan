import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.SESSION_SECRET ||= "test-session-secret-0123456789-abcdef";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { isAllowedMcpRedirectUri, MCP_READ_SCOPE, MCP_WRITE_SCOPE } = await import("../dist/mcp-oauth.js");

test("MCP OAuth accepts ChatGPT HTTPS and local development callbacks only", () => {
  assert.equal(isAllowedMcpRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect"), true);
  assert.equal(isAllowedMcpRedirectUri("https://chat.openai.com/aip/callback"), true);
  assert.equal(isAllowedMcpRedirectUri("http://127.0.0.1:4567/callback"), true);
  assert.equal(isAllowedMcpRedirectUri("https://attacker.example/callback"), false);
  assert.equal(isAllowedMcpRedirectUri("javascript:alert(1)"), false);
});

test("MCP exposes separate read and write scopes", () => {
  assert.equal(MCP_READ_SCOPE, "trip:expenses:read");
  assert.equal(MCP_WRITE_SCOPE, "trip:expenses:write");
});

test("OAuth migration hashes authorization secrets instead of storing plaintext", () => {
  const migration = fs.readFileSync(new URL("../scripts/migrate.mjs", import.meta.url), "utf8");
  assert.match(migration, /request_hash\s+VARBINARY\(32\)/);
  assert.match(migration, /code_hash\s+VARBINARY\(32\)/);
  assert.match(migration, /token_hash\s+VARBINARY\(32\)/);
  assert.doesNotMatch(migration, /access_token\s+VARCHAR|refresh_token\s+VARCHAR/);
});

