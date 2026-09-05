-- 旅行ダッシュボード: リレーショナル設計（001 の kv_store を置き換える）
--
-- 001 は「localStorage のキー→JSON」をそのまま DB に載せただけで、
-- 実データを見ると次の問題が出ていた（レビュー結果）:
--   - 人が「表示名の文字列」で参照され、メンバー13名のうちアカウントと一致するのは1名だけ
--   - 参加者が連結文字列（'なごめん、かな、パム、さな'）＝多対多を表現できない
--   - 行程242件すべてに id が無く、行単位の更新ができない
--   - 費用が1旅行=1キーの配列なので、同時追加が 409 で片方消える
--   - 割り勘方式が日本語文字列で、/精算不要/.test() のような正規表現で分岐
--   - currency を持つのに換算せず円として表示（多通貨が実質未実装）
--
-- 設計方針:
--   - 人は users に一本化する。ログイン情報が無い参加者も users 行を持つ
--     （招待前でも実体を持たせる方針）。認証情報は user_credentials に分離。
--   - メンバーシップと権限を plan_members 1枚に統合する
--     （旧 members 文字列 + planPermissions の二重管理をやめる）
--   - 費用は expenses（1件=1行）+ expense_shares（誰がいくら負担）に正規化。
--     INSERT で追加できるので同時追加の衝突が消える。
--   - 金額は最小通貨単位の整数で持つ（浮動小数を使わない）。
--   - 主キーは既存 ID を引き継げるよう VARCHAR(32) の接頭辞付き ID
--     （usr_ / pln_ / exp_ …）。BIGINT より索引は太いが、規模が小さく
--     ログの可読性と移行の容易さを優先する。

SET NAMES utf8mb4;
USE TravelPlan;

-- ============================================================
-- ユーザー関係管理
-- ============================================================

-- 人。ログインできるかどうかに関わらず1人1行。
-- 「かな」のようなアカウント未登録の参加者もここに入る。
CREATE TABLE users (
  id            VARCHAR(32)  NOT NULL,
  display_name  VARCHAR(64)  NOT NULL,           -- 一意ではない（同名を許す）
  -- 招待や検索で名前を突き合わせるための正規化キー（前後空白除去・小文字化）。
  -- 同名を許すため UNIQUE にはしない。
  name_key      VARCHAR(64)  NOT NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_users_name_key (name_key)
) ENGINE=InnoDB;

