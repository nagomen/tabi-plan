// 送金リンク帳（メンバー名 → PayPay 受取リンク/ID）。
// PayPay には「金額を埋め込んだ個人宛 URL」の公式仕様が無いため、
// 各メンバーの受取リンク（または ID）を端末内に登録しておき、精算時に
// 「相手のリンクを開く＋金額をクリップボードへコピー」して送金を補助する。
// 全計画で共有できるよう、計画ではなく端末（localStorage）に名前キーで保存する。

import * as Backend from "./backend";

const KEY = "trip-dashboard-pay-links";

export interface PayLink {
  /** PayPay 受取リンク（https://...）または ID/表示名 */
  paypay?: string;
}

export type PayLinkMap = Record<string, PayLink>;

function readAll(): PayLinkMap {
  const parsed = Backend.getJSON<PayLinkMap>(KEY, {});
  return parsed && typeof parsed === "object" ? parsed : {};
}

function writeAll(map: PayLinkMap): void {
  Backend.setJSON(KEY, map);
}

export function getPayLinks(): PayLinkMap {
  return readAll();
}

export function getPayLink(name: string): PayLink | null {
  const key = String(name || "").trim();
  if (!key) return null;
  return readAll()[key] || null;
}

/** 受取リンク/ID を設定（空文字ならその名前のエントリを削除）。 */
export function setPayLink(name: string, paypay: string): void {
  const key = String(name || "").trim();
  if (!key) return;
  const map = readAll();
  const value = String(paypay || "").trim();
  if (value) map[key] = { paypay: value };
  else delete map[key];
  writeAll(map);
}

/** 文字列が開ける URL かどうか（PayPay 受取リンク等）。 */
export function isPayUrl(value: string | undefined): boolean {
  return /^https?:\/\//i.test(String(value || "").trim());
}
