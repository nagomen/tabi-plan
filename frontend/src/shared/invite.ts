// 招待リンク: 計画データ(JSON)をリンクに埋め込み、開いた端末に取り込む方式。
// サーバー無しでも友達と計画を共有できる（大きな計画は URL が長くなる点に注意）。

import type { LocalPlanData } from "./plans-store";

export interface InviteMeta {
  slug: string;
  title: string;
  dates?: string;
  members?: string;
  route?: string;
}

export interface InvitePayload {
  v: 1;
  meta: InviteMeta;
  data: LocalPlanData;
  invitedName?: string;
}

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(token: string): string {
  const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeInvite(payload: InvitePayload): string {
  return b64urlEncode(JSON.stringify(payload));
}

export function decodeInvite(token: string): InvitePayload | null {
  try {
    const obj = JSON.parse(b64urlDecode(token)) as InvitePayload;
    return obj && obj.meta && obj.data ? obj : null;
  } catch {
    return null;
  }
}

/** plans.html#join=<token> 形式の招待 URL を作る（取り込みは plans 側で処理）。 */
export function buildInviteLink(payload: InvitePayload): string {
  const url = new URL("plans.html", location.href);
  url.hash = "join=" + encodeInvite(payload);
  return url.toString();
}
