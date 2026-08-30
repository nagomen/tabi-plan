import type http from "node:http";

/**
 * 逆プロキシ(nginx)背後での実クライアントIP。
 *
 * trustCloudflare が真のときだけ CF-Connecting-IP を信頼する。それ以外は
 * X-Forwarded-For の「末尾」（nginx が観測した直近の接続元）を採り、
 * クライアントが先頭へ注入した偽の値を信用しない。
 */
export function clientIp(req: http.IncomingMessage, trustCloudflare: boolean): string {
  const cloudflare = req.headers["cf-connecting-ip"];
  if (trustCloudflare && typeof cloudflare === "string" && cloudflare) {
    return cloudflare.trim();
  }
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",").at(-1)?.trim() || "unknown";
  return req.socket.remoteAddress || "unknown";
}
