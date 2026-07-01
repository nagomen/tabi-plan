// 旅行計画一覧（プランハブ）ページ。docs/plans.html のインライン IIFE を
// strict TypeScript モジュールへ移行したもの。
// プランの一覧表示・検索・開く/編集/複製/削除と、ローカルプランの
// Google Sheets への公開（JSONP 認証 + iframe-POST createTrip）を行う。

import * as TripPlans from "../shared/plans-store";
import "../shared/ui.css";
import type { PlanMeta, LocalPlanData, PlanSource } from "../shared/plans-store";
import { readGlobalTripConfig } from "../shared/config";
import { escapeHtml, errorMessage, makeScopedQuery } from "../shared/dom";
import { registerServiceWorker } from "../shared/pwa";
import { icon, type IconName } from "../shared/icons";
import { mountAppHeader } from "../shared/app-header";
import { getUser } from "../shared/user-store";
import { splitNames } from "../shared/friend-store";
import { decodeInvite } from "../shared/invite";
import {
  callAppsScript,
  postAppsScript,
  sha256Hex,
  isAuthError,
  type AppsScriptResponse,
} from "../shared/apps-script";

// ---- 補助型 -------------------------------------------------------------

/** ローカルストレージに保存する公開用認証セッション */
interface PublishAuthSession {
  token?: string;
  expiresAt?: number;
}

/** askPassword が解決する値 */
interface PasswordPrompt {
  value: string;
  modal: HTMLDivElement;
  error: HTMLElement;
  input: HTMLInputElement;
}

interface AppState {
  filter: string;
}

// ---- DOM 取得ヘルパー ----------------------------------------------------

mountAppHeader({
  kicker: "Travel Plans",
  title: "旅行計画",
  meta: [
    { attr: "data-count", text: "読み込み中" },
    { text: "選んだ計画でダッシュボードが開きます" },
  ],
  actions: [
    { kind: "link", display: "icon", icon: "user", label: "マイページ", href: "mypage.html" },
  ],
});

const { qs } = makeScopedQuery(document);

const hub = qs<HTMLElement>(".hub");
const gridMine = qs<HTMLElement>("[data-grid-mine]");
const gridPublic = qs<HTMLElement>("[data-grid-public]");
const publicHead = qs<HTMLElement>("[data-public-head]");
const countEl = qs<HTMLElement>("[data-count]");
const countMineEl = qs<HTMLElement>("[data-count-mine]");
const countPublicEl = qs<HTMLElement>("[data-count-public]");
const filterEl = qs<HTMLInputElement>("[data-filter]");
const state: AppState = { filter: "" };

// セクション見出しの heroicon を流し込む（HTML 側は data-ic="名前" のみ持つ）
document.querySelectorAll<HTMLElement>("[data-ic]").forEach((el) => {
  const name = el.getAttribute("data-ic");
  if (name) el.insertAdjacentHTML("afterbegin", icon(name as IconName));
});

const SOURCE_LABEL: Record<string, string> = {
  local: "ローカル",
  googleSheets: "Sheets連携",
  appsScript: "公開",
  sample: "サンプル",
};

function sourceClass(source: PlanSource | string): string {
  return ["local", "googleSheets", "appsScript", "sample"].indexOf(source) >= 0 ? source : "sample";
}

function planText(meta: PlanMeta): string {
  return [meta.title, meta.route, meta.dates, meta.members].join(" ").toLowerCase();
}

type RowVariant = "mine" | "public";

/** 旅行計画の初日の目的地を取得する */
function getFirstDayLocation(meta: PlanMeta): string {
  const data = TripPlans.getData(meta.slug);
  if (data && Array.isArray(data.itinerary) && data.itinerary.length > 0) {
    // 最初の予定を取得（通常日付順にソートされている）
    const first = data.itinerary[0];
    const loc = (first.area || first.place || first.title || "").trim();
    if (loc) return loc;
  }
  // itinerary がない、あるいは空の場合は route や title から推測
  return (meta.route || meta.title || "").trim();
}

