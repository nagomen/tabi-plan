import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-0123456789-abcdef";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
process.env.ALLOWED_ORIGINS ||= "https://app.example.com,http://localhost:5173";
process.env.LINE_CHANNEL_ID ||= "test-channel";
process.env.LINE_CHANNEL_SECRET ||= "test-secret";

const { safeReturnTo, authorizeUrl, loginErrorUrl, peekReturnTo, handleLineCallback } =
  await import("../dist/line-auth.js");

const FALLBACK = "https://app.example.com";

test("safeReturnTo keeps an allowed origin and strips the fragment", () => {
  assert.equal(
    safeReturnTo("https://app.example.com/tabi-plan/plans.html#token"),
    "https://app.example.com/tabi-plan/plans.html",
  );
});

test("safeReturnTo falls back to the first allowed origin for foreign/garbage/js targets", () => {
  assert.equal(safeReturnTo("https://evil.example/steal"), FALLBACK);
  assert.equal(safeReturnTo("javascript:alert(1)"), FALLBACK);
  assert.equal(safeReturnTo("//evil.example"), FALLBACK);
  assert.equal(safeReturnTo("not a url"), FALLBACK);
  assert.equal(safeReturnTo(""), FALLBACK);
});

test("authorizeUrl restricts return_to and carries a signed state", () => {
  const url = new URL(authorizeUrl("https://evil.example/x", "", "abc"));
  assert.equal(url.origin + url.pathname, "https://access.line.me/oauth2/v2.1/authorize");
  assert.equal(url.searchParams.get("client_id"), "test-channel");
  assert.equal(url.searchParams.get("scope"), "profile openid");
  const state = url.searchParams.get("state");
  assert.match(state, /\./);
  // return_to was foreign, so the embedded return is the fallback origin.
  assert.equal(peekReturnTo(state), FALLBACK);
});

test("loginErrorUrl points at the login page of the resolved return origin", () => {
  const url = loginErrorUrl("https://app.example.com/tabi-plan/plans.html", "失敗");
  assert.match(url, /^https:\/\/app\.example\.com\/tabi-plan\/login\.html#line_error=/);
});

test("handleLineCallback rejects a tampered or garbage state before any network call", async () => {
  const state = new URL(authorizeUrl("https://app.example.com/", "", "n")).searchParams.get("state");
  const [payload, signature] = state.split(".");
  const tampered = `${payload}.${signature.slice(0, -2)}xx`;
  await assert.rejects(handleLineCallback({ code: "abc", state: tampered }), /手続き|期限切れ|やり直し/);
  await assert.rejects(handleLineCallback({ code: "abc", state: "garbage" }), /手続き|期限切れ|やり直し/);
});
