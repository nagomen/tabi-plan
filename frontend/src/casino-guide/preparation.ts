function savedCheckValues(serialized: string | null): Set<string> {
  if (!serialized) return new Set();
  try {
    const value = JSON.parse(serialized) as unknown;
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

/** 入場前チェックを旅行ごと・端末ごとに保存する。 */
export function initializePreparationChecklist(storageKey: string): void {
  const checks = Array.from(
    document.querySelectorAll<HTMLInputElement>("[data-prep-list] input[type='checkbox']"),
  );
  if (!checks.length) return;

  let saved = new Set<string>();
  try {
    saved = savedCheckValues(localStorage.getItem(storageKey));
  } catch {
    // localStorage が利用不可でもチェック操作自体は使える。
  }

  checks.forEach((check) => {
    check.checked = saved.has(check.value);
    check.addEventListener("change", () => {
      const selected = checks.filter((item) => item.checked).map((item) => item.value);
      try {
        localStorage.setItem(storageKey, JSON.stringify(selected));
      } catch {
        // プライベートモード等では永続化せず、その場の状態だけ保持する。
      }
    });
  });
}
