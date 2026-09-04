#!/usr/bin/env node
// 既存の TravelPlan DB に後方互換な差分を適用する。
// DDL は MySQL で暗黙コミットされるため、各変更を information_schema で確認して
// 冪等に実行し、最後に schema_migrations へ記録する。

import mysql from "mysql2/promise";

for (const name of ["DB_USER", "DB_PASSWORD"]) {
  if (!process.env[name]) {
    console.error(`環境変数 ${name} が設定されていません`);
    process.exit(1);
  }
}

const database = process.env.DB_NAME || "TravelPlan";
const conn = await mysql.createConnection({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database,
  charset: "utf8mb4",
  connectTimeout: 10_000,
});

async function exists(sql, params) {
  const [rows] = await conn.query(sql, params);
  return rows.length > 0;
}

async function migrate003() {
  await conn.query(`CREATE TABLE IF NOT EXISTS user_sessions (
    id          VARCHAR(32) NOT NULL,
    user_id     VARCHAR(32) NOT NULL,
    token_hash  VARBINARY(32) NOT NULL,
    expires_at  TIMESTAMP NOT NULL,
    revoked_at  TIMESTAMP NULL DEFAULT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_user_sessions_token (token_hash),
    KEY idx_user_sessions_user (user_id, revoked_at, expires_at),
    KEY idx_user_sessions_expiry (expires_at, revoked_at),
    CONSTRAINT fk_user_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);

  if (!(await exists(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'plans' AND COLUMN_NAME = 'version'",
    [database],
  ))) {
    await conn.query("ALTER TABLE plans ADD COLUMN version BIGINT UNSIGNED NOT NULL DEFAULT 1 AFTER status");
  }

  // 従来の特例で世界編集可能になっていた東北旅行を安全側へ戻す。
  await conn.query("UPDATE plans SET open_editing = 0 WHERE slug = '2608-tohoku'");

  if (!(await exists(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'plan_invites' AND COLUMN_NAME = 'invited_user_id'",
    [database],
  ))) {
    await conn.query("ALTER TABLE plan_invites ADD COLUMN invited_user_id VARCHAR(32) NULL AFTER invited_name");
  }

  if (!(await exists(
    "SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'plan_invites' AND INDEX_NAME = 'idx_plan_invites_user'",
    [database],
  ))) {
    await conn.query("ALTER TABLE plan_invites ADD KEY idx_plan_invites_user (invited_user_id, status)");
  }

  if (!(await exists(
    "SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'plan_invites' AND CONSTRAINT_NAME = 'fk_plan_invites_user'",
    [database],
  ))) {
    await conn.query(
      "ALTER TABLE plan_invites ADD CONSTRAINT fk_plan_invites_user FOREIGN KEY (invited_user_id) REFERENCES users (id) ON DELETE SET NULL",
    );
  }

  await conn.query(`CREATE TABLE IF NOT EXISTS expense_audit_logs (
    id            VARCHAR(32) NOT NULL,
    plan_id       VARCHAR(32) NOT NULL,
    expense_id    VARCHAR(32) NOT NULL,
    actor_user_id VARCHAR(32) NULL,
    action        ENUM('create','update','delete','restore') NOT NULL,
    before_json   JSON NULL,
    after_json    JSON NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_expense_audit_plan (plan_id, created_at),
    KEY idx_expense_audit_expense (expense_id, created_at),
    CONSTRAINT fk_expense_audit_plan FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE,
    CONSTRAINT fk_expense_audit_expense FOREIGN KEY (expense_id) REFERENCES expenses (id) ON DELETE CASCADE,
    CONSTRAINT fk_expense_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);
}

async function migrate004() {
  const [rows] = await conn.query(
    "SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'plans' AND COLUMN_NAME = 'cover_url'",
    [database],
  );
  const type = String(rows[0]?.DATA_TYPE || "").toLowerCase();
  if (type !== "mediumtext") {
    await conn.query("ALTER TABLE plans MODIFY COLUMN cover_url MEDIUMTEXT NULL");
  }
}

async function migrate005() {
  await conn.query(`CREATE TABLE IF NOT EXISTS ai_usage_daily (
    user_id           VARCHAR(32) NOT NULL,
    usage_date        DATE NOT NULL,
    request_count     INT UNSIGNED NOT NULL DEFAULT 0,
    options_count     INT UNSIGNED NOT NULL DEFAULT 0,
    itinerary_count   INT UNSIGNED NOT NULL DEFAULT 0,
    input_tokens      BIGINT UNSIGNED NOT NULL DEFAULT 0,
    output_tokens     BIGINT UNSIGNED NOT NULL DEFAULT 0,
    last_options_at   DATETIME(3) NULL,
    last_itinerary_at DATETIME(3) NULL,
    PRIMARY KEY (user_id, usage_date),
    KEY idx_ai_usage_date (usage_date),
    CONSTRAINT fk_ai_usage_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
}

async function applyMigration(id, migrate) {
  if (await exists("SELECT 1 FROM schema_migrations WHERE id = ?", [id])) {
    console.log(`[migrate] ${id}: already applied`);
    return;
  }
  await migrate();
  await conn.query("INSERT INTO schema_migrations (id) VALUES (?)", [id]);
  console.log(`[migrate] ${id}: applied`);
}

async function migrate006() {
  // 外部サービスのログイン（いまは LINE）を users に紐付ける。
  // メール＋パスワードと共存し、後から紐付けもできるよう別テーブルにする。
  await conn.query(`CREATE TABLE IF NOT EXISTS user_identities (
    user_id      VARCHAR(32)  NOT NULL,
    provider     VARCHAR(16)  NOT NULL,
    subject      VARCHAR(191) NOT NULL,
    display_name VARCHAR(64)  NULL,
    picture_url  VARCHAR(512) NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (provider, subject),
    KEY idx_user_identities_user (user_id, provider),
    CONSTRAINT fk_user_identities_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
}

async function migrate007() {
  // 旧外部データソースの計画は、以後MySQL内の計画として扱う。
  await conn.query("UPDATE plans SET source = 'local' WHERE source NOT IN ('local', 'sample')");
  await conn.query("ALTER TABLE plans MODIFY COLUMN source ENUM('local','sample') NOT NULL DEFAULT 'local'");

  for (const column of ["external_spreadsheet_id", "external_apps_script_url", "external_schema"]) {
    if (await exists(
      "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'plans' AND COLUMN_NAME = ?",
      [database, column],
    )) {
      await conn.query(`ALTER TABLE plans DROP COLUMN \`${column}\``);
    }
  }
}

async function migrate008() {
  await conn.query(`CREATE TABLE IF NOT EXISTS plan_member_placeholders (
    plan_id             VARCHAR(32) NOT NULL,
    user_id             VARCHAR(32) NOT NULL,
    original_name       VARCHAR(64) NOT NULL,
    status              ENUM('unclaimed','claimed','removed') NOT NULL DEFAULT 'unclaimed',
    claimed_by_user_id  VARCHAR(32) NULL,
    claimed_at          TIMESTAMP NULL DEFAULT NULL,
    created_by_id       VARCHAR(32) NOT NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (plan_id, user_id),
    UNIQUE KEY uq_plan_member_placeholder_user (user_id),
    KEY idx_plan_member_placeholders_claim (plan_id, status),
    CONSTRAINT fk_plan_member_placeholder_plan FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE,
    CONSTRAINT fk_plan_member_placeholder_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_plan_member_placeholder_claimed FOREIGN KEY (claimed_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fk_plan_member_placeholder_creator FOREIGN KEY (created_by_id) REFERENCES users (id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);
}

async function migrate009() {
  // メンバーの途中合流/離脱（旅行内の参加期間）。NULL は全日程。
  if (!(await exists(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'plan_members' AND COLUMN_NAME = 'from_date'",
    [database],
  ))) {
    await conn.query("ALTER TABLE plan_members ADD COLUMN from_date DATE NULL AFTER invited_by_id");
  }
  if (!(await exists(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'plan_members' AND COLUMN_NAME = 'to_date'",
    [database],
  ))) {
    await conn.query("ALTER TABLE plan_members ADD COLUMN to_date DATE NULL AFTER from_date");
  }
}

async function migrate010() {
  // 行程項目の対象メンバー（user_id の JSON 配列）。NULL = その日の在籍メンバー全員。
  // 途中合流の個人移動（例: たかしだけ東京→大阪）を共有行程の中に置けるようにする。
  if (!(await exists(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'itinerary_items' AND COLUMN_NAME = 'member_ids'",
    [database],
  ))) {
    await conn.query("ALTER TABLE itinerary_items ADD COLUMN member_ids TEXT NULL AFTER duration_minutes");
  }
}

async function migrate011() {
  await conn.beginTransaction();
  try {
  // 旧移行データのうち、ownerロールが一意ならplans側へ反映する。
  await conn.query(`UPDATE plans p
    JOIN (
      SELECT plan_id, MAX(user_id) AS owner_id
        FROM plan_members WHERE status = 'active' AND role = 'owner'
       GROUP BY plan_id HAVING COUNT(*) = 1
    ) x ON x.plan_id = p.id
     SET p.owner_user_id = x.owner_id
   WHERE p.owner_user_id IS NULL`);

  // owner不在またはログイン不能で、ログイン可能な参加者が1人だけなら、その人を復旧ownerにする。
  await conn.query(`UPDATE plans p
    JOIN (
      SELECT pm.plan_id, MAX(pm.user_id) AS owner_id
        FROM plan_members pm
       WHERE pm.status = 'active'
         AND (EXISTS (SELECT 1 FROM user_credentials c WHERE c.user_id = pm.user_id)
           OR EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = pm.user_id))
       GROUP BY pm.plan_id HAVING COUNT(DISTINCT pm.user_id) = 1
    ) x ON x.plan_id = p.id
     SET p.owner_user_id = x.owner_id
   WHERE p.owner_user_id IS NULL OR NOT (
     EXISTS (SELECT 1 FROM user_credentials c WHERE c.user_id = p.owner_user_id)
     OR EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = p.owner_user_id)
   )`);
  // 所有者を安全に確定できない旧計画と、ログイン不能ownerの計画は閲覧専用sampleにする。
  await conn.query(`UPDATE plans p SET p.source = 'sample', p.open_editing = 0
   WHERE p.owner_user_id IS NULL OR NOT (
     EXISTS (SELECT 1 FROM user_credentials c WHERE c.user_id = p.owner_user_id)
     OR EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = p.owner_user_id)
   )`);

  // 有効な費用・精算から参照される旧メンバーはactiveへ戻し、孤立参照を解消する。
  await conn.query(`UPDATE plan_members pm SET pm.status = 'active'
   WHERE EXISTS (SELECT 1 FROM expenses e
                  WHERE e.plan_id = pm.plan_id AND e.deleted_at IS NULL AND e.payer_user_id = pm.user_id)
      OR EXISTS (SELECT 1 FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
                  WHERE e.plan_id = pm.plan_id AND e.deleted_at IS NULL AND s.user_id = pm.user_id)
      OR EXISTS (SELECT 1 FROM settlements s
                  WHERE s.plan_id = pm.plan_id AND s.deleted_at IS NULL
                    AND (s.from_user_id = pm.user_id OR s.to_user_id = pm.user_id))`);

  // 再有効化した行も含め、確定したownerだけを昇格する。viewer/editorの既存権限は保つ。
  await conn.query(`UPDATE plan_members pm JOIN plans p ON p.id = pm.plan_id
     SET pm.role = 'owner'
   WHERE pm.status = 'active' AND pm.user_id = p.owner_user_id AND pm.role <> 'owner'`);
  // 古いowner行が複数残る場合だけ、余分なownerをeditorへ戻す。
  await conn.query(`UPDATE plan_members pm JOIN plans p ON p.id = pm.plan_id
     SET pm.role = 'editor'
   WHERE pm.status = 'active' AND pm.role = 'owner' AND pm.user_id <> p.owner_user_id`);

  // 編集可能な通常計画の旧「名前だけメンバー」を、本人がclaimできるplaceholderへ移す。
  await conn.query(`INSERT IGNORE INTO plan_member_placeholders
      (plan_id, user_id, original_name, status, created_by_id)
    SELECT pm.plan_id, pm.user_id, u.display_name, 'unclaimed', p.owner_user_id
      FROM plan_members pm
      JOIN plans p ON p.id = pm.plan_id AND p.source = 'local' AND p.owner_user_id IS NOT NULL
      JOIN users u ON u.id = pm.user_id
     WHERE pm.status = 'active' AND pm.role <> 'owner'
       AND NOT EXISTS (SELECT 1 FROM user_credentials c WHERE c.user_id = pm.user_id)
       AND NOT EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = pm.user_id)`);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  }
}

async function migrate012() {
  if (!(await exists(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'user_credentials' AND COLUMN_NAME = 'recovery_code_hash'",
    [database],
  ))) {
    await conn.query("ALTER TABLE user_credentials ADD COLUMN recovery_code_hash VARBINARY(32) NULL AFTER iterations");
  }
  if (!(await exists(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'user_credentials' AND COLUMN_NAME = 'recovery_code_created_at'",
    [database],
  ))) {
    await conn.query("ALTER TABLE user_credentials ADD COLUMN recovery_code_created_at TIMESTAMP NULL DEFAULT NULL AFTER recovery_code_hash");
  }
  if (!(await exists(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'settlements' AND COLUMN_NAME = 'deleted_by_id'",
    [database],
  ))) {
    await conn.query("ALTER TABLE settlements ADD COLUMN deleted_by_id VARCHAR(32) NULL AFTER created_by_id");
  }
  if (!(await exists(
    "SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'settlements' AND CONSTRAINT_NAME = 'fk_settlements_deleter'",
    [database],
  ))) {
    await conn.query("ALTER TABLE settlements ADD CONSTRAINT fk_settlements_deleter FOREIGN KEY (deleted_by_id) REFERENCES users (id) ON DELETE SET NULL");
  }
}

async function main() {
  await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);

  await applyMigration("003_security_hardening", migrate003);
  await applyMigration("004_cover_storage_contract", migrate004);
  await applyMigration("005_ai_usage_limits", migrate005);
  await applyMigration("006_line_login", migrate006);
  await applyMigration("007_remove_external_plan_sources", migrate007);
  await applyMigration("008_placeholder_plan_members", migrate008);
  await applyMigration("009_member_participation_dates", migrate009);
  await applyMigration("010_itinerary_item_members", migrate010);
  await applyMigration("011_membership_integrity", migrate011);
  await applyMigration("012_account_recovery_and_settlement_audit", migrate012);
}

// 同時デプロイが同じDDLを並走させないよう、DB側の advisory lock で直列化する。
const LOCK_NAME = "travel_plan_migrate";
try {
  const [rows] = await conn.query("SELECT GET_LOCK(?, 60) AS ok", [LOCK_NAME]);
  if (Number(rows[0]?.ok) !== 1) {
    throw new Error("別のマイグレーションが実行中です。完了を待ってから再実行してください");
  }
  await main();
} finally {
  // 後始末の失敗で本来のエラーを隠さない。
  await conn.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]).catch(() => {});
  await conn.end().catch(() => {});
}
