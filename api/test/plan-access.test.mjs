import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-that-is-longer-than-32-characters";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { pool } = await import("../dist/db.js");
const { getPlanAccess, canViewPlan, canManagePlan, canEditPlanWorkspace } = await import("../dist/plan-access-repo.js");

const planRow = (overrides = {}) => [[{
  source: "local", visibility: "public", status: "published",
  open_editing: 0, owner_user_id: "usr_owner", role: null, ...overrides,
}], []];

test("計画アクセス判定は計画の状態とロールから一貫して導出する", async (t) => {
  const originalQuery = pool.query;
  t.after(() => { pool.query = originalQuery; });

  pool.query = async () => [[], []];
  const missing = await getPlanAccess("pln_missing", "usr_1");
  assert.deepEqual(missing, {
    exists: false, role: null, canManage: false, canEditWorkspace: false, canEdit: false, canView: false,
  });

  // sample計画は閲覧だけできて書き込み権限は一切出さない
  pool.query = async () => planRow({ source: "sample", role: "owner" });
  const sample = await getPlanAccess("pln_sample", "usr_owner");
  assert.equal(sample.canView, true);
  assert.equal(sample.canManage, false);
  assert.equal(sample.canEdit, false);

  // 参加者行が無くても作成者本人はowner扱い（公開計画のコピーで起きた403の再発防止）
  pool.query = async () => planRow({ visibility: "invite", status: "draft", role: null });
  const creator = await getPlanAccess("pln_own", "usr_owner");
  assert.equal(creator.role, "owner");
  assert.equal(await canManagePlan("pln_own", "usr_owner"), true);
  assert.equal(await canEditPlanWorkspace("pln_own", "usr_owner"), true);

  // 公開・公開中の計画は匿名でも閲覧でき、open_editingならログイン者は本文編集できる
  pool.query = async () => planRow({ open_editing: 1 });
  assert.equal(await canViewPlan("pln_pub", ""), true);
  const collaborator = await getPlanAccess("pln_pub", "usr_other");
  assert.equal(collaborator.canEdit, true);
  assert.equal(collaborator.canEditWorkspace, false);
  assert.equal(collaborator.canManage, false);

  // 非公開・下書きは匿名から見えない
  pool.query = async () => planRow({ visibility: "invite", status: "draft", owner_user_id: "usr_owner" });
  assert.equal(await canViewPlan("pln_private", ""), false);
});
