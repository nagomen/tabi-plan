// 端末内のユーザー情報（マイページ）。今は JSON / localStorage で保持する。
// 将来 DB / アカウントへ移行する際は getUser/setUserName の実装だけ差し替える。

export interface User {
  name: string;
  updatedAt?: string;
}

const KEY = "trip-dashboard-user";

export function getUser(): User {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<User>;
    return { name: (raw.name || "").trim(), updatedAt: raw.updatedAt };
  } catch {
    return { name: "" };
  }
}

export function setUserName(name: string): User {
  const user: User = { name: name.trim(), updatedAt: new Date().toISOString() };
  try {
    localStorage.setItem(KEY, JSON.stringify(user));
  } catch {
    /* ignore quota errors */
  }
  return user;
}