/** 行き先の地名キーワードから、国・地域別のカバー画像パスを返す */
function getPlanCoverImage(meta: PlanMeta): string {
  const loc = getFirstDayLocation(meta).toLowerCase();

  // イギリス
  if (/イギリス|英国|ロンドン|london|uk|united.*kingdom|イングランド|コッツウォルズ|エディンバラ/.test(loc)) {
    return "./images/cover_uk.png";
  }
  // フランス
  if (/フランス|仏国|パリ|paris|france|ニース|リヨン|モンサンミッシェル/.test(loc)) {
    return "./images/cover_france.png";
  }
  // ドイツ
  if (/ドイツ|独国|ベルリン|berlin|germany|ミュンヘン|フランクフルト|ノイシュヴァンシュタイン/.test(loc)) {
    return "./images/cover_germany.png";
  }
  // イタリア
  if (/イタリア|伊国|ローマ|rome|italy|ミラノ|ヴェネツィア|フィレンツェ|ナポリ/.test(loc)) {
    return "./images/cover_italia.png";
  }
  // スペイン
  if (/スペイン|西国|マドリード|madrid|spain|バルセロナ|サグラダファミリア|セビリア/.test(loc)) {
    return "./images/cover_spain.png";
  }
  // その他ヨーロッパ
  if (/ヨーロッパ|欧州|スイス|オーストリア|ベルギー|オランダ|ポルトガル|ギリシャ|北欧|フィンランド|スウェーデン|ノルウェー|デンマーク|チェコ|ハンガリー|ポーランド|クロアチア|チューリッヒ|ウィーン|ブリュッセル|アムステルダム|リスボン|アテネ|ヘルシンキ|ストックホルム|オスロ|コペンハーゲン|プラハ|ブダペスト|ワルシャワ|ドゥブロヴニク/.test(loc)) {
    return "./images/cover_europe.png";
  }
  
  // インド
  if (/インド|デリー|ニューデリー|ムンバイ|タージマハル|india|delhi|mumbai/.test(loc)) {
    return "./images/cover_india.png";
  }
  // 中国
  if (/中国|北京|beijing|上海|shanghai|香港|hong.*kong|マカオ|広州|深セン|西安|成都/.test(loc)) {
    return "./images/cover_china.png";
  }
  // 韓国
  if (/韓国|ソウル|seoul|釜山|busan|プサン|済州島|チェジュ/.test(loc)) {
    return "./images/cover_korea.png";
  }
  // その他アジア
  if (/アジア|台湾|台北|高雄|九份|タイ|バンコク|ベトナム|ハノイ|ホーチミン|シンガポール|マレーシア|クアラルンプール|フィリピン|マニラ|インドネシア|ジャカルタ|バリ|スリランカ|ネパール|モンゴル|カンボジア|アンコールワット|asia|taiwan|taipei|bangkok|vietnam/.test(loc)) {
    return "./images/cover_asia.png";
  }

  // アフリカ
  if (/アフリカ|エジプト|カイロ|ケニア|ナイロビ|南アフリカ|ヨハネスブルグ|モロッコ|カサブランカ|チュニジア|タンザニア|マダガスカル|africa|egypt/.test(loc)) {
    return "./images/cover_africa.png";
  }

  // アメリカ各州
  // カリフォルニア州
  if (/カリフォルニア|ロサンゼルス|サンフランシスコ|ヨセミテ|シリコンバレー|ディズニーランド|サンディエゴ|ca|california|los.*angeles|san.*francisco/.test(loc)) {
    return "./images/cover_california.png";
  }
  // ネバダ州
  if (/ネバダ|ラスベガス|リノ|nv|nevada|las.*vegas/.test(loc)) {
    return "./images/cover_nevada.png";
  }
  // ハワイ州
  if (/ハワイ|ホノルル|ワイキキ|マウイ|カウアイ|オアフ|hi|hawaii|honolulu|waikiki/.test(loc)) {
    return "./images/cover_hawaii.png";
  }
  // ニューヨーク州
  if (/ニューヨーク|マンハッタン|自由の女神|タイムズスクエア|バッファロー|ナイアガラ|ny|new.*york|manhattan/.test(loc)) {
    return "./images/cover_newyork.png";
  }
  // イリノイ州
  if (/イリノイ|シカゴ|il|illinois|chicago/.test(loc)) {
    return "./images/cover_illinois.png";
  }
  // アリゾナ州
  if (/アリゾナ|セドナ|グランドキャニオン|フェニックス|az|arizona|sedona|grand.*canyon/.test(loc)) {
    return "./images/cover_arizona.png";
  }
  // それ以外のアメリカ
  if (/アメリカ|米国|ワシントン|シアトル|ボストン|マイアミ|テキサス|フロリダ|グアム|サイパン|usa|united.*states|america|seattle|boston/.test(loc)) {
    return "./images/cover_usa.png";
  }

  // オーストラリア
  if (/オーストラリア|シドニー|メルボルン|ケアンズ|ウルル|パース|ゴールドコースト|australia|sydney|melbourne|cairns/.test(loc)) {
    return "./images/cover_australia.png";
  }
  // それ以外のオセアニア
  if (/オセアニア|ニュージーランド|フィジー|タヒチ|オークランド|クライストチャーチ|ポリネシア|メラネシア|ミクロネシア|oceania|new.*zealand|fiji/.test(loc)) {
    return "./images/cover_oceania.png";
  }

  // 東北地方の既存アセット判定
  if (loc.includes("青森") || loc.includes("aomori") || loc.includes("ねぶた")) {
    return "./images/cover_aomori.png";
  }
  if (loc.includes("仙台") || loc.includes("sendai") || loc.includes("宮城") || loc.includes("牛タン") || loc.includes("ずんだ")) {
    return "./images/cover_sendai.png";
  }
  if (loc.includes("松島") || loc.includes("matsushima")) {
    return "./images/cover_matsushima.png";
  }
  if (loc.includes("蔵王") || loc.includes("zao") || loc.includes("樹氷") || loc.includes("スキー")) {
    return "./images/cover_zao.png";
  }
  // 東北（一般）— 個別スポット（青森/仙台/松島/蔵王）に当たらない場合
  if (/東北|岩手|盛岡|秋田|山形|福島|角館|十和田|奥入瀬|銀山温泉|山寺|tohoku/.test(loc)) {
    return "./images/cover_tohoku.png";
  }

  // 北海道
  if (/北海道|札幌|函館|小樽|旭川|富良野|美瑛|ニセコ|知床|hokkaido|sapporo/.test(loc)) {
    return "./images/cover_hokkaido.png";
  }
  // 東京（※「東京都」も拾う。京都より先に置くこと）
  if (/東京|渋谷|新宿|浅草|上野|銀座|秋葉原|お台場|スカイツリー|tokyo|shibuya|shinjuku/.test(loc)) {
    return "./images/cover_tokyo.png";
  }
  // 名古屋（愛知）
  if (/名古屋|愛知|nagoya/.test(loc)) {
    return "./images/cover_nagoya.png";
  }
  // 京都
  if (/京都|嵐山|祇園|清水寺|金閣寺|伏見稲荷|kyoto/.test(loc)) {
    return "./images/cover_kyoto.png";
  }
  // 大阪
  if (/大阪|梅田|難波|なんば|道頓堀|通天閣|usj|ユニバ|osaka/.test(loc)) {
    return "./images/cover_osaka.png";
  }
  // 福岡
  if (/福岡|博多|天神|太宰府|hakata|fukuoka/.test(loc)) {
    return "./images/cover_fukuoka.png";
  }

  // デフォルト
  return "./images/cover_default.png";
}

