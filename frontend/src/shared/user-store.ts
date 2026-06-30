// 端末内のユーザー情報（マイページ）。
// 保存は backend（差し替え口）経由。将来 DB / アカウントへ移行する際は
// backend.ts を差し替えるだけでよい（このファイルは変更不要）。

import * as Backend from "./backend";

export interface User {
  name: string;
  updatedAt?: string;
}

const KEY = "trip-dashboard-user";

export function getUser(): User {
  const raw = Backend.getJSON<Partial<User>>(KEY, {});
  return { name: (raw.name || "").trim(), updatedAt: raw.updatedAt };
}

export function setUserName(name: string): User {
  const user: User = { name: name.trim(), updatedAt: new Date().toISOString() };
  Backend.setJSON(KEY, user);
  return user;
}
