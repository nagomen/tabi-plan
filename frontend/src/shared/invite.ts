// 招待リンク: 計画データ(JSON)をリンクに埋め込み、開いた端末に取り込む方式。
// サーバー無しでも友達と計画を共有できる。
//
// URL が長くなりがちなので、対応ブラウザでは gzip 圧縮してから base64url 化する
// （先頭に "." を付けて圧縮版を示す）。CompressionStream 非対応の環境や、
// 旧来の無圧縮リンク（プレフィックス無し）もそのまま読める。

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

/** 圧縮版トークンの先頭マーカー（base64url の文字集合に含まれない記号） */
const GZIP_PREFIX = ".";

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(token: string): Uint8Array {
  const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pipeThrough(bytes: Uint8Array, transform: GenericTransformStream): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

const hasCompression = typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";

export async function encodeInvite(payload: InvitePayload): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const raw = bytesToB64url(bytes);
  if (hasCompression) {
    try {
      const gz = await pipeThrough(bytes, new CompressionStream("gzip"));
      const compressed = GZIP_PREFIX + bytesToB64url(gz);
      // 圧縮で短くなる場合だけ採用する（小さい計画は無圧縮の方が短いことがある）
      if (compressed.length < raw.length) return compressed;
    } catch {
      /* 圧縮失敗時は無圧縮にフォールバック */
    }
  }
  return raw;
}

export async function decodeInvite(token: string): Promise<InvitePayload | null> {
  try {
    let json: string;
    if (token.startsWith(GZIP_PREFIX)) {
      if (!hasCompression) return null;
      const gz = b64urlToBytes(token.slice(GZIP_PREFIX.length));
      json = new TextDecoder().decode(await pipeThrough(gz, new DecompressionStream("gzip")));
    } else {
      json = new TextDecoder().decode(b64urlToBytes(token));
    }
    const obj = JSON.parse(json) as InvitePayload;
    return obj && obj.meta && obj.data ? obj : null;
  } catch {
    return null;
  }
}

/** plans.html#join=<token> 形式の招待 URL を作る（取り込みは plans 側で処理）。 */
export async function buildInviteLink(payload: InvitePayload): Promise<string> {
  const url = new URL("plans.html", location.href);
  url.hash = "join=" + (await encodeInvite(payload));
  return url.toString();
}
