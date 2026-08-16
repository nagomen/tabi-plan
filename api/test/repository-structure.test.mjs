import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../src/", import.meta.url);
const source = (name) => fs.readFileSync(new URL(name, root), "utf8");

test("transaction lifecycle is owned by the database helper", () => {
  const files = fs.readdirSync(root).filter((name) => name.endsWith(".ts"));
  const owners = files.filter((name) => /\.beginTransaction\(\)/.test(source(name)));
  assert.deepEqual(owners, ["db.ts"]);
  assert.match(source("db.ts"), /export async function withTransaction/);
});

test("plan repository delegates bootstrap, access, invites and membership", () => {
  const planRepo = source("plan-repo.ts");
  assert.doesNotMatch(planRepo, /function bootstrapForUser|function createInvite|function replaceMembers|function canManagePlan/);
  assert.match(source("routes.ts"), /bootstrapRepo\.bootstrapForUser/);
  assert.match(source("routes.ts"), /accessRepo\.getPlanAccess/);
  assert.match(source("routes.ts"), /inviteRepo\.createInvite/);
  assert.match(source("routes.ts"), /memberRepo\.replaceMembers/);
});