-- 認証情報。users と 1:0..1。アカウント未登録の人はこの行を持たない。
-- パスワードハッシュを users から分離し、profile 取得時に触らせない。
CREATE TABLE user_credentials (
  user_id        VARCHAR(32)  NOT NULL,
  email          VARCHAR(255) NOT NULL,
  password_salt  VARBINARY(64) NOT NULL,
  password_hash  VARBINARY(64) NOT NULL,
  algorithm      VARCHAR(32)  NOT NULL DEFAULT 'pbkdf2-sha256',
  iterations     INT UNSIGNED NOT NULL DEFAULT 600000,
  recovery_code_hash VARBINARY(32) NULL,
  recovery_code_created_at TIMESTAMP NULL DEFAULT NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  UNIQUE KEY uq_user_credentials_email (email),
  CONSTRAINT fk_user_credentials_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ログインセッション。ブラウザにはランダムな生トークン、DBにはHMACだけを置く。
-- ログアウト・端末紛失・パスワード変更時にサーバー側で失効できる。
CREATE TABLE user_sessions (
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
) ENGINE=InnoDB;

-- AIの費用上限・クールダウンを複数プロセスで共有する日次利用量。
CREATE TABLE ai_usage_daily (
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
) ENGINE=InnoDB;

-- 送金の受取先。旧 payment-links は「名前」がキーだったので改名で壊れていた。
CREATE TABLE user_payment_links (
  user_id     VARCHAR(32) NOT NULL,
  provider    ENUM('paypay') NOT NULL,
  -- 受取リンク（https://…）または ID。どちらも来るので用途で分けない。
  handle      VARCHAR(255) NOT NULL,
  updated_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, provider),
  CONSTRAINT fk_payment_links_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 便（飛行機の移動）ごとの個人メモ。リンク・予約番号・座席・QR画像（data URL）。
-- 行程は保存のたびに全行を作り直して id が変わるため、行 id ではなく
-- 内容由来の便名（UO857 等）でひも付ける。本人の行だけを bootstrap で返す。
CREATE TABLE plan_flight_notes (
  plan_id     VARCHAR(32)  NOT NULL,
  user_id     VARCHAR(32)  NOT NULL,
  flight_no   VARCHAR(16)  NOT NULL,
  link_url    VARCHAR(500) NULL,
  booking_ref VARCHAR(100) NULL,
  seat        VARCHAR(50)  NULL,
  qr_image    MEDIUMTEXT   NULL,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (plan_id, user_id, flight_no),
  CONSTRAINT fk_flight_notes_plan FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE,
  CONSTRAINT fk_flight_notes_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 表示設定。旧 history-privacy も名前キーだった。
CREATE TABLE user_settings (
  user_id         VARCHAR(32) NOT NULL,
  history_public  TINYINT(1)  NOT NULL DEFAULT 1,
  updated_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_user_settings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 友達関係。承諾済みの1行が双方向のエッジを表す（現行の考え方を踏襲）。
-- 旧 friendRequests は fromName/fromEmail も抱えていて改名でズレるので、ID だけ持つ。
-- 同じ2人の重複申請を DB で防ぐため、常に (小さいID, 大きいID) の順で格納する。
CREATE TABLE friendships (
  id            VARCHAR(32) NOT NULL,
  user_low_id   VARCHAR(32) NOT NULL,
  user_high_id  VARCHAR(32) NOT NULL,
  -- 誰が申請したか（low/high の並びとは独立）
  requested_by_id VARCHAR(32) NOT NULL,
  status        ENUM('pending','accepted','declined','canceled','removed') NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at  TIMESTAMP   NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_friendship_pair (user_low_id, user_high_id),
  KEY idx_friendship_high (user_high_id),
  CONSTRAINT fk_friendship_low  FOREIGN KEY (user_low_id)  REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_friendship_high FOREIGN KEY (user_high_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_friendship_order CHECK (user_low_id < user_high_id)
) ENGINE=InnoDB;

-- ============================================================
-- 旅行計画管理
-- ============================================================

CREATE TABLE plans (
  id              VARCHAR(32) NOT NULL,
  slug            VARCHAR(64) NOT NULL,          -- URL 用。既存の trip-10 等を引き継ぐ
  title           VARCHAR(120) NOT NULL,
  note            TEXT        NULL,
  -- 日付は構造化する。ただし現データは '2026年8月' のように日が無いものがあるため、
  -- 元の表示文字列も残す（表示は label があればそれを優先）。
  start_date      DATE        NULL,
  end_date        DATE        NULL,
  dates_label     VARCHAR(64) NULL,
  -- 通常はURL。エディタで圧縮した小容量 WebP data URL も保存するため MEDIUMTEXT。
  -- アプリ/API側で300KBに制限し、無制限な画像格納には使わない。
  cover_url       MEDIUMTEXT NULL,
  base_currency   CHAR(3)     NOT NULL DEFAULT 'JPY',
  source          ENUM('local','sample') NOT NULL DEFAULT 'local',
  visibility      ENUM('public','invite') NOT NULL DEFAULT 'public',
  status          ENUM('draft','published') NOT NULL DEFAULT 'draft',
  version         BIGINT UNSIGNED NOT NULL DEFAULT 1, -- 本文・メタ保存の楽観ロック
  -- 公開済み計画の本文を、ログイン済み利用者が共同編集できる設定。
  -- メンバー・費用・精算・公開設定の権限は付与しない。
  open_editing    TINYINT(1)  NOT NULL DEFAULT 0,
  owner_user_id   VARCHAR(32) NULL,              -- 作成者。plan_members の owner と重複するが引きやすさのため保持
  created_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at      TIMESTAMP   NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_plans_slug (slug),
  KEY idx_plans_owner (owner_user_id),
  KEY idx_plans_discover (visibility, status, deleted_at),
  CONSTRAINT fk_plans_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 参加者＝権限。旧 members 文字列と planPermissions を1枚に統合する。
-- 「メンバーだから編集できる」「権限行があるから編集できる」の二重判定をやめる。
CREATE TABLE plan_members (
  plan_id     VARCHAR(32) NOT NULL,
  user_id     VARCHAR(32) NOT NULL,
  role        ENUM('owner','editor','viewer') NOT NULL DEFAULT 'editor',
  status      ENUM('active','left','revoked') NOT NULL DEFAULT 'active',
  invited_by_id VARCHAR(32) NULL,
  -- 旅行内の参加期間（途中合流/離脱）。NULL は「全日程」を意味する。
  -- 割り勘の「全員で等分」は、費用の日付にこの期間が重なるメンバーだけを対象にする。
  from_date   DATE        NULL,
  to_date     DATE        NULL,
  joined_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (plan_id, user_id),
  KEY idx_plan_members_user (user_id, status),
  CONSTRAINT fk_plan_members_plan FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE,
  CONSTRAINT fk_plan_members_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_plan_members_inviter FOREIGN KEY (invited_by_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- アプリ未登録・友達ではない人を、旅行内の仮メンバーとして先に扱う。
-- users 行を持たせることで、登録前でも費用・精算・投票を user_id で参照できる。
-- 同名で既存ユーザーを自動照合せず、招待を受けた本人だけが後から claim する。
CREATE TABLE plan_member_placeholders (
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
) ENGINE=InnoDB;

-- 招待。トークンは平文で保存しない（現行は inviteId が分かれば editor が取れてしまう）。
CREATE TABLE plan_invites (
  id            VARCHAR(32) NOT NULL,
  plan_id       VARCHAR(32) NOT NULL,
  token_hash    VARBINARY(32) NOT NULL,          -- sha256(token)
  role          ENUM('editor','viewer') NOT NULL DEFAULT 'editor',
  status        ENUM('pending','accepted','revoked','expired') NOT NULL DEFAULT 'pending',
  invited_name  VARCHAR(64) NULL,                -- 宛先の表示名（任意）
  invited_user_id  VARCHAR(32) NULL,
  created_by_id VARCHAR(32) NOT NULL,
  accepted_by_id VARCHAR(32) NULL,
  expires_at    TIMESTAMP   NULL DEFAULT NULL,
  created_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at   TIMESTAMP   NULL DEFAULT NULL,
  revoked_at    TIMESTAMP   NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_plan_invites_token (token_hash),
  KEY idx_plan_invites_plan (plan_id, status),
  KEY idx_plan_invites_user (invited_user_id, status),
  CONSTRAINT fk_plan_invites_plan FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE,
  CONSTRAINT fk_plan_invites_creator FOREIGN KEY (created_by_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_plan_invites_user FOREIGN KEY (invited_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 行程。現データ242件は id を持たないので、移行時に採番する。
-- weather は列にしない（実測値ではなくキャッシュなので、必要なら別テーブル）。
CREATE TABLE itinerary_items (
  id          VARCHAR(32) NOT NULL,
  plan_id     VARCHAR(32) NOT NULL,
  item_date   DATE        NULL,
  day_index   SMALLINT    NULL,                  -- 「Day 3」表示用。date から導出できるが現データを踏襲
  sort_order  INT         NOT NULL DEFAULT 0,    -- 同一日内の並び。並び替えを行単位でできるようにする
  kind        ENUM('sight','move','food','stay','todo','form') NOT NULL DEFAULT 'sight',
  start_time  TIME        NULL,
  title       VARCHAR(200) NOT NULL DEFAULT '',
  place       VARCHAR(200) NULL,
  area        VARCHAR(100) NULL,
  note        TEXT        NULL,
  map_query   VARCHAR(200) NULL,
  lat         DECIMAL(9,6) NULL,
  lng         DECIMAL(9,6) NULL,
  -- 移動（kind='move'）用。現データには未使用だがエディタが対応しているため用意する。
  from_place  VARCHAR(200) NULL,
  from_lat    DECIMAL(9,6) NULL,
  from_lng    DECIMAL(9,6) NULL,
  to_place    VARCHAR(200) NULL,
  to_lat      DECIMAL(9,6) NULL,
  to_lng      DECIMAL(9,6) NULL,
  transport   VARCHAR(60) NULL,
  duration_minutes SMALLINT UNSIGNED NULL,
  -- この項目の対象メンバー（user_id の JSON 配列）。NULL = その日の在籍メンバー全員。
  member_ids  TEXT        NULL,
  created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_itinerary_plan_order (plan_id, item_date, sort_order),
  CONSTRAINT fk_itinerary_plan FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE plan_cities (
  id          VARCHAR(32) NOT NULL,
  plan_id     VARCHAR(32) NOT NULL,
  name        VARCHAR(100) NOT NULL,
  from_date   DATE         NULL,
  to_date     DATE         NULL,
  lat         DECIMAL(9,6) NULL,
  lng         DECIMAL(9,6) NULL,
  sort_order  INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_plan_cities_plan (plan_id, sort_order),
  CONSTRAINT fk_plan_cities_plan FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE plan_links (
  id          VARCHAR(32) NOT NULL,
  plan_id     VARCHAR(32) NOT NULL,
  link_key    VARCHAR(40) NOT NULL,              -- itinerary / maps / photos …
  label       VARCHAR(80) NOT NULL,
  url         VARCHAR(1024) NOT NULL,
  caption     VARCHAR(80) NULL,
  sort_order  INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_plan_links (plan_id, link_key),
  CONSTRAINT fk_plan_links_plan FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE plan_checklist_items (
  id          VARCHAR(32) NOT NULL,
  plan_id     VARCHAR(32) NOT NULL,
  label       VARCHAR(200) NOT NULL,
  status      ENUM('todo','doing','done') NOT NULL DEFAULT 'todo',
  sort_order  INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_checklist_plan (plan_id, sort_order),
  CONSTRAINT fk_checklist_plan FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 行きたい候補と投票。旧 candidates は votes を名前配列で持っていた（43件すべて）。
CREATE TABLE plan_candidates (
  id             VARCHAR(32) NOT NULL,
  plan_id        VARCHAR(32) NOT NULL,
  title          VARCHAR(200) NOT NULL,
  place          VARCHAR(200) NULL,
  proposed_by_id VARCHAR(32) NULL,
  adopted_at     TIMESTAMP   NULL DEFAULT NULL,
  created_at     TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_candidates_plan (plan_id),
  CONSTRAINT fk_candidates_plan FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE,
  CONSTRAINT fk_candidates_proposer FOREIGN KEY (proposed_by_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE plan_candidate_votes (
  candidate_id VARCHAR(32) NOT NULL,
  user_id      VARCHAR(32) NOT NULL,
  created_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (candidate_id, user_id),
  CONSTRAINT fk_votes_candidate FOREIGN KEY (candidate_id) REFERENCES plan_candidates (id) ON DELETE CASCADE,
  CONSTRAINT fk_votes_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 閲覧数。旧 views は slug→合計の単一マップだったので、日別に持って推移も取れるようにする。
CREATE TABLE plan_view_daily (
  plan_id    VARCHAR(32) NOT NULL,
  viewed_on  DATE        NOT NULL,
  view_count INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (plan_id, viewed_on),
  CONSTRAINT fk_view_daily_plan FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- 費用管理
-- ============================================================

-- 立替1件=1行。INSERT で足せるので、複数端末の同時追加で衝突しない
-- （旧構造は1旅行=1キーの配列だったため 409 で片方が消えていた）。
CREATE TABLE expenses (
  id              VARCHAR(32) NOT NULL,
  plan_id         VARCHAR(32) NOT NULL,
  paid_on         DATE        NULL,
  payer_user_id   VARCHAR(32) NOT NULL,
  category        ENUM('food','transport','lodging','sightseeing','communication','other')
                  NOT NULL DEFAULT 'other',
  title           VARCHAR(200) NOT NULL DEFAULT '',
  -- 金額は最小通貨単位の整数（JPY なら円、USD ならセント）。浮動小数を持たない。
  amount_minor    BIGINT      NOT NULL,
  currency        CHAR(3)     NOT NULL DEFAULT 'JPY',
  -- 記録時点のレートと、計画の base_currency 換算後の額。
  -- 旧実装は currency を持ちながら換算せず円として表示していた。
  fx_rate         DECIMAL(18,8) NOT NULL DEFAULT 1,
  amount_base_minor BIGINT    NOT NULL,
  -- 割り勘の決め方。旧 splitMode は日本語文字列で /精算不要/.test() で分岐していた。
  -- 実際の負担額は expense_shares が正で、これは「どう配ったか」の記録。
  split_method    ENUM('equal_all','equal_selected','custom','none') NOT NULL DEFAULT 'equal_all',
  payment_method  ENUM('card','cash','transfer','other') NULL,
  note            TEXT        NULL,
  receipt_url     VARCHAR(1024) NULL,
  created_by_id   VARCHAR(32) NULL,
  created_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- UI に「元に戻す」があるので物理削除しない
  deleted_at      TIMESTAMP   NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_expenses_plan (plan_id, deleted_at, paid_on),
  KEY idx_expenses_payer (payer_user_id),
  CONSTRAINT fk_expenses_plan  FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE,
  CONSTRAINT fk_expenses_payer FOREIGN KEY (payer_user_id) REFERENCES users (id),
  CONSTRAINT fk_expenses_creator FOREIGN KEY (created_by_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_expenses_amount CHECK (amount_minor >= 0)
) ENGINE=InnoDB;

-- 誰がいくら負担するか。旧構造は targets（配列）と individual（名前→金額）に
-- 分割方式ごとに別の形で入っていたため、SQL で負担額を出せなかった。
CREATE TABLE expense_shares (
  expense_id   VARCHAR(32) NOT NULL,
  user_id      VARCHAR(32) NOT NULL,
  -- base_currency 換算後の負担額。等分の端数もここで確定させる（合計＝支払額）。
  amount_base_minor BIGINT NOT NULL,
  PRIMARY KEY (expense_id, user_id),
  KEY idx_shares_user (user_id),
  CONSTRAINT fk_shares_expense FOREIGN KEY (expense_id) REFERENCES expenses (id) ON DELETE CASCADE,
  CONSTRAINT fk_shares_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_shares_amount CHECK (amount_base_minor >= 0)
) ENGINE=InnoDB;

-- 金銭データの変更履歴。editor が他メンバーの費用も訂正できるため、
-- 誰がいつ何を変更したかを必ず残す。
CREATE TABLE expense_audit_logs (
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
) ENGINE=InnoDB;

-- 精算（誰が誰にいくら払ったか）。
-- 旧構造は expenses に kind='settlement' で同居させ、targets[0] を受取人として
-- 流用していたため、行によってフィールドの意味が変わっていた。
CREATE TABLE settlements (
  id            VARCHAR(32) NOT NULL,
  plan_id       VARCHAR(32) NOT NULL,
  from_user_id  VARCHAR(32) NOT NULL,
  to_user_id    VARCHAR(32) NOT NULL,
  amount_base_minor BIGINT  NOT NULL,
  note          TEXT        NULL,
  settled_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by_id VARCHAR(32) NULL,
  deleted_by_id VARCHAR(32) NULL,
  deleted_at    TIMESTAMP   NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_settlements_plan (plan_id, deleted_at),
  CONSTRAINT fk_settlements_plan FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE,
  CONSTRAINT fk_settlements_from FOREIGN KEY (from_user_id) REFERENCES users (id),
  CONSTRAINT fk_settlements_to   FOREIGN KEY (to_user_id) REFERENCES users (id),
  CONSTRAINT fk_settlements_deleter FOREIGN KEY (deleted_by_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_settlements_parties CHECK (from_user_id <> to_user_id),
  CONSTRAINT chk_settlements_amount CHECK (amount_base_minor > 0)
) ENGINE=InnoDB;

-- ============================================================
-- 参考: 精算残高を SQL で出せるようになる（旧構造では不可能だった）
-- ============================================================
--
-- CREATE VIEW plan_balances AS
-- SELECT plan_id, user_id, SUM(delta) AS net_base_minor FROM (
--   -- 立替（払った）
--   SELECT plan_id, payer_user_id AS user_id,  amount_base_minor AS delta
--     FROM expenses WHERE deleted_at IS NULL
--   UNION ALL
--   -- 負担（自分の取り分）
--   SELECT e.plan_id, s.user_id, -s.amount_base_minor
--     FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
--    WHERE e.deleted_at IS NULL
--   UNION ALL
--   -- 精算済みの送金
--   SELECT plan_id, from_user_id,  amount_base_minor FROM settlements WHERE deleted_at IS NULL
--   UNION ALL
--   SELECT plan_id, to_user_id,   -amount_base_minor FROM settlements WHERE deleted_at IS NULL
-- ) t GROUP BY plan_id, user_id;
