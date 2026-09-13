export interface PublishablePlan {
  title: string;
  startDate: string;
  endDate: string;
  cities: { name: string }[];
}

export type PublishValidationError = {
  step: 1 | 2;
  field: "title" | "dates" | "cities";
  message: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 公開時に最低限必要な情報。下書きは未完成のまま保存できる。 */
export function validatePublishPlan(plan: PublishablePlan): PublishValidationError | null {
  if (!plan.title.trim()) {
    return { step: 1, field: "title", message: "公開する前に旅行名を入力してください" };
  }
  if (!isRealIsoDate(plan.startDate) || !isRealIsoDate(plan.endDate) || plan.endDate < plan.startDate) {
    return { step: 1, field: "dates", message: "公開する前に正しい旅行期間を選択してください" };
  }
  if (!plan.cities.some((city) => city.name.trim())) {
    return { step: 2, field: "cities", message: "公開する前に訪問地を1つ以上追加してください" };
  }
  return null;
}
