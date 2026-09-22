// 編集モードのときだけ地図に足す操作。ピンを掴んで動かすと座標を保存し、
// ふきだしの「編集」から同じ予定のダイアログを開く。

import type { RoutePoint } from "./types";
import { openItemById } from "./inline-editor";
import { isInlineEditing, showEditBarStatus, editBarStatusEl } from "./inline-mode";
import { applyPointMove, commit } from "./inline-store";

/** 地図が太平洋中心表示のとき経度に +360 しているので、保存前に戻す。 */
export function normalizeLng(lng: number): number {
  let value = Number(lng);
  if (!Number.isFinite(value)) return value;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

function roleLabel(role: string): string {
  return role === "origin" ? "出発地" : role === "destination" ? "到着地" : "場所";
}

async function movePoint(point: RoutePoint, lat: number, lng: number): Promise<void> {
  const itemId = point.itemId || "";
  if (!itemId) {
    showEditBarStatus("この地点はまだ保存されていないため動かせません。予定を保存してからお試しください。");
    return;
  }
  const ok = await commit(editBarStatusEl(), (data) => {
    applyPointMove(data, itemId, point.role, lat, normalizeLng(lng));
  });
  if (ok) showEditBarStatus(`「${point.title || point.place || "この予定"}」の${roleLabel(point.role)}を地図の位置に更新しました。`);
}

/** leaflet-map に渡す編集フック。編集モードでなければ undefined。 */
export function mapEditHooks(): {
  onMove: (point: RoutePoint, lat: number, lng: number) => void;
  onEdit: (point: RoutePoint) => void;
} | undefined {
  if (!isInlineEditing()) return undefined;
  return {
    onMove: (point, lat, lng) => void movePoint(point, lat, lng),
    onEdit: (point) => {
      if (point.itemId) openItemById(point.itemId);
    },
  };
}
