import { DebtViewerError } from "./api";

/** 利用者へ出す文言。想定外の例外（描画の不具合など）は英語の内部メッセージを見せない。 */
export function describe(error: unknown, fallback: string): DebtViewerError {
  if (error instanceof DebtViewerError) return error;
  console.error("[debt-viewer]", error);
  return new DebtViewerError(
    `${fallback}ページを再読み込みしてください。続く場合は送信者へお知らせください。`,
    "返済計画を表示できませんでした",
    true,
  );
}
