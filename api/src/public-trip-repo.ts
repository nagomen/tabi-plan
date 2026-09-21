import { all, firstRow, inClause, pool } from "./db.js";
import { PUBLIC_PLAN_LINK_KEYS } from "./public-plan-policy.js";

export interface PublicTripPlan {
  id: string;
  slug: string;
  title: string;
  note: string | null;
  start_date: string | null;
  end_date: string | null;
  dates_label: string | null;
  version: number;
  updated_at: string;
}

export interface PublicTripCity {
  name: string;
  from_date: string | null;
  to_date: string | null;
  sort_order: number;
}

export interface PublicTripItineraryItem {
  id: string;
  item_date: string | null;
  day_index: number | null;
  sort_order: number;
  kind: string;
  start_time: string | null;
  title: string;
  place: string | null;
  area: string | null;
  note: string | null;
  map_query: string | null;
  lat: number | null;
  lng: number | null;
  from_place: string | null;
  to_place: string | null;
  transport: string | null;
  duration_minutes: number | null;
}

export interface PublicTripLink {
  key: string;
  label: string;
  url: string;
  caption: string | null;
  sort_order: number;
}

export interface PublicTripData {
  plan: PublicTripPlan;
  cities: PublicTripCity[];
  itinerary: PublicTripItineraryItem[];
  links: PublicTripLink[];
}

/**
 * MCPから読めるのは、公開・公開済みの旅行本文だけ。
 * メンバー、費用、精算、個人の便メモはSQLでも選択しない。
 */
export async function loadPublishedTrip(slug: string): Promise<PublicTripData | null> {
  const plan = await firstRow<PublicTripPlan>(pool,
    `SELECT id, slug, title, note, start_date, end_date, dates_label, version, updated_at
       FROM plans
      WHERE slug = ? AND visibility = 'public' AND status = 'published' AND deleted_at IS NULL
      LIMIT 1`,
    [slug],
  );
  if (!plan) return null;

  const publicLinkKeys = inClause([...PUBLIC_PLAN_LINK_KEYS]);
  const [cities, itinerary, links] = await Promise.all([
    all<PublicTripCity>(
      `SELECT name, from_date, to_date, sort_order
         FROM plan_cities
        WHERE plan_id = ?
        ORDER BY sort_order`,
      [plan.id],
    ),
    all<PublicTripItineraryItem>(
      `SELECT id, item_date, day_index, sort_order, kind, start_time, title, place, area, note,
              map_query, lat, lng, from_place, to_place, transport, duration_minutes
         FROM itinerary_items
        WHERE plan_id = ?
        ORDER BY item_date, sort_order`,
      [plan.id],
    ),
    all<{ link_key: string; label: string; url: string; caption: string | null; sort_order: number }>(
      `SELECT link_key, label, url, caption, sort_order
         FROM plan_links
        WHERE plan_id = ? AND link_key IN (${publicLinkKeys.sql})
        ORDER BY sort_order`,
      [plan.id, ...publicLinkKeys.params],
    ),
  ]);

  return {
    plan,
    cities,
    itinerary,
    links: links.map((link) => ({
      key: link.link_key,
      label: link.label,
      url: link.url,
      caption: link.caption,
      sort_order: link.sort_order,
    })),
  };
}
