import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-0123456789-abcdef";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
process.env.ALLOWED_ORIGINS ||= "https://app.example.com,http://localhost:5173";
process.env.LINE_CHANNEL_ID ||= "test-channel";
process.env.LINE_CHANNEL_SECRET ||= "test-secret";

const { safeReturnTo, authorizeUrl, loginErrorUrl, peekReturnTo, handleLineCallback, resolveLineUser } =
  await import("../dist/line-auth.js");
const { pool } = await import("../dist/db.js");

const FALLBACK = "https://app.example.com";

test("safeReturnTo keeps an allowed origin and strips the fragment", () => {
  assert.equal(
    safeReturnTo("https://app.example.com/tabi-plan/plans.html#token"),
    "https://app.example.com/tabi-plan/plans.html",
  );
});

test("safeReturnTo falls back to the first allowed origin for foreign/garbage/js targets", () => {
  assert.equal(safeReturnTo("https://evil.example/steal"), FALLBACK);
  assert.equal(safeReturnTo("javascript:alert(1)"), FALLBACK);
  assert.equal(safeReturnTo("//evil.example"), FALLBACK);
  assert.equal(safeReturnTo("not a url"), FALLBACK);
  assert.equal(safeReturnTo(""), FALLBACK);
});

test("authorizeUrl restricts return_to and carries a signed state", () => {
  const url = new URL(authorizeUrl("https://evil.example/x", "", "abc"));
  assert.equal(url.origin + url.pathname, "https://access.line.me/oauth2/v2.1/authorize");
  assert.equal(url.searchParams.get("client_id"), "test-channel");
  assert.equal(url.searchParams.get("scope"), "profile openid");
  const state = url.searchParams.get("state");
  assert.match(state, /\./);
  // return_to was foreign, so the embedded return is the fallback origin.
  assert.equal(peekReturnTo(state), FALLBACK);
});

test("loginErrorUrl points at the login page of the resolved return origin", () => {
  const url = loginErrorUrl("https://app.example.com/tabi-plan/plans.html", "失敗");
  assert.match(url, /^https:\/\/app\.example\.com\/tabi-plan\/login\.html#line_error=/);
});

test("handleLineCallback rejects a tampered or garbage state before any network call", async () => {
  const state = new URL(authorizeUrl("https://app.example.com/", "", "n")).searchParams.get("state");
  const [payload, signature] = state.split(".");
  const tampered = `${payload}.${signature.slice(0, -2)}xx`;
  await assert.rejects(handleLineCallback({ code: "abc", state: tampered }), /手続き|期限切れ|やり直し/);
  await assert.rejects(handleLineCallback({ code: "abc", state: "garbage" }), /手続き|期限切れ|やり直し/);
});

test("既存LINE identityを別ユーザーへ付け替えずtransactionをrollbackする", async () => {
  const originalGetConnection = pool.getConnection.bind(pool);
  const queries = [];
  let committed = false;
  let rolledBack = false;
  const connection = {
    query: async (sql) => {
      queries.push(sql);
      if (String(sql).includes("FROM user_identities")) return [[{ user_id: "usr_existing" }], []];
      return [[], []];
    },
    beginTransaction: async () => {},
    commit: async () => { committed = true; },
    rollback: async () => { rolledBack = true; },
    release: () => {},
  };
  pool.getConnection = async () => connection;
  try {
    await assert.rejects(
      resolveLineUser({ subject: "line-subject", displayName: "LINE名", pictureUrl: "" }, "usr_other"),
      /別の利用者/,
    );
    assert.equal(committed, false);
    assert.equal(rolledBack, true);
    assert.equal(queries.some((sql) => String(sql).includes("UPDATE user_identities")), false);
    assert.equal(queries.some((sql) => String(sql).includes("INSERT INTO users")), false);
  } finally {
    pool.getConnection = originalGetConnection;
  }
});

test("LINE初回ログインが同時実行されても一意制約に勝ったユーザーへ収束する", async (t) => {
  const originalGetConnection = pool.getConnection;
  const originalQuery = pool.query;
  let rolledBack = false;
  const connection = {
    query: async (sql) => {
      if (String(sql).includes("FROM user_identities")) return [[], []];
      if (String(sql).includes("INSERT INTO user_identities")) {
        throw Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" });
      }
      return [[], []];
    },
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => { rolledBack = true; },
    release: () => {},
  };
  pool.getConnection = async () => connection;
  pool.query = async (sql) => {
    if (String(sql).startsWith("SELECT user_id FROM user_identities")) {
      return [[{ user_id: "usr_winner" }], []];
    }
    if (String(sql).startsWith("UPDATE user_identities")) return [{ affectedRows: 1 }, []];
    throw new Error(`unexpected query: ${sql}`);
  };
  t.after(() => {
    pool.getConnection = originalGetConnection;
    pool.query = originalQuery;
  });

  const userId = await resolveLineUser({
    subject: "same-subject", displayName: "LINE名", pictureUrl: "",
  });
  assert.equal(userId, "usr_winner");
  assert.equal(rolledBack, true);
});
