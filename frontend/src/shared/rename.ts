// 表示名の変更を、名前をキーにしている全ストアへ伝播させる。
//
// このアプリでは表示名が事実上の主キーになっている（計画の members 文字列、
// 費用の支払者・割り勘対象、候補の投票者、送金リンク、履歴公開設定、
// subjectType:"name" の権限行）。マイページで名前を変えたときにここを通さないと、
// 自分の計画から締め出されたり、費用や票が旧名のまま孤立したりする。
//
// 将来メンバーを安定IDで持つようになれば、この伝播は不要になり
// 「表示名を1か所書き換えるだけ」に縮む。それまでの繋ぎ。

import * as TripPlans from "./plans-store";
import * as Permissions from "./permissions-store";
import * as ExpenseStore from "./expense-store";
import { splitNames } from "./friend-store";
import { getPayLinks, setPayLink } from "./payment-links";
import { isHistoryPublic, setHistoryPublic } from "./history-privacy";
import type { TripInfo } from "./types";

export interface RenameResult {
  plans: number;
  expenses: number;
  votes: number;
}

/** 計画の members 文字列と候補の投票者名を置き換える。 */
function renameInPlan(slug: string, from: string, to: string): { renamed: boolean; votes: number } {
  const meta = TripPlans.get(slug);
  if (!meta) return { renamed: false, votes: 0 };
  const data = TripPlans.getData(slug);
  const names = splitNames((data && data.trip && data.trip.members) || meta.members || "");
  const hasName = names.includes(from);
  // 同名が既に居る場合に重複させない
  const nextNames = hasName
    ? names.map((name) => (name === from ? to : name)).filter((name, i, arr) => arr.indexOf(name) === i)
    : names;

  let votes = 0;
  if (data && Array.isArray(data.candidates)) {
    data.candidates.forEach((candidate) => {
      const list = candidate.votes || [];
      if (list.includes(from)) {
        candidate.votes = Array.from(new Set(list.map((name) => (name === from ? to : name))));
        votes += 1;
      }
      if (candidate.proposer === from) candidate.proposer = to;
    });
  }

  if (!hasName && !votes) return { renamed: false, votes: 0 };

  if (data) {
    const trip: TripInfo = { ...(data.trip || ({} as TripInfo)), members: nextNames.join("、") };
    TripPlans.saveLocalPlan(slug, { ...data, trip });
  } else if (hasName) {
    TripPlans.upsert({ slug, members: nextNames.join("、") });
  }
  return { renamed: hasName, votes };
}

/**
 * 旧名 → 新名 の付け替えを全ストアへ適用する。
 * 名前が空、または同じ名前なら何もしない。
 */
export function renameEverywhere(oldName: string, newName: string): RenameResult {
  const from = (oldName || "").trim();
  const to = (newName || "").trim();
  const result: RenameResult = { plans: 0, expenses: 0, votes: 0 };
  if (!from || !to || from === to) return result;

  // 1. 権限行・招待行（名前 principal）
  Permissions.renameNamePrincipal(from, to);

  // 2. 計画のメンバー欄と候補の投票者、3. 各計画の費用台帳
  TripPlans.list().forEach((plan) => {
    const { renamed, votes } = renameInPlan(plan.slug, from, to);
    if (renamed) result.plans += 1;
    result.votes += votes;
    const before = ExpenseStore.list(plan.slug);
    if (before.length) {
      ExpenseStore.renameParticipant(plan.slug, from, to);
      result.expenses += before.filter(
        (record) => record.payer === from || (record.targets || []).includes(from) || from in (record.individual || {}),
      ).length;
    }
  });

  // 4. 送金リンク帳（名前キー）
  const links = getPayLinks();
  const link = links[from];
  if (link && link.paypay && !links[to]) {
    setPayLink(to, link.paypay);
    setPayLink(from, "");
  }

  // 5. 旅行履歴の公開設定（名前キー）
  const wasPublic = isHistoryPublic(from);
  if (!wasPublic) {
    setHistoryPublic(to, false);
    setHistoryPublic(from, true); // 既定へ戻す＝旧名のエントリを実質無効化
  }

  return result;
}