/** 1枚のカード（計画）の HTML を組み立てる。variant で「自分の計画」/「みんなの公開計画」を出し分ける。 */
function rowHtml(meta: PlanMeta, variant: RowVariant, activeSlug: string): string {
  const src = sourceClass(meta.source);
  const isLocal = meta.source === "local";
  const isActive = meta.slug === activeSlug;
  const metaLine = [meta.dates, meta.members].filter(Boolean).map(escapeHtml).join(" · ");
  const openHref =
    "index.html?plan=" + encodeURIComponent(meta.slug) + (variant === "public" ? "&view=1" : "");

  const menuItems =
    variant === "public"
      ? '<button class="plan-menu-item" type="button" data-dup>' +
        icon("documentDuplicate") +
        "<span>自分の計画に複製</span></button>"
      : (isLocal || meta.source === "appsScript"
          ? '<button class="plan-menu-item" type="button" data-edit>' + icon("pencilSquare") + "<span>編集</span></button>"
          : "") +
        (isLocal
          ? '<button class="plan-menu-item" type="button" data-publish>' + icon("globeAlt") + "<span>公開</span></button>"
          : "") +
        '<button class="plan-menu-item" type="button" data-dup>' +
        icon("documentDuplicate") +
        "<span>複製</span></button>" +
        (meta.builtIn
          ? ""
          : '<button class="plan-menu-item danger" type="button" data-del>' + icon("trash") + "<span>削除</span></button>");

  const nameExtra =
    variant === "public"
      ? '<span class="plan-tag">公開</span>'
      : isActive
        ? '<span class="plan-tag">表示中</span>'
        : "";

  const coverSrc = getPlanCoverImage(meta);
  const sourceLabelText = SOURCE_LABEL[src] || src;

  return (
    '<article class="plan-row' +
    (variant === "mine" && isActive ? " is-active" : "") +
    '" data-slug="' +
    escapeHtml(meta.slug) +
    '" data-variant="' +
    variant +
    '">' +
    '<div class="plan-dot-badge">' +
    '<span class="plan-dot ' +
    src +
    '" title="' +
    escapeHtml(sourceLabelText) +
    '" aria-label="' +
    escapeHtml(sourceLabelText) +
    '"></span>' +
    "<span>" +
    escapeHtml(sourceLabelText) +
    "</span>" +
    "</div>" +
    '<a class="plan-open" href="' +
    openHref +
    '" data-open>' +
    '<div class="plan-cover">' +
    '<img src="' +
    coverSrc +
    '" alt="' +
    escapeHtml(meta.title || "旅行画像") +
    '" loading="lazy">' +
    "</div>" +
    '<span class="plan-body">' +
    '<span class="plan-name">' +
    escapeHtml(meta.title || "無題の旅行") +
    nameExtra +
    "</span>" +
    (metaLine ? '<span class="plan-meta">' + metaLine + "</span>" : "") +
    (meta.route ? '<span class="plan-route">' + escapeHtml(meta.route) + "</span>" : "") +
    "</span>" +
    "</a>" +
    '<div class="plan-tools">' +
    '<button class="plan-menu-btn" type="button" data-menu aria-haspopup="true" aria-expanded="false" aria-label="操作メニュー">' +
    icon("ellipsisHorizontal") +
    "</button>" +
    '<div class="plan-menu" data-menu-panel hidden>' +
    menuItems +
    "</div>" +
    "</div>" +
    "</article>"
  );
}

