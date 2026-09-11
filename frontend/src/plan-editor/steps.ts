import { icon } from "../shared/icons";
import { model, state } from "./editor-state";
import { root, stepReasonEl } from "./editor-dom";

export function stepCompletion(): boolean[] {
  const periodDone = Boolean(model.title.trim()) && model.days.length > 0;
  const placeDone = model.cities.length > 0;
  const planDone = model.days.some((d) => d.items.length > 0 || d.stay);
  return [periodDone, placeDone, planDone];
}

function stepBlockReason(step: number): string {
  if (step === 1) {
    if (!model.title.trim() && !model.days.length) return "旅行名と期間を入れると目的地へ進めます。";
    if (!model.title.trim()) return "旅行名を入れると目的地へ進めます。";
    if (!model.days.length) return "期間を選択すると目的地へ進めます。";
  }
  if (step === 2 && !model.cities.length) return "訪問する都市・エリアを1つ以上追加すると行程へ進めます。";
  return "";
}

function scrollStepIntoView(): void {
  const target = document.querySelector<HTMLElement>(".pe-setup");
  if (!target) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.setTimeout(() => target.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" }), 0);
}

/** 作成ステップ（期間→目的地→行程）を実状態に連動させ、スマホでは該当パネルだけ表示。 */
export function updateSteps(): void {
  const done = stepCompletion();
  if (state.viewStep === 0) {
    const natural = done.findIndex((d) => !d);
    state.viewStep = natural < 0 ? done.length : natural + 1;
  }
  const pe = document.getElementById("editor");
  if (pe) pe.dataset.step = String(state.viewStep);
  if (root) {
    // 期間だけの段では地図に出すものが無いので畳んでおく。
    // 地図のボタンはヘッダーに常設なので、出し入れの制御はしない。
    if (state.viewStep === 1) root.classList.add("map-collapsed");
    const collapsed = root.classList.contains("map-collapsed");
    const headerBtn = root.querySelector<HTMLButtonElement>("[data-map-header]");
    if (headerBtn) {
      headerBtn.classList.toggle("is-on", !collapsed);
      headerBtn.setAttribute("aria-label", collapsed ? "地図を表示" : "地図を隠す");
    }
  }
  document.querySelectorAll<HTMLElement>(".pe-step").forEach((el, i) => {
    const isDone = done[i] && i + 1 !== state.viewStep;
    el.classList.toggle("is-done", isDone);
    el.classList.toggle("is-current", i + 1 === state.viewStep);
    const numEl = el.querySelector<HTMLElement>(".pe-step-n");
    if (numEl) numEl.innerHTML = isDone ? icon("check") : String(i + 1);
  });
  const prevBtn = document.querySelector<HTMLButtonElement>("[data-step-prev]");
  const nextBtn = document.querySelector<HTMLButtonElement>("[data-step-next]");
  if (prevBtn) {
    prevBtn.disabled = state.viewStep <= 1;
    const label = state.viewStep <= 2 ? "戻る" : "目的地へ戻る";
    prevBtn.innerHTML = icon("chevronLeft") + `<span>${label}</span>`;
  }
  if (nextBtn) {
    nextBtn.hidden = false;
    nextBtn.disabled = state.saveActionsBusy || (state.viewStep < 3 && !done[state.viewStep - 1]);
    const label = state.viewStep === 1 ? "目的地へ" : state.viewStep === 2 ? "行程へ" : "公開設定へ";
    const glyph = state.viewStep === 3 ? "globeAlt" : "chevronRight";
    nextBtn.innerHTML = `<span>${label}</span>` + icon(glyph);
  }
  stepReasonEl.textContent = state.viewStep < 3 && !done[state.viewStep - 1] ? stepBlockReason(state.viewStep) : "";
}

/** ステップのタップで表示を切り替える（スマホのウィザード送り）。 */
export function setViewStep(step: number): void {
  const target = Math.min(3, Math.max(1, step));
  if (target > state.viewStep) {
    const done = stepCompletion();
    for (let current = state.viewStep; current < target; current += 1) {
      if (!done[current - 1]) {
        stepReasonEl.textContent = stepBlockReason(current);
        return;
      }
    }
  }
  state.viewStep = target;
  updateSteps();
  scrollStepIntoView();
}
