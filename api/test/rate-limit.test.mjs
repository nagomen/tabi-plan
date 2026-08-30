import test from "node:test";
import assert from "node:assert/strict";
import { rateLimited, sweepExpired } from "../dist/rate-limit.js";

test("allows up to the limit then blocks within the same window", () => {
  const buckets = new Map();
  const now = 1000;
  assert.equal(rateLimited(buckets, "ip", 3, now), false);
  assert.equal(rateLimited(buckets, "ip", 3, now), false);
  assert.equal(rateLimited(buckets, "ip", 3, now), false);
  assert.equal(rateLimited(buckets, "ip", 3, now), true);
});

test("starts a fresh window once the previous one elapses", () => {
  const buckets = new Map();
  assert.equal(rateLimited(buckets, "ip", 1, 0, 1000), false);
  assert.equal(rateLimited(buckets, "ip", 1, 500, 1000), true);
  assert.equal(rateLimited(buckets, "ip", 1, 1000, 1000), false);
});

test("keys are independent and sweepExpired drops elapsed windows", () => {
  const buckets = new Map();
  rateLimited(buckets, "a", 1, 0, 1000);
  rateLimited(buckets, "b", 1, 0, 1000);
  assert.equal(buckets.size, 2);
  sweepExpired(buckets, 500);
  assert.equal(buckets.size, 2);
  sweepExpired(buckets, 2000);
  assert.equal(buckets.size, 0);
});
