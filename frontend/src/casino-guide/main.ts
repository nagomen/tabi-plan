import "../shared/ui.css";
import "./style.css";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { mountAppHeader } from "../shared/app-header";
import { icon, type IconName } from "../shared/icons";
import { addBaseLayer } from "../shared/map-tiles";
import { initPageTransitions } from "../shared/page-transition";
import { registerServiceWorker } from "../shared/pwa";

const params = new URLSearchParams(window.location.search);
const planSlug = params.get("plan") || "trip-mtpg28hu1ot0vj40";
const tripHref = `index.html?plan=${encodeURIComponent(planSlug)}&view=1`;

initPageTransitions();
registerServiceWorker();

mountAppHeader({
  kicker: "Seoul Casino Guide",
  title: "韓国カジノ完全ガイド",
  back: { href: tripHref, label: "韓国旅行へ戻る" },
  meta: [{ text: "韓国旅行・1日目のための特設ページ" }],
  actions: [
    { kind: "link", display: "text", icon: "calendarDays", label: "旅行計画", text: "旅行計画", href: tripHref },
  ],
});

document.querySelectorAll<HTMLAnchorElement>("[data-trip-link]").forEach((link) => {
  link.href = tripHref;
});

document.querySelectorAll<HTMLElement>("[data-ic]").forEach((element) => {
  const name = element.dataset.ic as IconName | undefined;
  if (name) element.innerHTML = icon(name);
});

const storageKey = `tabi:casino-prep:${planSlug}`;
const checks = Array.from(document.querySelectorAll<HTMLInputElement>("[data-prep-list] input[type='checkbox']"));
let savedChecks = new Set<string>();
try {
  const value = JSON.parse(localStorage.getItem(storageKey) || "[]") as unknown;
  if (Array.isArray(value)) savedChecks = new Set(value.filter((item): item is string => typeof item === "string"));
} catch {
  savedChecks = new Set();
}
checks.forEach((check) => {
  check.checked = savedChecks.has(check.value);
  check.addEventListener("change", () => {
    const selected = checks.filter((item) => item.checked).map((item) => item.value);
    try { localStorage.setItem(storageKey, JSON.stringify(selected)); } catch { /* storage unavailable */ }
  });
});

const budgetTotal = document.querySelector<HTMLInputElement>("[data-budget-total]");
const budgetSessions = document.querySelector<HTMLInputElement>("[data-budget-sessions]");
const budgetPer = document.querySelector<HTMLElement>("[data-budget-per]");
const formatWon = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });

function updateBudget(): void {
  if (!budgetTotal || !budgetSessions || !budgetPer) return;
  const total = Math.max(0, Math.min(100_000_000, Number(budgetTotal.value) || 0));
  const sessions = Math.max(1, Math.min(10, Number(budgetSessions.value) || 1));
  budgetPer.textContent = formatWon.format(Math.floor(total / sessions));
}
budgetTotal?.addEventListener("input", updateBudget);
budgetSessions?.addEventListener("input", updateBudget);
updateBudget();

const casinoLocations = [
  { id: "paradise-city", number: "01", name: "Paradise Casino Paradise City", area: "仁川空港から5分以内", lat: 37.4371, lng: 126.4559 },
  { id: "dragon", number: "02", name: "Seven Luck Dragon City", area: "龍山", lat: 37.53199, lng: 126.96216 },
  { id: "gangnam", number: "03", name: "Seven Luck Gangnam COEX", area: "江南", lat: 37.51184, lng: 127.05761 },
  { id: "walkerhill", number: "04", name: "Paradise Walkerhill", area: "広津", lat: 37.5552, lng: 127.111 },
];
let casinoMap: L.Map | null = null;
const casinoMarkers = new Map<string, L.Marker>();

function selectCasinoMarker(id: string): void {
  document.querySelectorAll<HTMLElement>("[data-map-place]").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.mapPlace === id);
  });
}