function matchesFilter(meta: PlanMeta, filter: string): boolean {
  return !filter || planText(meta).indexOf(filter) >= 0;
}

function render(): void {
  TripPlans.ensureSeed(readGlobalTripConfig());
  const activeSlug = TripPlans.getActiveSlug();
  const filter = state.filter.trim().toLowerCase();

  const mine = TripPlans.listMine().filter((m) => matchesFilter(m, filter));
  const others = TripPlans.listPublic().filter((m) => matchesFilter(m, filter));

  const mineTotal = TripPlans.listMine().length;
  countEl.textContent = mineTotal ? "自分の計画 " + mineTotal + "件" : "計画はまだありません";
  countMineEl.textContent = mine.length ? mine.length + "件" : "";

  // --- 自分の計画 ---
  if (mine.length) {
    gridMine.innerHTML = mine.map((meta) => rowHtml(meta, "mine", activeSlug)).join("");
  } else {
    gridMine.innerHTML =
      '<div class="hub-empty">' +
      '<img src="./images/cover_default.png" alt="東北旅行" style="width: 140px; height: auto; margin: 0 auto 12px; opacity: 0.85;">' +
      (mineTotal
        ? "<b>該当する計画がありません</b><span>検索条件を変えてください</span>"
        : '<b>最初の計画を作りましょう</b><span>「新規計画」から行程を作成できます</span>') +
      "</div>";
  }

  // --- みんなの公開計画（0件のときはセクションごと隠す） ---
  if (others.length) {
    gridPublic.innerHTML = others.map((meta) => rowHtml(meta, "public", activeSlug)).join("");
    countPublicEl.textContent = others.length + "件";
    publicHead.hidden = false;
    gridPublic.hidden = false;
  } else {
    gridPublic.innerHTML = "";
    countPublicEl.textContent = "";
    publicHead.hidden = true;
    gridPublic.hidden = true;
  }
}

