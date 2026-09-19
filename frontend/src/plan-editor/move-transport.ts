import { type Item, type Day, type City, model, num, hasLatLng, cityForDate } from "./editor-state";
import { daysEl } from "./editor-dom";
import { countryCodeFromText, countryCodeOf, type CountryCode } from "../shared/country";

export function countryFromText(text: string | undefined): CountryCode | null {
  return countryCodeFromText(text);
}

function countryFromCoords(latValue: string, lngValue: string): CountryCode | null {
  if (!hasLatLng(latValue, lngValue)) return null;
  return countryCodeOf(num(latValue), num(lngValue));
}

export function countryForCity(city: City | null): CountryCode | null {
  if (!city) return null;
  return countryFromText(city.name) || countryFromCoords(city.lat, city.lng);
}

function nextDifferentCityCountry(dayIndex: number, current: CountryCode | null): CountryCode | null {
  if (!current) return null;
  for (let i = dayIndex + 1; i < model.days.length; i++) {
    const nextCountry = countryForCity(cityForDate(model.days[i].date));
    if (nextCountry && nextCountry !== current) return nextCountry;
    if (nextCountry === current) return null;
  }
  return null;
}

function moveEndpointCountry(item: Item, target: "from" | "to", label = ""): CountryCode | null {
  if (target === "from") {
    return countryFromText(label) || countryFromText(item.from) || countryFromCoords(item.fromLat, item.fromLng);
  }
  return countryFromText(label) || countryFromText(item.to) || countryFromCoords(item.toLat, item.toLng);
}

function shouldDefaultMoveToAirplane(
  item: Item,
  day: Day,
  resultLabel = "",
  labelTarget?: "from" | "to",
  useDayTransition = false,
): boolean {
  if (item.kind !== "move" || item.transport.trim()) return false;
  const fromCountry = moveEndpointCountry(item, "from", labelTarget === "from" ? resultLabel : "");
  const toCountry = moveEndpointCountry(item, "to", labelTarget === "to" ? resultLabel : "");
  if (fromCountry && toCountry) return fromCountry !== toCountry;
  if (!useDayTransition) return false;
  const dayIndex = model.days.indexOf(day);
  const currentCountry = countryForCity(cityForDate(day.date));
  return Boolean(currentCountry && nextDifferentCityCountry(dayIndex, currentCountry));
}

export function maybeDefaultMoveTransport(
  item: Item,
  day: Day,
  resultLabel = "",
  labelTarget?: "from" | "to",
  useDayTransition = false,
): void {
  if (shouldDefaultMoveToAirplane(item, day, resultLabel, labelTarget, useDayTransition)) item.transport = "飛行機";
}

export function syncTransportSelect(item: Item): void {
  if (item.kind !== "move") return;
  const select = daysEl.querySelector<HTMLSelectElement>(`select[data-field="transport"][data-item="${item.id}"]`);
  if (select) select.value = item.transport;
}