function initCasinoMap(): void {
  const mapElement = document.querySelector<HTMLElement>("[data-venue-map]");
  if (!mapElement || mapElement.offsetParent === null) return;
  if (casinoMap) {
    casinoMap.invalidateSize();
    return;
  }
  casinoMap = L.map(mapElement, {
    scrollWheelZoom: false,
    attributionControl: true,
    zoomControl: true,
  });
  addBaseLayer(L, casinoMap);
  casinoLocations.forEach((place) => {
    const marker = L.marker([place.lat, place.lng], {
      icon: L.divIcon({
        className: "cg-map-marker-wrap",
        html: `<span class="cg-map-marker">${place.number}</span>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      }),
    })
      .addTo(casinoMap as L.Map)
      .bindPopup(`<b>${place.name}</b><br>${place.area}`)
      .on("click", () => selectCasinoMarker(place.id));
    casinoMarkers.set(place.id, marker);
  });
  casinoMap.fitBounds(L.latLngBounds(casinoLocations.map((place) => [place.lat, place.lng])), {
    padding: [34, 34],
    maxZoom: 12,
  });
}

document.querySelectorAll<HTMLButtonElement>("[data-map-place]").forEach((button) => {
  button.addEventListener("click", () => {
    const id = button.dataset.mapPlace || "";
    const place = casinoLocations.find((item) => item.id === id);
    initCasinoMap();
    if (!casinoMap || !place) return;
    casinoMap.setView([place.lat, place.lng], 14, { animate: true });
    casinoMarkers.get(id)?.openPopup();
    selectCasinoMarker(id);
  });
});

const tocLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>(".cg-toc a"));
const sections = tocLinks
  .map((link) => document.querySelector<HTMLElement>(link.hash))
  .filter((section): section is HTMLElement => Boolean(section));
const toc = document.querySelector<HTMLElement>(".cg-toc");
const mobileTabs = window.matchMedia("(max-width: 600px)");

function mobileSectionId(): string {
  const id = window.location.hash.slice(1);
  return sections.some((section) => section.id === id) ? id : sections[0]?.id || "route";
}

function showMobileSection(id: string, moveToTop: boolean): void {
  sections.forEach((section) => {
    const selected = section.id === id;
    section.classList.toggle("is-mobile-active", selected);
    section.setAttribute("aria-hidden", String(!selected));
  });
  tocLinks.forEach((link) => {
    const selected = link.hash === `#${id}`;
    link.classList.toggle("is-active", selected);
    link.setAttribute("aria-selected", String(selected));
    link.tabIndex = selected ? 0 : -1;
  });
  const activeTab = tocLinks.find((link) => link.hash === `#${id}`);
  activeTab?.scrollIntoView({ behavior: "auto", block: "nearest", inline: "center" });
  if (moveToTop && toc) window.scrollTo({ top: toc.offsetTop, behavior: "auto" });
  if (id === "compare") requestAnimationFrame(initCasinoMap);
}

function syncResponsiveNavigation(): void {
  if (mobileTabs.matches) {
    toc?.setAttribute("role", "tablist");
    tocLinks.forEach((link) => {
      link.setAttribute("role", "tab");
      link.setAttribute("aria-controls", link.hash.slice(1));
    });
    if (!window.location.hash) history.replaceState(null, "", `${window.location.pathname}${window.location.search}#route`);
    showMobileSection(mobileSectionId(), false);
    return;
  }
  toc?.removeAttribute("role");
  tocLinks.forEach((link) => {
    link.removeAttribute("role");
    link.removeAttribute("aria-controls");
    link.removeAttribute("aria-selected");
    link.removeAttribute("tabindex");
  });
  sections.forEach((section) => {
    section.classList.remove("is-mobile-active");
    section.removeAttribute("aria-hidden");
  });
  requestAnimationFrame(initCasinoMap);
}

tocLinks.forEach((link, index) => {
  link.addEventListener("click", (event) => {
    if (!mobileTabs.matches) return;
    event.preventDefault();
    if (window.location.hash !== link.hash) {
      history.pushState(null, "", `${window.location.pathname}${window.location.search}${link.hash}`);
    }
    showMobileSection(link.hash.slice(1), true);
  });
  link.addEventListener("keydown", (event) => {
    if (!mobileTabs.matches || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = tocLinks[(index + direction + tocLinks.length) % tocLinks.length];
    next?.click();
    next?.focus();
  });
});

window.addEventListener("popstate", () => {
  if (mobileTabs.matches) showMobileSection(mobileSectionId(), true);
});
mobileTabs.addEventListener("change", syncResponsiveNavigation);
syncResponsiveNavigation();

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    if (mobileTabs.matches) return;
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    tocLinks.forEach((link) => link.classList.toggle("is-active", link.hash === `#${visible.target.id}`));
  }, { rootMargin: "-25% 0px -65% 0px", threshold: [0, 0.2, 0.6] });
  sections.forEach((section) => observer.observe(section));
}

const toTop = document.querySelector<HTMLElement>(".cg-to-top");
const updateToTop = (): void => {
  toTop?.classList.toggle("is-visible", window.scrollY > 700);
};
window.addEventListener("scroll", updateToTop, { passive: true });
updateToTop();
