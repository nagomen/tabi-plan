import test from "node:test";
import assert from "node:assert/strict";
import {
  hashNewPassword, verifyPassword, needsRehash, validatePassword,
  timingSafeEqual, passwordHash, PASSWORD_ITERATIONS,
} from "../dist/password.js";

test("hashNewPassword produces a salted hash that verifies and rejects a wrong password", async () => {
  const stored = await hashNewPassword("correct horse battery");
  assert.equal(stored.iterations, PASSWORD_ITERATIONS);
  assert.equal(stored.salt.length, 16);
  assert.equal(stored.hash.length, 32);
  assert.equal(await verifyPassword("correct horse battery", stored), true);
  assert.equal(await verifyPassword("wrong", stored), false);
});

test("two hashes of the same password differ by salt but both verify", async () => {
  const a = await hashNewPassword("same-password");
  const b = await hashNewPassword("same-password");
  assert.notEqual(a.salt.toString("hex"), b.salt.toString("hex"));
  assert.notEqual(a.hash.toString("hex"), b.hash.toString("hex"));
  assert.equal(await verifyPassword("same-password", a), true);
  assert.equal(await verifyPassword("same-password", b), true);
});

test("verifyPassword recomputes with the stored iteration count (legacy upgrade path)", async () => {
  const { salt } = await hashNewPassword("x");
  const legacy = { salt, hash: await passwordHash("legacy-pass", salt, 1000), iterations: 1000 };
  assert.equal(await verifyPassword("legacy-pass", legacy), true);
  assert.equal(await verifyPassword("nope", legacy), false);
  assert.equal(needsRehash(1000), true);
  assert.equal(needsRehash(PASSWORD_ITERATIONS), false);
});

test("validatePassword enforces the 8..256 length policy", () => {
  assert.throws(() => validatePassword("short"), /8文字以上/);
  assert.throws(() => validatePassword("a".repeat(257)), /256文字以下/);
  assert.equal(validatePassword("goodenough"), "goodenough");
});

test("timingSafeEqual is false for different lengths and content", () => {
  assert.equal(timingSafeEqual(Buffer.from("abc"), Buffer.from("abcd")), false);
  assert.equal(timingSafeEqual(Buffer.from("abc"), Buffer.from("abd")), false);
  assert.equal(timingSafeEqual(Buffer.from("abc"), Buffer.from("abc")), true);
});
