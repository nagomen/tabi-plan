import { initPageTransitions } from "../shared/page-transition";
import { registerServiceWorker } from "../shared/pwa";
import { initializeBudgetCalculator, type BudgetCalculatorOptions } from "./budget";
import type { CasinoGuideContext } from "./context";
import { initializeBackToTop, initializeSectionNavigation } from "./navigation";
import { initializePageShell, type CasinoGuideShellOptions } from "./page-shell";
import { initializePreparationChecklist } from "./preparation";
import { bindVenueSelection, renderVenueGuide } from "./venue-render";
import type { VenueMapController } from "./venue-map";
import type { CasinoVenue } from "./venue-model";

interface CasinoGuidePageOptions {
  context: CasinoGuideContext;
  venues: readonly CasinoVenue[];
  shell?: CasinoGuideShellOptions;
  budget?: BudgetCalculatorOptions;
  mapErrorMessage?: string;
}

/**
 * 国別ページに共通する初期化を一箇所で行う。
 * 各エントリーポイントは文言・通貨・店舗データだけを渡す。
 */
export function initializeCasinoGuidePage(options: CasinoGuidePageOptions): void {
  const { context, venues } = options;

  initPageTransitions();
  registerServiceWorker();
  initializePageShell(context, options.shell);
  initializePreparationChecklist(context.preparationStorageKey);
  initializeBudgetCalculator(options.budget);
  renderVenueGuide(venues);

  let mapController: Promise<VenueMapController | null> | null = null;

  /** 比較画面を開くまでLeafletを読み込まず、スマホの初期表示を軽く保つ。 */
  const loadVenueMap = (): Promise<VenueMapController | null> => {
    if (mapController) return mapController;
    const mapElement = document.querySelector<HTMLElement>("[data-venue-map]");
    if (mapElement?.classList.contains("is-error")) {
      mapElement.classList.remove("is-error");
      mapElement.textContent = "";
    }
    mapElement?.setAttribute("aria-busy", "true");

    mapController = import("./venue-map")
      .then(({ createVenueMapController }) => {
        const controller = createVenueMapController(venues);
        controller.initialize();
        return controller;
      })
      .catch(() => {
        if (mapElement) {
          mapElement.classList.add("is-error");
          mapElement.textContent = options.mapErrorMessage
            || "地図を読み込めませんでした。各施設の公式リンクをご利用ください。";
        }
        mapController = null;
        return null;
      })
      .finally(() => mapElement?.removeAttribute("aria-busy"));
    return mapController;
  };

  bindVenueSelection((venueId) => {
    void loadVenueMap().then((controller) => controller?.focusVenue(venueId));
  });
  initializeSectionNavigation({
    onSectionVisible: (sectionId) => {
      if (sectionId === "compare") requestAnimationFrame(() => void loadVenueMap());
    },
  });
  initializeBackToTop();
}
