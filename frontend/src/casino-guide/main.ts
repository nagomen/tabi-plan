import "../shared/ui.css";
import "./style.css";
import { initializeCasinoGuidePage } from "./app";
import { casinoGuideContext } from "./context";
import { CASINO_VENUES } from "./venues";

initializeCasinoGuidePage({
  context: casinoGuideContext(),
  venues: CASINO_VENUES,
  mapErrorMessage: "地図を読み込めませんでした。店舗の公式リンクをご利用ください。",
});
