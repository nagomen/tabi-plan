import type { LocalPlanData } from "../shared/plans-store";
import type { ItineraryItem, ItemType } from "../shared/types";
import { type Item, KINDS, model, num, datesString, stayCovering, cityForDate } from "./editor-state";

export function contentFingerprint(data: LocalPlanData): string {
  return JSON.stringify({
    itinerary: data.itinerary || [],
    cities: data.cities || [],
    links: data.links || [],
    checklist: data.checklist || [],
    candidates: data.candidates || [],
  });
}

function coordOut(s: string): number | "" {
  return s.trim() !== "" && !isNaN(num(s)) ? num(s) : "";
}

export function buildData(): LocalPlanData {
  const itinerary: ItineraryItem[] = [];
  model.days.forEach((day, di) => {
    const dayLabel = `Day ${di + 1}`;
    const city = cityForDate(day.date);
    const dayArea = city?.name || day.area || "";
    const flush = (it: Item): void => {
      const base: ItineraryItem = {
        date: day.date, day: dayLabel, area: dayArea || it.place || "",
        time: it.time || "", type: it.kind as ItemType, typeLabel: KINDS[it.kind].label,
        title: it.title || (it.kind === "move" ? `${it.from} → ${it.to}` : ""),
        place: it.place || (it.kind === "move" ? it.to : ""),
        note: it.note,
        lat: it.kind === "move" ? "" : coordOut(it.lat),
        lng: it.kind === "move" ? "" : coordOut(it.lng),
        mapQuery: it.mapQuery || it.place || "",
        weather: "",
      };
      if (it.kind === "move") {
        base.origin = it.from; base.destination = it.to;
        base.transport = it.transport;
        base.duration = it.duration;
        const fl = coordOut(it.fromLat), fn = coordOut(it.fromLng);
        const tl = coordOut(it.toLat), tn = coordOut(it.toLng);
        if (typeof fl === "number") base.originLat = fl;
        if (typeof fn === "number") base.originLng = fn;
        if (typeof tl === "number") base.destinationLat = tl;
        if (typeof tn === "number") base.destinationLng = tn;
        if (typeof tl === "number" && typeof tn === "number") { base.lat = tl; base.lng = tn; }
      }
      if (it.members.length) base.members = [...it.members];
      itinerary.push(base);
    };
    day.items.forEach(flush);
    // 連泊は各夜に1行ずつ出す（ダッシュボードで毎晩の宿が地図に出る）
    const cover = stayCovering(di);
    if (cover) flush(cover.stay);
  });
  return {
    trip: {
      title: model.title || "無題の旅行", dates: datesString(),
      startDate: model.startDate, endDate: model.endDate,
      members: model.members || "", note: model.note || "", cover: model.cover || "",
    },
    itinerary,
    links: [],
    checklist: [],
    cities: model.cities.map((c) => ({
      name: c.name,
      fromDate: c.fromDate,
      toDate: c.toDate,
      lat: coordOut(c.lat),
      lng: coordOut(c.lng),
    })),
    candidates: model.candidates,
  };
}