function closeMenus(except?: Element | null): void {
  hub.querySelectorAll<HTMLElement>("[data-menu-panel]").forEach((panel) => {
    if (panel === except) return;
    panel.hidden = true;
    const btn = panel.parentElement?.querySelector<HTMLButtonElement>("[data-menu]");
    if (btn) btn.setAttribute("aria-expanded", "false");
  });
}

/**
 * 計画を自分のローカル計画へ複製する。
 * 公開計画からの複製時は、所有＝メンバーのため自分の名前をメンバーに加え、
 * 「自分の計画」セクションに出るようにする。
 */
function duplicateToMine(slug: string, fromPublic: boolean): void {
  const copy = TripPlans.duplicate(slug);
  if (!copy) {
    render();
    return;
  }
  const me = getUser().name.trim();
  if (fromPublic && me) {
    const data = TripPlans.getData(copy.slug);
    const current = (data && data.trip && data.trip.members) || copy.members;
    const names = splitNames(current);
    if (!names.includes(me)) {
      const merged = [...names, me].join("、");
      if (data) {
        data.trip = { ...(data.trip || {}), members: merged };
        TripPlans.saveLocalPlan(copy.slug, data);
      } else {
        TripPlans.upsert({ slug: copy.slug, members: merged });
      }
    }
  }
  render();
  showToast(fromPublic ? "自分の計画に複製しました" : "計画を複製しました");
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest(".plan-tools")) return;
  closeMenus();
});

hub.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const card = target.closest<HTMLElement>("[data-slug]");
  if (!card) return;
  const slug = card.dataset.slug || "";
  const variant = (card.dataset.variant as RowVariant) || "mine";

  const menuButton = target.closest<HTMLButtonElement>("[data-menu]");
  if (menuButton) {
    event.preventDefault();
    const panel = card.querySelector<HTMLElement>("[data-menu-panel]");
    if (!panel) return;
    const willOpen = panel.hidden;
    closeMenus(willOpen ? panel : null);
    panel.hidden = !willOpen;
    menuButton.setAttribute("aria-expanded", String(willOpen));
    return;
  }

  if (target.closest("[data-open]")) {
    TripPlans.setActiveSlug(slug);
    return; // リンク遷移はそのまま
  }
  closeMenus();
  if (target.closest("[data-edit]")) {
    event.preventDefault();
    TripPlans.setActiveSlug(slug);
    const meta = TripPlans.get(slug);
    const path = meta && meta.source === "local" ? "plan-editor.html?plan=" : "itinerary-editor.html?plan=";
    location.href = path + encodeURIComponent(slug);
    return;
  }
  if (target.closest("[data-dup]")) {
    event.preventDefault();
    duplicateToMine(slug, variant === "public");
    return;
  }
  if (target.closest("[data-del]")) {
    event.preventDefault();
    const meta = TripPlans.get(slug);
    const name = meta && meta.title ? meta.title : "この計画";
    if (window.confirm("「" + name + "」を削除しますか？この操作は元に戻せません。")) {
      TripPlans.remove(slug);
      render();
    }
    return;
  }
  const publishButton = target.closest<HTMLButtonElement>("[data-publish]");
  if (publishButton) {
    event.preventDefault();
    void publishPlan(slug, publishButton);
    return;
  }
});

