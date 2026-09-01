#!/usr/bin/env node
// 既存の TravelPlan DB に後方互換な差分を適用する。
// DDL は MySQL で暗黙コミットされるため、各変更を information_schema で確認して
// 冪等に実行し、最後に schema_migrations へ記録する。

import mysql from "mysql2/promise";

const database = process.env.DB_NAME || "TravelPlan";
const conn = await mysql.createConnection({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database,
  charset: "utf8mb4",
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
}

try {
  await main();
} finally {
  await conn.end();
}
