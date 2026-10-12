import { useEffect, useState } from "react";
import type { DebtViewerError } from "../api";

/** 読み込み失敗の案内。retryable なら retry_after 秒のカウントダウン付きで再試行ボタンを出す。 */
export function ErrorPanel({ problem }: { problem: DebtViewerError }) {
  const [left, setLeft] = useState(Math.min(Math.max(0, problem.retryAfter), 600));

  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLeft((value) => value - 1), 1_000);
    return () => clearTimeout(timer);
  }, [left]);

  return (
    <section className="dn-error">
      <p className="dn-eyebrow">LINK UNAVAILABLE</p>
      <h1>{problem.title}</h1>
      <p className="dn-error-message">{problem.message}</p>
      {problem.requestId && <p className="dn-error-reference">問い合わせ番号：{problem.requestId}</p>}
      {problem.retryable && (
        <button className="dn-download dn-retry" type="button" disabled={left > 0} onClick={() => location.reload()}>
          {left > 0 ? `${left}秒後に再試行できます` : "もう一度読み込む"}
        </button>
      )}
    </section>
  );
}
