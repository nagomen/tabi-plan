import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistentDevSessionSecret } from "../../tools/dev-session-secret.mjs";

test("development session secret survives local API restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "tabi-session-"));
  const file = join(dir, "session-secret");
  try {
    const first = persistentDevSessionSecret(file);
    const second = persistentDevSessionSecret(file);
    assert.equal(second, first);
    assert.equal(readFileSync(file, "utf8").trim(), first);
    assert.ok(first.length >= 32);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
