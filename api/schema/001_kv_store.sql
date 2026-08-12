-- 旅行ダッシュボードの共有ストア。
--
-- Vote とは独立した TravelPlan データベースに置く（同じ MySQL サーバーを間借りするだけ）。
-- フロントの各ストアは「キー → JSON」でしか保存しないため、まずは KV 1枚で受ける。
-- 費用などを正規化したくなったら、この表を残したままテーブルを足していける。

CREATE DATABASE IF NOT EXISTS TravelPlan
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE TravelPlan;

CREATE TABLE IF NOT EXISTS kv_store (
  -- 将来ユーザー別・旅行別に分けたくなったときの逃げ道。今は 'default' 固定。
  scope       VARCHAR(64)  NOT NULL DEFAULT 'default',
  -- localStorage のキーそのもの（trip-dashboard-plans など）。
  -- utf8mb4 の主キー長制限（3072バイト）に収めるため 191 文字までにする。
  k           VARCHAR(191) NOT NULL,
  v           JSON         NOT NULL,
  -- 楽観ロック用。更新のたびに +1 する。
  -- 費用のように「配列まるごと1キー」を複数端末が同時に書くと後勝ちで消えるため、
  -- クライアントは version を添えて PUT し、ズレていれば 409 を受けてマージし直す。
  version     INT UNSIGNED NOT NULL DEFAULT 1,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (scope, k),
  KEY idx_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
