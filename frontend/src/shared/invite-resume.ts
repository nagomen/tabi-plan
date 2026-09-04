const KEY = "tabi-plan-invite-return";

/** 招待fragmentをサーバーへ送らず、同じタブのログイン完了まで一時保持する。 */
export function rememberInviteReturn(raw: string): boolean {
  try {
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin) return false;
    const params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    if (!params.get("join")) return false;
    sessionStorage.setItem(KEY, JSON.stringify({
      value: `${url.pathname}${url.search}#${params.toString()}`,
      expiresAt: Date.now() + 30 * 60 * 1000,
    }));
    return true;
  } catch {
    return false;
  }
}

export function readInviteReturn(consume = false): string {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (consume) sessionStorage.removeItem(KEY);
    if (!raw) return "";
    const parsed = JSON.parse(raw) as { value?: string; expiresAt?: number };
    if (!parsed.value || !parsed.expiresAt || parsed.expiresAt < Date.now()) {
      sessionStorage.removeItem(KEY);
      return "";
    }
    const url = new URL(parsed.value, location.href);
    if (url.origin !== location.origin) return "";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "";
  }
}
