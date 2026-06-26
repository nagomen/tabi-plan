// 全画面共有の DOM ユーティリティ。

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/** catch 節の unknown からメッセージ文字列を取り出す */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}

export interface ScopedQuery {
  qs: <E extends Element = HTMLElement>(selector: string, scope?: ParentNode) => E;
  qsa: <E extends Element = HTMLElement>(selector: string, scope?: ParentNode) => E[];
}

/**
 * ルート要素にスコープした型付き qs/qsa を返す。
 * qs は要素が無ければ throw（必須要素の取り違えを早期検出）。
 */
export function makeScopedQuery(root: ParentNode): ScopedQuery {
  function qs<E extends Element = HTMLElement>(selector: string, scope: ParentNode = root): E {
    const el = scope.querySelector(selector) as E | null;
    if (!el) throw new Error(`要素が見つかりません: ${selector}`);
    return el;
  }
  function qsa<E extends Element = HTMLElement>(selector: string, scope: ParentNode = root): E[] {
    return Array.from(scope.querySelectorAll(selector)) as E[];
  }
  return { qs, qsa };
}
