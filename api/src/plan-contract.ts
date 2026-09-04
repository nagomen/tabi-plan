/** 計画APIで受け付けるフィールドの唯一の定義。HTTP層と永続化層で共有する。 */
export const PLAN_EDIT_FIELDS = new Set([
  "title", "note", "start_date", "end_date", "dates_label", "cover_url",
]);

// 公開共同編集はcontent APIの行程・都市だけ。旅行名・期間・画像は正式メンバーに限定する。
export const PLAN_COLLABORATE_FIELDS = new Set<string>();

export const PLAN_MANAGE_FIELDS = new Set([
  "slug", "source", "visibility", "status", "open_editing",
]);

export const PLAN_PATCH_FIELDS = new Set([...PLAN_EDIT_FIELDS, ...PLAN_MANAGE_FIELDS]);
// 基準通貨は費用・負担・精算の意味を決めるため作成時だけ指定できる。
export const PLAN_CREATE_FIELDS = new Set([...PLAN_PATCH_FIELDS, "owner_user_id", "base_currency"]);

export const MAX_COVER_VALUE_LENGTH = 300_000;

/** DB制約より先に、利用者へ説明できる400エラーへ変換する。 */
export function planFieldError(input: Record<string, unknown>): string {
  if (Object.prototype.hasOwnProperty.call(input, "base_currency") &&
      !/^[A-Z]{3}$/.test(String(input.base_currency || "").toUpperCase())) {
    return "基準通貨は3文字の通貨コードで指定してください";
  }
  if (Object.prototype.hasOwnProperty.call(input, "title") && String(input.title || "").trim().length > 120) {
    return "旅行名は120文字以内にしてください";
  }
  // 日付はDBのDATE型に入る前に検査する。厳格モードでは不正値が500になるため。
  for (const field of ["start_date", "end_date"] as const) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    const value = String(input[field] ?? "");
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return "旅行期間の日付形式が正しくありません";
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, "note") && String(input.note || "").length > 5000) {
    return "共有メモは5000文字以内にしてください";
  }
  if (Object.prototype.hasOwnProperty.call(input, "cover_url")) {
    const cover = String(input.cover_url || "");
    if (cover.length > MAX_COVER_VALUE_LENGTH) return "サムネ画像が大きすぎます";
    if (cover.startsWith("data:") && !/^data:image\/webp;base64,[A-Za-z0-9+/=]+$/.test(cover)) {
      return "サムネ画像の形式が正しくありません";
    }
  }
  return "";
}
