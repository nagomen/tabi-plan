import test from "node:test";
import assert from "node:assert/strict";
import { clientIp } from "../dist/client-ip.js";

const req = (headers, remoteAddress = "127.0.0.1") => ({ headers, socket: { remoteAddress } });

test("uses CF-Connecting-IP only when Cloudflare is trusted", () => {
  const r = req({ "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1, 2.2.2.2" });
  assert.equal(clientIp(r, true), "9.9.9.9");
  assert.equal(clientIp(r, false), "2.2.2.2");
});

test("takes the LAST X-Forwarded-For entry (nginx-observed peer), not the client-injected first", () => {
  const r = req({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 8.8.8.8" });
  assert.equal(clientIp(r, false), "8.8.8.8");
});

test("ignores a spoofed CF-Connecting-IP when Cloudflare is not trusted", () => {
  const r = req({ "cf-connecting-ip": "6.6.6.6", "x-forwarded-for": "5.5.5.5" });
  assert.equal(clientIp(r, false), "5.5.5.5");
});

test("falls back to the socket remote address, then 'unknown'", () => {
  assert.equal(clientIp(req({}, "203.0.113.5"), false), "203.0.113.5");
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: undefined } }, false), "unknown");
});
