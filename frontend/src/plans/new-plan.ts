import * as db from "../shared/db";
import { icon } from "../shared/icons";
import { isIdentified } from "../shared/identity";
import { createMainEl, inviteStripEl, inviteTitleEl, inviteNoteEl } from "./dom";

export function renderStart(): void {
  const invites = db.pendingInvites();
  createMainEl.innerHTML = icon("plusCircle") + "<span>新しい旅行計画を作る</span>";
  createMainEl.href = newPlanHref();
  inviteStripEl.classList.toggle("is-visible", invites.length > 0);
  if (invites.length) {
    inviteTitleEl.textContent = "未参加の招待があります";
    inviteNoteEl.textContent = invites.map((invite) => invite.plan_title).slice(0, 3).join("、");
  }
}

export function newPlanHref(): string {
  if (!db.isEnabled() || isIdentified()) return "plan-editor.html";
  return "login.html?returnTo=" + encodeURIComponent("plan-editor.html");
}
