import "../shared/ui.css";
import "./style.css";
import { initPageTransitions } from "../shared/page-transition";

initPageTransitions();

declare global {
  interface Window {
    TRIP_CONFIG?: { sharedBackend?: { apiBaseUrl?: string } };
  }
}

const REQUEST_KEY = "tabi-plan-mcp-oauth-request";
const SESSION_KEY = "trip-dashboard-session";
const details = document.querySelector<HTMLElement>("[data-details]")!;
const status = document.querySelector<HTMLElement>("[data-status]")!;
const approve = document.querySelector<HTMLButtonElement>("[data-approve]")!;
const deny = document.querySelector<HTMLButtonElement>("[data-deny]")!;

function rememberRequest(): string {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("request") || "";
  if (fromHash) {
    sessionStorage.setItem(REQUEST_KEY, fromHash);
    history.replaceState(null, "", location.pathname);
  }
  return fromHash || sessionStorage.getItem(REQUEST_KEY) || "";
}

function sessionToken(): string {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_KEY) || "{}") as { token?: string };
    return parsed.token || "";
  } catch {
    return "";
  }
}

function apiBase(): string {
  return String(window.TRIP_CONFIG?.sharedBackend?.apiBaseUrl || "").replace(/\/+$/, "");
}

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(apiBase() + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Travel-Session": sessionToken() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(result.message || "接続を確認できませんでした"));
  return result;
}

function fail(message: string): void {
  status.textContent = message;
  status.classList.add("is-error");
  details.hidden = true;
}

const request = rememberRequest();
if (!request) {
  fail("接続リクエストが見つかりません。ChatGPTから接続をやり直してください。");
} else if (!sessionToken()) {
  location.replace("login.html?returnTo=" + encodeURIComponent("mcp-authorize.html"));
} else {
  post("/api/mcp/oauth/request", { request }).then((result) => {
    const client = document.querySelector<HTMLElement>("[data-client]");
    const trip = document.querySelector<HTMLElement>("[data-trip]");
    if (client) client.textContent = String(result.clientName || "ChatGPT");
    if (trip) trip.textContent = String(result.tripName || "香港・マカオ・金門旅行");
    details.hidden = false;
    status.textContent = "";
  }).catch((error) => fail(error instanceof Error ? error.message : "接続を確認できませんでした"));
}

async function decide(approved: boolean): Promise<void> {
  approve.disabled = true;
  deny.disabled = true;
  status.classList.remove("is-error");
  status.textContent = approved ? "接続を許可しています…" : "接続を取り消しています…";
  try {
    const result = await post("/api/mcp/oauth/approve", { request, approved });
    sessionStorage.removeItem(REQUEST_KEY);
    const redirect = String(result.redirect || "");
    if (!redirect) throw new Error("ChatGPTへ戻るURLを取得できませんでした");
    location.replace(redirect);
  } catch (error) {
    approve.disabled = false;
    deny.disabled = false;
    fail(error instanceof Error ? error.message : "接続を完了できませんでした");
  }
}

approve.addEventListener("click", () => void decide(true));
deny.addEventListener("click", () => void decide(false));

