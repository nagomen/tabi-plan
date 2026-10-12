// 共有URLの #fragment から閲覧トークンを取り出す。トークンはサーバーへも Referer へも送られない。

export const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface Access {
  token: string;
  /** 債務者専用リンク（#manage=…）。返済の記録ができる。 */
  manage: boolean;
}

export function accessFromFragment(hash: string): Access {
  const fragment = hash.replace(/^#/, "");
  try {
    const params = new URLSearchParams(fragment);
    const managementToken = params.get("manage");
    const token = managementToken || params.get("token") || fragment;
    return { token: decodeURIComponent(token).trim(), manage: Boolean(managementToken) };
  } catch {
    // %の後ろが欠けた貼り付けなど。形式チェックで「URLが正しくない」と案内する。
    return { token: "", manage: false };
  }
}