// ---- 公開（Google Sheets へ書き出し） ----
const AUTH_KEY = "trip-dashboard-publish-auth";

function appsScriptUrlFor(meta: PlanMeta | null): string {
  const config = readGlobalTripConfig();
  return (meta && meta.appsScriptUrl) || config.appsScriptUrl || "";
}

function getPublishToken(): string {
  try {
    const s = JSON.parse(localStorage.getItem(AUTH_KEY) || "{}") as PublishAuthSession;
    return s && s.expiresAt && Date.now() < s.expiresAt ? s.token || "" : "";
  } catch {
    return "";
  }
}

function savePublishToken(token: string | undefined, expiresAt: number | undefined): void {
  try {
    localStorage.setItem(
      AUTH_KEY,
      JSON.stringify({
        token: token || "",
        expiresAt: expiresAt || Date.now() + 14 * 24 * 60 * 60 * 1000,
      }),
    );
  } catch {
    /* ignore */
  }
}

function askPassword(): Promise<PasswordPrompt> {
  return new Promise((resolve, reject) => {
    const modal: HTMLDivElement = document.createElement("div");
    modal.className = "pub-modal";
    modal.innerHTML =
      '<form class="pub-box">' +
      "<h2>公開用パスワード</h2>" +
      '<div class="pub-body">' +
      "<p>Apps Script に設定した共有パスワードを入力してください。</p>" +
      '<input type="password" autocomplete="current-password" aria-label="パスワード">' +
      '<div class="pub-error" aria-live="polite"></div>' +
      '<div class="pub-actions">' +
      '<button type="submit">認証して公開</button>' +
      '<button type="button" class="secondary" data-cancel>キャンセル</button>' +
      "</div>" +
      "</div>" +
      "</form>";
    document.body.appendChild(modal);
    const input = modal.querySelector<HTMLInputElement>("input");
    const errorEl = modal.querySelector<HTMLElement>(".pub-error");
    const formEl = modal.querySelector<HTMLFormElement>("form");
    const cancelEl = modal.querySelector<HTMLButtonElement>("[data-cancel]");
    if (!input || !errorEl || !formEl || !cancelEl) {
      modal.remove();
      reject(new Error("パスワード入力欄を初期化できませんでした"));
      return;
    }
    input.focus();
    cancelEl.addEventListener("click", () => {
      modal.remove();
      reject(new Error("cancelled"));
    });
    formEl.addEventListener("submit", (e) => {
      e.preventDefault();
      errorEl.textContent = "";
      resolve({ value: input.value || "", modal, error: errorEl, input });
    });
  });
}

function showToast(message: string, isError?: boolean): void {
  const toast = document.createElement("div");
  toast.className = "pub-toast" + (isError ? " is-error" : "");
  const glyph = isError ? icon("exclamationTriangle") : icon("checkCircle");
  const text = document.createElement("span");
  text.textContent = message;
  toast.innerHTML = glyph;
  toast.appendChild(text);
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 6000);
}

async function authenticate(url: string): Promise<string> {
  // 既存トークンがあれば先に使う
  const existing = getPublishToken();
  if (existing) return existing;
  for (;;) {
    const prompt = await askPassword();
    try {
      const passwordHash = await sha256Hex(prompt.value);
      const res = await callAppsScript(url, { action: "auth", passwordHash });
      savePublishToken(res.token, res.expiresAt);
      prompt.modal.remove();
      return res.token || "";
    } catch (err) {
      prompt.input.value = "";
      prompt.input.focus();
      prompt.error.textContent = errorMessage(err) || "認証に失敗しました";
    }
  }
}

