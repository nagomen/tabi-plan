// 関係テーブル用のルーティング。server.ts から呼ばれる。
//
//   GET    /api/bootstrap                    起動時に全データを1往復で取得
//   POST   /api/users                        { display_name } / { display_name, ensure:true }
//   PATCH  /api/users/<id>                   { display_name }
//   PUT    /api/users/<id>/credentials       { email, salt, hash }
//   POST   /api/users/credentials/lookup     { email } → 照合材料（ハッシュ比較はクライアント）
//   PUT    /api/users/<id>/payment-link      { handle }
//   PUT    /api/users/<id>/settings          { history_public }
//   POST   /api/plans                        計画を作る
//   PATCH  /api/plans/<id>                   メタ更新
//   DELETE /api/plans/<id>                   論理削除
//   PUT    /api/plans/<id>/members           参加者を一括置換
//   PUT    /api/plans/<id>/content           行程・都市・リンク・チェックリスト・候補を一括置換
//   POST   /api/plans/<id>/views             閲覧を1加算
//   POST   /api/plans/<id>/expenses          費用を1件追加（行の INSERT なので衝突しない）
//   PATCH  /api/expenses/<id>                費用を1件更新
//   DELETE /api/expenses/<id>                論理削除
//   POST   /api/expenses/<id>/restore        元に戻す
//   POST   /api/plans/<id>/settlements       精算を記録
//   POST   /api/friendships                  友達申請/承諾

import * as repo from "./repo.js";

export interface Handled {
  status: number;
  body: unknown;
}

type Body = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : []);

export async function route(method: string, path: string, body: Body): Promise<Handled | null> {
  // ---- 起動時の一括取得 ----
  if (method === "GET" && path === "/api/bootstrap") {
    return { status: 200, body: await repo.bootstrap() };
  }

  // ---- ユーザー ----
  if (method === "POST" && path === "/api/users") {
    const name = str(body.display_name);
    const user = body.ensure ? await repo.ensureUserByName(name) : await repo.createUser(name, str(body.id) || undefined);
    return { status: 200, body: user };
  }
  let m = /^\/api\/users\/([\w-]{1,32})$/.exec(path);
  if (m && method === "PATCH") {
    await repo.renameUser(m[1], str(body.display_name));
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/users\/([\w-]{1,32})\/credentials$/.exec(path);
  if (m && method === "PUT") {
    await repo.upsertCredentials({
      user_id: m[1], email: str(body.email), salt: str(body.salt), hash: str(body.hash),
    });
    return { status: 200, body: { ok: true } };
  }
  if (method === "POST" && path === "/api/users/credentials/lookup") {
    const found = await repo.credentialByEmail(str(body.email));
    // 見つからなくても 200 を返し、応答時間と形で存在有無を漏らさない
    return { status: 200, body: { credential: found } };
  }
  m = /^\/api\/users\/([\w-]{1,32})\/payment-link$/.exec(path);
  if (m && method === "PUT") {
    await repo.setPaymentLink(m[1], str(body.handle));
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/users\/([\w-]{1,32})\/settings$/.exec(path);
  if (m && method === "PUT") {
    await repo.setUserSettings(m[1], Boolean(body.history_public));
    return { status: 200, body: { ok: true } };
  }

  // ---- 計画 ----
  if (method === "POST" && path === "/api/plans") {
    return { status: 200, body: await repo.createPlan(body) };
  }
  m = /^\/api\/plans\/([\w-]{1,32})$/.exec(path);
  if (m && method === "PATCH") {
    await repo.updatePlan(m[1], body);
    return { status: 200, body: { ok: true } };
  }
  if (m && method === "DELETE") {
    await repo.deletePlan(m[1]);
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/members$/.exec(path);
  if (m && method === "PUT") {
    await repo.replaceMembers(m[1], arr(body.members) as { user_id: string; role?: string }[]);
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/content$/.exec(path);
  if (m && method === "PUT") {
    await repo.replacePlanContent(m[1], body as Parameters<typeof repo.replacePlanContent>[1]);
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/views$/.exec(path);
  if (m && method === "POST") {
    await repo.countView(m[1]);
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/expenses$/.exec(path);
  if (m && method === "POST") {
    return { status: 200, body: await repo.createExpense(m[1], body as unknown as repo.ExpenseInput) };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/settlements$/.exec(path);
  if (m && method === "POST") {
    return {
      status: 200,
      body: await repo.createSettlement(m[1], body as unknown as {
        from_user_id: string; to_user_id: string; amount_base_minor: number;
      }),
    };
  }

  // ---- 費用 ----
  m = /^\/api\/expenses\/([\w-]{1,32})$/.exec(path);
  if (m && method === "PATCH") {
    await repo.updateExpense(m[1], body as unknown as repo.ExpenseInput);
    return { status: 200, body: { ok: true } };
  }
  if (m && method === "DELETE") {
    await repo.deleteExpense(m[1]);
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/expenses\/([\w-]{1,32})\/restore$/.exec(path);
  if (m && method === "POST") {
    await repo.restoreExpense(m[1]);
    return { status: 200, body: { ok: true } };
  }

  // ---- 友達 ----
  if (method === "POST" && path === "/api/friendships") {
    return {
      status: 200,
      body: await repo.upsertFriendship({
        a: str(body.a), b: str(body.b), requested_by_id: str(body.requested_by_id), status: str(body.status) || undefined,
      }),
    };
  }

  return null; // 該当なし（呼び出し側で 404）
}
