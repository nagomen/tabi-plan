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

test("AI route distinguishes an expired login session from missing plan permission", () => {
  const routes = source("routes.ts");
  const config = source("config.ts");
  assert.match(config, /dailyRequestsPerUser: Math\.min\(integer\("AI_DAILY_REQUESTS_PER_USER", "3"[\s\S]*, 3\)/);
  assert.match(config, /googleRoutesApiKey: optional\("GOOGLE_ROUTES_API_KEY"/);
  assert.match(config, /amadeusClientId: optional\("AMADEUS_CLIENT_ID"/);
  assert.match(routes, /path === "\/api\/transport\/search"[\s\S]*searchTransportOptions\(input\)/);
  assert.match(routes, /function aiSessionRequired\(\)[\s\S]*error: "session_required"[\s\S]*action: "sign_in"/);
  assert.match(routes, /path === "\/api\/ai\/itinerary"[\s\S]*return aiSessionRequired\(\)/);
  assert.match(routes, /path === "\/api\/ai\/itinerary-options"[\s\S]*suggestItineraryOptions/);
  assert.match(routes, /path === "\/api\/ai\/itinerary-refine"[\s\S]*access\.canEditWorkspace/);
  assert.match(routes, /access\.canEditWorkspace[\s\S]*refineItinerary/);
  assert.match(routes, /reserveAi\(actorUserId, "options"\)/);
  assert.match(routes, /reserveAi\(actorUserId, "itinerary"\)/);
  assert.match(routes, /ai_daily_limit[\s\S]*use_external_ai/);
  assert.match(routes, /transportOptionsForCities\(input\.cities \|\| \[\]/);
  assert.match(routes, /error instanceof AiOutputError[\s\S]*status: 422/);
  assert.doesNotMatch(routes, /causeDetail[^\n]*body/);
});

test("unregistered trip members are explicit placeholders, not auto-created friends", () => {
  const routes = source("routes.ts");
  const users = source("user-repo.ts");
  const members = source("plan-member-repo.ts");
  const invites = source("plan-invite-repo.ts");
  const references = source("plan-member-reference-repo.ts");
  assert.match(routes, /\/placeholder-members/);
  assert.match(routes, /\/api\/invites\/inspect/);
  assert.match(members, /createPlaceholderMember/);
  assert.match(members, /newId\("gst"\)/);
  assert.match(invites, /claimPlaceholder/);
  assert.match(invites, /FOR UPDATE/);
  assert.match(invites, /reassignPlanMemberReferences/);
  assert.match(members, /reassignPlanMemberReferences/);
  assert.match(references, /UPDATE expenses SET payer_user_id/);
  assert.match(references, /INSERT INTO expense_shares/);
  assert.match(references, /UPDATE settlements SET from_user_id/);
  assert.match(invites, /requestedPlaceholder !== invitedPlaceholder\.user_id/);
  assert.match(invites, /旅行メンバーの中から自分を選択してください/);
  assert.match(invites, /invite\.role/);
  assert.match(references, /SELECT id, member_ids FROM itinerary_items/);
  assert.match(invites, /SELECT owner_user_id FROM plans[\s\S]*FOR UPDATE/);
  assert.match(invites, /UPDATE plan_member_placeholders[\s\S]*status = 'claimed'/);
  assert.match(members, /未登録メンバーへ所有権は移譲できません/);
  assert.match(members, /owner_user_id !== actorUserId/);
  assert.match(members, /費用・負担・精算に使われているメンバーは削除できません/);
  assert.doesNotMatch(members + invites, /ensurePlanMembersAreFriends/);
  assert.doesNotMatch(routes, /path === "\/api\/users"/);
  assert.doesNotMatch(users, /INSERT INTO users/);
});

test("mutable repositories recheck current membership inside their transactions", () => {
  const plans = source("plan-repo.ts");
  const members = source("plan-member-repo.ts");
  const invites = source("plan-invite-repo.ts");
  const expenses = source("expense-repo.ts");
  assert.match(plans, /SELECT role FROM plan_members[\s\S]*FOR UPDATE/);
  assert.match(plans, /source === "sample"/);
  assert.match(members, /SELECT owner_user_id, version FROM plans[\s\S]*FOR UPDATE/);
  assert.match(invites, /招待を作成できるのは現在のownerだけです/);
  assert.match(expenses, /async function assertWorkspaceEditor/);
  assert.match(expenses, /await assertWorkspaceEditor\(conn, planId, actorUserId\)/);
});

test("account recovery stores only a keyed hash and revokes every active session", () => {
  const auth = source("auth-repo.ts");
  const server = source("server.ts");
  assert.match(auth, /hmac\(`recovery:\$\{code\}`\)/);
  assert.match(auth, /recovery_code_hash/);
  assert.match(auth, /UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id/);
  assert.match(server, /path === "\/api\/auth\/recover"/);
  assert.match(server, /path === "\/api\/auth\/recovery-code"/);
  assert.doesNotMatch(auth, /recovery_code\s+VARCHAR/);
});