async function publishPlan(slug: string, button: HTMLButtonElement | null): Promise<void> {
  const meta = TripPlans.get(slug);
  if (!meta) return;
  const url = appsScriptUrlFor(meta);
  if (!url) {
    showToast(
      "公開には Apps Script の Web App URL が必要です。docs/trip-config.js の appsScriptUrl を設定し、最新コードでデプロイしてください。",
      true,
    );
    return;
  }
  const data = TripPlans.getData(slug);
  if (!data) {
    showToast("計画データが見つかりませんでした。", true);
    return;
  }
  if (!window.confirm("「" + (meta.title || "この計画") + "」を新しい Google スプレッドシートへ公開します。よろしいですか？"))
    return;

  const planJson = buildPlanJson(data);
  if (button) {
    button.disabled = true;
    button.textContent = "公開中…";
  }

  try {
    const publishOptions = {
      source: "trip-plan-publish",
      idPrefix: "plan",
      timeoutMs: 90000,
      timeoutMessage: "公開がタイムアウトしました",
      failMessage: "公開に失敗しました",
    } as const;
    let token = getPublishToken();
    let res: AppsScriptResponse;
    try {
      res = await postAppsScript(url, { action: "createTrip", plan: planJson, token: token || "" }, publishOptions);
    } catch (err) {
      if (isAuthError(err)) {
        try {
          localStorage.removeItem(AUTH_KEY);
        } catch {
          /* ignore */
        }
        token = await authenticate(url);
        res = await postAppsScript(url, { action: "createTrip", plan: planJson, token: token || "" }, publishOptions);
      } else {
        throw err;
      }
    }
    TripPlans.upsert({
      slug,
      source: "googleSheets",
      spreadsheetId: res.spreadsheetId,
      appsScriptUrl: url,
      published: true,
      builtIn: false,
    });
    render();
    showToast(
      "公開しました。共有用スプレッドシートに行程を書き出しました。" +
        (res.shared === false ? "（共有設定は手動で確認してください）" : ""),
    );
  } catch (err) {
    if (errorMessage(err) !== "cancelled") {
      showToast("公開に失敗しました: " + errorMessage(err), true);
    }
    render();
  }
}

function buildPlanJson(data: LocalPlanData): string {
  return JSON.stringify({
    trip: data.trip,
    itinerary: data.itinerary,
    checklist: data.checklist || [],
  });
}

filterEl.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement | null;
  state.filter = (target && target.value) || "";
  render();
});

registerServiceWorker();

// 招待リンク（plans.html#join=<token>）を開いたら、計画を取り込んでダッシュボードへ。
// 同じ計画（slug 一致）が既にあれば重複作成せず、本文を最新に更新しつつ候補の票はマージする。
async function handleJoinLink(): Promise<boolean> {
  const m = /(?:^|[#&])join=([^&]+)/.exec(location.hash || "");
  if (!m) return false;
  history.replaceState(null, "", location.pathname + location.search);
  const payload = await decodeInvite(m[1]);
  if (!payload) {
    showToast("招待リンクを読み込めませんでした。", true);
    return false;
  }
  const slug = TripPlans.safeSlug(payload.meta.slug || payload.meta.title || "trip");
  const { existed } = TripPlans.mergeLocalPlan(slug, payload.data);
  TripPlans.setActiveSlug(slug);
  // 既存を更新したときは、すぐ遷移せず一覧で結果を見せる
  if (existed) {
    render();
    showToast(`「${payload.meta.title || "旅行"}」を最新に更新しました。`);
    return true;
  }
  location.replace("index.html?plan=" + encodeURIComponent(slug));
  return true;
}

void handleJoinLink().then((joined) => {
  if (!joined) render();
});
