// パスワードの鍵導出（PBKDF2-HMAC-SHA256）。DB に依存しない純粋なロジックとして
// auth-repo から切り出し、単体テストできるようにする。

import crypto from "node:crypto";
import { promisify } from "node:util";
import { BadRequest } from "./errors.js";

const pbkdf2 = promisify(crypto.pbkdf2);

/** 現行の反復回数。ログイン時にこれ未満なら作り直す。 */
export const PASSWORD_ITERATIONS = 600_000;

export async function passwordHash(password: string, salt: Buffer, iterations = PASSWORD_ITERATIONS): Promise<Buffer> {
  return pbkdf2(String(password || ""), salt, iterations, 32, "sha256");
}

export function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface StoredPassword {
  salt: Buffer;
  hash: Buffer;
  iterations: number;
}

/** 平文から新しいソルト付きハッシュ一式を作る。 */
export async function hashNewPassword(password: string): Promise<StoredPassword> {
  const salt = crypto.randomBytes(16);
  const hash = await passwordHash(password, salt, PASSWORD_ITERATIONS);
  return { salt, hash, iterations: PASSWORD_ITERATIONS };
}

/** 保存済みハッシュと定数時間で照合する。 */
export async function verifyPassword(password: string, stored: StoredPassword): Promise<boolean> {
  const candidate = await passwordHash(password, stored.salt, stored.iterations || PASSWORD_ITERATIONS);
  return timingSafeEqual(candidate, stored.hash);
}

/** 反復回数が現行より弱ければ、ログイン成功時に作り直すべき。 */
export function needsRehash(iterations: number): boolean {
  return (iterations || 0) < PASSWORD_ITERATIONS;
}

/** 長さポリシー。満たさなければ 400 相当の BadRequest。 */
export function validatePassword(password: string): string {
  const value = String(password || "");
  if (value.length < 8) throw new BadRequest("パスワードは8文字以上にしてください");
  if (value.length > 256) throw new BadRequest("パスワードは256文字以下にしてください");
  return value;
}
