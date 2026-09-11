import * as db from "../shared/db";
import type { PlanMeta, PlanSource } from "../shared/plans-store";
import { escapeHtml } from "../shared/dom";
import { planDashboardHref } from "../shared/plan-url";
import { icon } from "../shared/icons";
import { getViews } from "../shared/views-store";
import { planCoverThumbnail } from "../shared/cover";
import { splitNames } from "../shared/friend-store";
import { canEditPlan, ownerNameOf, roleLabel, roleOf } from "../shared/membership";
import type { PlanTiming } from "./plan-timing";
import { compactLocationLabel, locationLabel } from "./plan-locations";

const SOURCE_LABEL: Record<string, string> = {
  local: "ローカル",
  sample: "サンプル",
};

function sourceClass(source: PlanSource | string): string {
  return source === "local" || source === "sample" ? source : "local";
}

function planText(meta: PlanMeta): string {
  return [meta.title, locationLabel(meta), meta.route, meta.dates, meta.members, creatorName(meta)].join(" ").toLowerCase();
}

export function planHref(meta: PlanMeta, view = false): string {
  return planDashboardHref(meta.slug, { view });
}

export function emptyList(message: string): string {
  return '<div class="hub-empty" style="border:0;background:#fff;padding:24px 14px;">' + escapeHtml(message) + "</div>";
}

function creatorName(meta: PlanMeta): string {
  return ownerNameOf(meta) || splitNames(meta.members)[0] || "作成者不明";
}

function personHref(name: string, userId = ""): string {
  return "person.html?name=" + encodeURIComponent(name) + (userId ? "&user=" + encodeURIComponent(userId) : "");
}

function creatorLinkHtml(meta: PlanMeta, className: string): string {
  const name = creatorName(meta);
  const ownerId = db.planBySlug(meta.slug)?.owner_user_id || "";
  const isUnknown = name === "作成者不明";
  const linkAttrs = isUnknown
    ? ""
    : ' role="link" tabindex="0" data-author-link="' + escapeHtml(personHref(name, ownerId)) + '" aria-label="' + escapeHtml(name + "の人物ページを開く") + '"';
  return (
    '<span class="' + className + (isUnknown ? " is-unknown" : "") + '"' + linkAttrs + ">" +
    icon("user") +
    "<span>" + escapeHtml(name) + "</span></span>"
  );
}

export type RowVariant = "mine" | "public";

/** 1枚のカード（計画）の HTML を組み立てる。variant で「自分の計画」/「みんなの公開計画」を出し分ける。 */
export function rowHtml(
  meta: PlanMeta,
  variant: RowVariant,
  activeSlug: string,
  highlight?: PlanTiming,
  badge?: string,
): string {
  const src = sourceClass(meta.source);
  const isLocal = meta.source === "local";
  const isActive = meta.slug === activeSlug;
  const metaLine = (variant === "public" ? [meta.dates] : [meta.dates, meta.members]).filter(Boolean).map(escapeHtml).join(" · ");
  const compactLocations = compactLocationLabel(meta);
  const authorLine =
    variant === "public"
      ? creatorLinkHtml(meta, "plan-author")
      : "";
  const openHref = planHref(meta, variant === "public" || !canEditPlan(meta));
  const role = roleOf(meta);
  const roleBadge = role
    ? '<span class="role-badge ' + role + '">' + escapeHtml(roleLabel(role)) + "</span>"
    : "";
  const highlightBadge =
    highlight === "current"
      ? '<span class="plan-highlight-badge current">期間中</span>'
      : highlight === "upcoming"
        ? '<span class="plan-highlight-badge upcoming">直近</span>'
        : "";

  const menuItems =
    variant === "public"
      ? '<button class="plan-menu-item" type="button" data-dup>' +
        icon("documentDuplicate") +
        "<span>自分の計画に複製</span></button>"
      : ((role === "owner" || role === "editor") && isLocal
          ? '<button class="plan-menu-item" type="button" data-edit>' + icon("pencilSquare") + "<span>編集</span></button>"
          : "") +
        '<button class="plan-menu-item" type="button" data-dup>' +
        icon("documentDuplicate") +
        "<span>複製</span></button>" +
        (meta.builtIn || role !== "owner"
          ? ""
          : '<button class="plan-menu-item danger" type="button" data-del>' + icon("trash") + "<span>削除</span></button>");

  const nameExtra =
    variant === "public"
      ? '<span class="plan-tag">公開</span>'
      : isActive
        ? '<span class="plan-tag">表示中</span>'
        : "";

  const coverSrc = planCoverThumbnail(meta);
  const sourceLabelText = SOURCE_LABEL[src] || src;
  const views = getViews(meta.slug);
  const viewsBadge =
    '<div class="plan-views-badge" title="観覧数" aria-label="観覧数 ' +
    views +
    '">' +
    icon("eye") +
    "<span>" +
    views.toLocaleString("ja-JP") +
    "</span></div>";

  return (
    '<article class="plan-row' +
    (variant === "mine" && isActive ? " is-active" : "") +
    (highlight ? " is-" + highlight : "") +
    '" data-slug="' +
    escapeHtml(meta.slug) +
    '" data-variant="' +
    variant +
    '">' +
    (badge
      ? '<div class="plan-dot-badge is-rank"><span>' + escapeHtml(badge) + "</span></div>"
      : '<div class="plan-dot-badge">' +
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
    "</div>") +
    '<a class="plan-open" href="' +
    openHref +
    '" data-open>' +
    '<div class="plan-cover">' +
    '<img src="' +
    escapeHtml(coverSrc) +
    '" alt="' +
    escapeHtml(meta.title || "旅行画像") +
    '" loading="lazy">' +
    viewsBadge +
    "</div>" +
    '<span class="plan-body">' +
    '<span class="plan-name">' +
    '<span class="plan-name-text">' +
    escapeHtml(meta.title || "無題の旅行") +
    nameExtra +
    "</span>" +
    roleBadge +
    highlightBadge +
    "</span>" +
    authorLine +
    (metaLine ? '<span class="plan-meta">' + metaLine + "</span>" : "") +
    (compactLocations ? '<span class="plan-route">' + escapeHtml(compactLocations) + "</span>" : "") +
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

export function matchesFilter(meta: PlanMeta, filter: string): boolean {
  return !filter || planText(meta).indexOf(filter) >= 0;
}
