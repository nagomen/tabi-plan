import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("旅行参加者と受諾済みアクセス権を別テーブルで管理する", () => {
  const schema = read("schema/002_relational.sql");
  const migration = read("scripts/migrate.mjs");
  const bootstrap = read("src/bootstrap-repo.ts");
  const access = read("src/plan-access-repo.ts");
  const invites = read("src/plan-invite-repo.ts");
  const members = read("src/plan-member-repo.ts");

  assert.match(schema, /CREATE TABLE plan_access_grants[\s\S]*status\s+ENUM\('active','revoked'\)/);
  assert.match(migration, /015_separate_plan_access/);
  assert.match(bootstrap, /LEFT JOIN plan_access_grants pag[\s\S]*pag\.status = 'active'/);
  assert.match(access, /LEFT JOIN plan_access_grants/);
  assert.match(invites, /acceptInvite[\s\S]*INSERT INTO plan_access_grants/);
  assert.match(members, /UPDATE plan_access_grants SET status = 'revoked'/);
  assert.match(members, /UPDATE plan_invites SET status = 'revoked'/);
});

test("旧open_editingは受諾済み権限を迂回しない", () => {
  const policy = read("src/policy.ts");
  const plans = read("src/plan-repo.ts");
  assert.match(policy, /return canEditWorkspaceRole\(context\.role\)/);
  assert.doesNotMatch(plans, /publicCollaborator/);
});

test("旧KV移行はアクセス権も再構築し、reset時に孤立行を残さない", () => {
  const legacyMigration = read("scripts/migrate-kv-to-relational.mjs");
  assert.match(
    legacyMigration,
    /"plan_invites", "plan_member_placeholders", "plan_access_grants", "plan_members", "plans"/,
  );
  assert.match(
    legacyMigration,
    /INSERT INTO plan_members[\s\S]*INSERT INTO plan_access_grants[\s\S]*FROM plan_members pm[\s\S]*user_credentials/,
  );
  assert.match(legacyMigration, /SELECT id, owner_user_id, 'owner', 'active', owner_user_id/);
});

test("公開閲覧者へ行程の内部メンバーIDを返さない", () => {
  const bootstrap = read("src/bootstrap-repo.ts");
  assert.match(bootstrap, /publicOnlyPlanIdSet\.has\(row\.plan_id\)[\s\S]*row\.member_ids = null/);
});
