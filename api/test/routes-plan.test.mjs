import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-0123456789-abcdef";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { pool } = await import("../dist/db.js");
const { route } = await import("../dist/routes.js");

test("sourceは作成後にsampleへ変更できない", async () => {
  const result = await route("PATCH", "/api/plans/pln_1", {
    source: "sample",
    expected_version: 1,
  }, "usr_owner");
  assert.equal(result.status, 400);
  // エラー契約: error は機械コード、日本語の説明は message に載る。
  assert.equal(result.body.error, "bad_request");
  assert.match(result.body.message, /更新できない項目.*source/);
  assert.equal(result.body.action, "revise_input");
});

test("公開計画でも受諾済み権限がなければメタデータを変更できない", async (t) => {
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    if (String(sql).includes("FROM plans p") && String(sql).includes("LEFT JOIN plan_access_grants")) {
      return [[{
        source: "local",
        visibility: "public",
        status: "published",
        open_editing: 1,
        owner_user_id: "usr_owner",
        role: null,
      }], []];
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  t.after(() => { pool.query = originalQuery; });

  const result = await route("PATCH", "/api/plans/pln_1", {
    title: "勝手に変えた名前",
    expected_version: 1,
  }, "usr_collaborator");
  assert.equal(result.status, 403);
  assert.equal(result.body.error, "forbidden");
  // 403も共通契約に沿い、利用者向けの説明と復旧操作を返す。
  assert.equal(typeof result.body.message, "string");
  assert.equal(result.body.action, "reload");
});

test("表示名だけのグローバルユーザー作成APIは存在しない", async () => {
  const result = await route("POST", "/api/users", {
    display_name: "未登録の旅行メンバー",
  }, "usr_actor");
  assert.equal(result, null);
});

test("AIキー設定はログイン必須で、不正な形式をOpenAIへ送らない", async () => {
  const anonymous = await route("GET", "/api/account/ai-credential", {}, "");
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.action, "sign_in");

  const invalid = await route("PUT", "/api/account/ai-credential", { api_key: "not-a-secret" }, "usr_1");
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, "bad_request");
  assert.match(invalid.body.message, /sk-/);
});

test("契約外の入力はすべて共通契約のbad_requestで説明する", async () => {
  const noVersion = await route("PATCH", "/api/plans/pln_1", { title: "x" }, "usr_owner");
  assert.equal(noVersion.status, 400);
  assert.equal(noVersion.body.error, "bad_request");
  assert.match(noVersion.body.message, /expected_version/);

  const ownerPatch = await route("PATCH", "/api/plans/pln_1", {
    owner_user_id: "usr_x", expected_version: 1,
  }, "usr_owner");
  assert.equal(ownerPatch.body.error, "bad_request");
  assert.match(ownerPatch.body.message, /owner_user_id/);

  const unknownContent = await route("PUT", "/api/plans/pln_1/content", {
    expected_version: 1, secret_field: [],
  }, "usr_owner");
  assert.equal(unknownContent.body.error, "bad_request");
  assert.match(unknownContent.body.message, /更新できない項目.*secret_field/);

  const notArray = await route("PUT", "/api/plans/pln_1/content", {
    expected_version: 1, itinerary: "破損",
  }, "usr_owner");
  assert.equal(notArray.body.error, "bad_request");
  assert.match(notArray.body.message, /itinerary.*配列/);
});

test("移動候補検索はログイン必須で、入力不足は契約どおりに説明する", async () => {
  const anonymous = await route("POST", "/api/transport/search", {}, "");
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error, "session_required");
  assert.equal(anonymous.body.action, "sign_in");

  const missing = await route("POST", "/api/transport/search", { from: "東京" }, "usr_1");
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, "bad_request");
  assert.equal(missing.body.action, "revise_input");
});

test("LINE解除はセッション必須。無効トークンにはsign_in契約を返す", async () => {
  const result = await route("DELETE", "/api/auth/line/link", {}, "");
  assert.equal(result.status, 401);
  assert.equal(result.body.error, "session_required");
  assert.equal(result.body.action, "sign_in");
  assert.equal(typeof result.body.message, "string");
});

test("友達関係の不正なstatusは契約どおりbad_request", async (t) => {
  const originalQuery = pool.query;
  pool.query = async () => [[], []];
  t.after(() => { pool.query = originalQuery; });

  const result = await route("POST", "/api/friendships", {
    a: "usr_1", b: "usr_2", requested_by_id: "usr_1", status: "weird",
  }, "usr_1");
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "bad_request");
  assert.equal(result.body.action, "revise_input");

  const notParty = await route("POST", "/api/friendships", {
    a: "usr_1", b: "usr_2", requested_by_id: "usr_1",
  }, "usr_3");
  assert.equal(notParty.status, 403);
  assert.equal(notParty.body.error, "forbidden");

  const self = await route("POST", "/api/friendships", {
    a: "usr_1", b: "usr_1", requested_by_id: "usr_1",
  }, "usr_1");
  assert.equal(self.status, 400);
  assert.match(self.body.message, /相手が正しくありません/);
});

test("クライアント指定の計画idはURLで扱える形式だけ受け付ける", async () => {
  await assert.rejects(
    route("POST", "/api/plans", { id: "変な id!", slug: "trip-x", title: "x" }, "usr_owner"),
    /id の形式/,
  );
  await assert.rejects(
    route("POST", "/api/plans", { slug: "Trip_X", title: "x" }, "usr_owner"),
    /スラッグ/,
  );
});

test("招待の発行は編集メンバーにも許し、閲覧メンバーには許さない", async (t) => {
  const originalQuery = pool.query;
  const access = { role: "editor" };
  pool.query = async (sql) => {
    const text = String(sql);
    if (text.includes("FROM plans p") && text.includes("LEFT JOIN plan_access_grants")) {
      return [[{
        source: "local", visibility: "private", status: "draft",
        open_editing: 0, owner_user_id: "usr_owner", role: access.role,
      }], []];
    }
    // 期限切れの掃除と一覧取得。どちらも権限判定の後に走る。
    if (text.includes("UPDATE plan_invites")) return [{ affectedRows: 0 }, []];
    if (text.includes("FROM plan_invites")) return [[], []];
    throw new Error(`unexpected query: ${text}`);
  };
  t.after(() => { pool.query = originalQuery; });

  const editor = await route("GET", "/api/plans/pln_1/invites", {}, "usr_editor");
  assert.equal(editor.status, 200);

  access.role = "viewer";
  const viewer = await route("GET", "/api/plans/pln_1/invites", {}, "usr_viewer");
  assert.equal(viewer.status, 403);
});

test("参加者名簿の書き換えは owner だけに限る", async (t) => {
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    const text = String(sql);
    if (text.includes("FROM plans p") && text.includes("LEFT JOIN plan_access_grants")) {
      return [[{
        source: "local", visibility: "private", status: "draft",
        open_editing: 0, owner_user_id: "usr_owner", role: "editor",
      }], []];
    }
    throw new Error(`unexpected query: ${text}`);
  };
  t.after(() => { pool.query = originalQuery; });

  const replace = await route("PUT", "/api/plans/pln_1/members", {
    expected_version: 1,
    members: [{ user_id: "usr_owner", role: "owner" }],
  }, "usr_editor");
  assert.equal(replace.status, 403);

  const placeholder = await route("POST", "/api/plans/pln_1/placeholder-members", {
    display_name: "たかし",
  }, "usr_editor");
  assert.equal(placeholder.status, 403);
});
