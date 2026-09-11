import * as TripPlans from "../shared/plans-store";
import { canEditPlan, planHasOwner } from "../shared/membership";
import { type Day, state, model, newItem, normalizeToISO, normalizeKind } from "./editor-state";
import { qs, titleEcho } from "./editor-dom";
import { lockEditor } from "./editor-lock";
import { showRangeDates, updateRangeButton } from "./date-range";
import { updateCoverPreview } from "./cover-image";
import { renderMembers, renderMemberSelect, updateMemberVisibility } from "./members";
import { updateCalsync } from "./calendar-sync";

export function syncBasicInputs(): void {
  qs<HTMLInputElement>('[data-f="title"]').value = model.title || "";
  qs<HTMLInputElement>('[data-f="note"]').value = model.note || "";
  updateCoverPreview();
  updateMemberVisibility();
  renderMembers();
  renderMemberSelect();
  if (model.startDate && model.endDate) showRangeDates(model.startDate, model.endDate);
  updateRangeButton();
  titleEcho.textContent = model.title || "新しい計画";
  updateCalsync();
}

export function loadExisting(): boolean {
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  if (meta && meta.source && meta.source !== "local") {
    return lockEditor("この計画は外部連携のため、ここでは編集できません");
  }
  // 持ち主が居ない計画（権限行もメンバー名も無い）は、名前未設定の本人まで締め出さない。
  // ダッシュボードの computeReadOnly と同じ判定に揃えている。
  if (meta && planHasOwner(meta) && !canEditPlan(meta)) {
    return lockEditor("この計画を編集する権限がありません");
  }
  const data = state.slug ? TripPlans.getData(state.slug) : null;
  if (!data) return true;
  const trip = data.trip || { title: "", dates: "", members: "", note: "" };
  model.title = trip.title || "";
  model.members = trip.members || "";
  model.memberIds = meta?.memberIds ? [...meta.memberIds] : [];
  model.memberDates = {};
  if (meta?.id) {
    for (const period of TripPlans.memberPeriods(meta.id)) {
      model.memberDates[period.user_id] = { from: period.from_date, to: period.to_date };
    }
  }
  model.note = trip.note || "";
  model.cover = trip.cover || "";
  model.candidates = Array.isArray(data.candidates) ? data.candidates : [];
  model.visibility = meta?.visibility;
  const parts = String(trip.dates || "").split(/\s+-\s+/);
  model.startDate = normalizeToISO(trip.startDate) || normalizeToISO(parts[0]);
  model.endDate = normalizeToISO(trip.endDate) || normalizeToISO(parts[1] || parts[0]);

  const byDate: Record<string, Day> = {};
  const cityNames = new Set<string>();
  (data.itinerary || []).forEach((row) => {
    const date = normalizeToISO(row.date);
    if (!date) return;
    const day = byDate[date] || (byDate[date] = { date, area: row.area || "", items: [], stay: null });
    if (!day.area && row.area) day.area = row.area;
    if (row.area) cityNames.add(row.area);
    const kind = normalizeKind(row.type);
    const it = newItem(kind, {
      time: String(row.time || ""), title: String(row.title || ""), place: String(row.place || ""),
      mapQuery: String(row.mapQuery || ""), note: String(row.note || ""),
      lat: row.lat != null ? String(row.lat) : "", lng: row.lng != null ? String(row.lng) : "",
      from: String(row.origin || ""), to: String(row.destination || ""),
      fromLat: row.originLat != null ? String(row.originLat) : "", fromLng: row.originLng != null ? String(row.originLng) : "",
      toLat: row.destinationLat != null ? String(row.destinationLat) : "", toLng: row.destinationLng != null ? String(row.destinationLng) : "",
      transport: String(row.transport || ""), duration: String(row.duration || ""),
      members: Array.isArray(row.members) ? row.members.filter((x): x is string => typeof x === "string" && Boolean(x)) : [],
    });
    if (kind === "stay") day.stay = it;
    else day.items.push(it);
  });
  // 古い計画でplans側の期間が欠けていても、保存済み行程の日付から復旧する。
  const itineraryDates = Object.keys(byDate).sort();
  if (!model.startDate) model.startDate = itineraryDates[0] || "";
  if (!model.endDate) model.endDate = itineraryDates[itineraryDates.length - 1] || model.startDate;
  model.days = Object.keys(byDate).sort().map((d) => byDate[d]);
  // 同名の宿が連日なら連泊として1つにまとめる（後ろから前へ畳む）
  for (let i = model.days.length - 1; i >= 1; i--) {
    const cur = model.days[i].stay;
    const prev = model.days[i - 1].stay;
    if (cur && prev && cur.title && cur.title === prev.title) {
      prev.nights = Math.max(1, prev.nights) + Math.max(1, cur.nights);
      model.days[i].stay = null;
    }
  }
  if (data.cities && data.cities.length) {
    // 保存済みの都市（期間つき）を復元
    model.cities = data.cities.map((c) => {
      const itineraryPoint = (data.itinerary || []).find((item) =>
        item.area === c.name && String(item.lat ?? "").trim() !== "" && String(item.lng ?? "").trim() !== "" &&
        Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lng)),
      );
      const known = TripPlans.coordsFor(c.name || "");
      return {
        id: state.seq++, name: c.name || "",
        fromDate: c.fromDate || itineraryDates.find((date) => byDate[date]?.area === c.name) || "",
        toDate: c.toDate || [...itineraryDates].reverse().find((date) => byDate[date]?.area === c.name) || "",
        lat: c.lat != null && String(c.lat) !== ""
          ? String(c.lat) : itineraryPoint ? String(itineraryPoint.lat) : known ? String(known.lat) : "",
        lng: c.lng != null && String(c.lng) !== ""
          ? String(c.lng) : itineraryPoint ? String(itineraryPoint.lng) : known ? String(known.lng) : "",
      };
    });
  } else {
    // 旧データ：行程の area から都市名だけ拾う（期間は空）
    model.cities = Array.from(cityNames).map((name) => {
      const hit = TripPlans.coordsFor(name);
      return { id: state.seq++, name, lat: hit ? String(hit.lat) : "", lng: hit ? String(hit.lng) : "", fromDate: "", toDate: "" };
    });
  }
  return true;
}
