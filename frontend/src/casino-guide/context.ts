const DEFAULT_PLAN_SLUG = "trip-mtpg28hu1ot0vj40";
const DEFAULT_PREPARATION_STORAGE_PREFIX = "tabi:casino-prep";

export interface CasinoGuideContext {
  tripHref: string;
  preparationStorageKey: string;
}

interface CasinoGuideContextOptions {
  search?: string;
  defaultPlanSlug?: string;
  preparationStoragePrefix?: string;
}

/** URLから旅行コンテキストを一度だけ解決し、各機能へ明示的に渡す。 */
export function casinoGuideContext(options: CasinoGuideContextOptions = {}): CasinoGuideContext {
  const search = options.search ?? window.location.search;
  const params = new URLSearchParams(search);
  const planSlug = params.get("plan")?.trim() || options.defaultPlanSlug || DEFAULT_PLAN_SLUG;
  const storagePrefix = options.preparationStoragePrefix || DEFAULT_PREPARATION_STORAGE_PREFIX;
  return {
    tripHref: `index.html?plan=${encodeURIComponent(planSlug)}&view=1`,
    preparationStorageKey: `${storagePrefix}:${planSlug}`,
  };
}
