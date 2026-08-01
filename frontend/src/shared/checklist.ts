// チェックリスト（タスク）の3状態ロジック。ダッシュボードと計画一覧で共有する。
// 既存データは done:boolean だけを持つため、status 未設定時は done から状態を導出して後方互換を保つ。

import type { ChecklistItem } from "./types";

export type TaskStatus = "todo" | "doing" | "done";

export const TASK_STATUS_ORDER: TaskStatus[] = ["todo", "doing", "done"];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "未着手",
  doing: "進行中",
  done: "完了",
};

/** status があればそれを、無ければ done(boolean|string) から状態を導出する。 */
export function taskStatus(item: ChecklistItem): TaskStatus {
  const raw = String(item.status || "").toLowerCase();
  if (raw === "todo" || raw === "doing" || raw === "done") return raw;
  const done = item.done === true || String(item.done).toLowerCase() === "true";
  return done ? "done" : "todo";
}

/** クリックで巡回する次の状態（未着手→進行中→完了→未着手）。 */
export function nextTaskStatus(status: TaskStatus): TaskStatus {
  return status === "todo" ? "doing" : status === "doing" ? "done" : "todo";
}

/** ChecklistItem に状態を書き込む（done も同期して後方互換を保つ）。 */
export function setTaskStatus(item: ChecklistItem, status: TaskStatus): void {
  item.status = status;
  item.done = status === "done";
}

export interface ChecklistSummary {
  total: number;
  todo: number;
  doing: number;
  done: number;
  /** 完了率 0-100。total=0 なら 0。 */
  percent: number;
}

export function checklistSummary(items: ChecklistItem[] | undefined): ChecklistSummary {
  const summary: ChecklistSummary = { total: 0, todo: 0, doing: 0, done: 0, percent: 0 };
  (items || []).forEach((item) => {
    summary.total += 1;
    summary[taskStatus(item)] += 1;
  });
  summary.percent = summary.total ? Math.round((summary.done / summary.total) * 100) : 0;
  return summary;
}
