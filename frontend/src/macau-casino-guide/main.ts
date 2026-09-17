import "../shared/ui.css";
import "../casino-guide/style.css";
import "./style.css";
import { initializeCasinoGuidePage } from "../casino-guide/app";
import { casinoGuideContext } from "../casino-guide/context";
import { MACAU_CASINO_VENUES } from "./venues";

initializeCasinoGuidePage({
  context: casinoGuideContext({
    defaultPlanSlug: "2026-hong-kong-macau-kinmen",
    preparationStoragePrefix: "tabi:macau-casino-prep",
  }),
  venues: MACAU_CASINO_VENUES,
  shell: {
    kicker: "Macau Casino Field Guide",
    title: "マカオカジノ実用ガイド",
    backLabel: "香港・マカオ旅行へ戻る",
    meta: "10月11日・午後から夜までコタイで過ごすための特設ページ",
  },
  budget: { currency: "HKD", maxBudget: 10_000_000 },
});
