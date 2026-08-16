import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const MIN_SECRET_LENGTH = 32;

/**
 * SESSION_SECRET 未設定のローカル開発でだけ使う秘密値を、git管理外のファイルへ保存する。
 * 再起動のたびに値を変えるとブラウザに残った全セッションが無効になるため、端末内では再利用する。
 */
export function persistentDevSessionSecret(filePath) {
  if (existsSync(filePath)) {
    const stored = readFileSync(filePath, "utf8").trim();
    if (stored.length < MIN_SECRET_LENGTH) {
      throw new Error(`開発用セッション秘密値 ${filePath} が短すぎます。ファイルを削除して再起動してください`);
    }
    return stored;
  }

  const secret = randomBytes(48).toString("base64url");
  writeFileSync(filePath, `${secret}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return secret;
}
