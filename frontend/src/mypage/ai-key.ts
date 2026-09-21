import * as db from "../shared/db";
import { errorMessage } from "../shared/dom";
import { isLoggedIn } from "../shared/account-store";

export interface AiKeyEls {
  form: HTMLFormElement;
  input: HTMLInputElement;
  revealButton: HTMLButtonElement;
  saveButton: HTMLButtonElement;
  deleteButton: HTMLButtonElement;
  state: HTMLElement;
  detail: HTMLElement;
  message: HTMLElement;
}

export function mountAiKey(els: AiKeyEls): { renderAiKey: () => Promise<void> } {
  let loading: Promise<void> | null = null;

  function setMessage(text: string, kind: "" | "error" | "done" = ""): void {
    els.message.textContent = text;
    els.message.className = "mp-ai-key-message" + (kind ? ` is-${kind}` : "");
  }

  function setBusy(busy: boolean): void {
    els.input.disabled = busy || !isLoggedIn();
    els.revealButton.disabled = busy || !isLoggedIn();
    els.saveButton.disabled = busy || !isLoggedIn();
    els.deleteButton.disabled = busy || !isLoggedIn();
    els.saveButton.textContent = busy ? "確認中…" : "接続確認して保存";
  }

  function showStatus(status: db.AiCredentialStatus): void {
    els.deleteButton.hidden = !status.configured;
    if (status.configured) {
      els.state.textContent = `自分のAPIキー（••••${status.last_four}）`;
      els.state.className = "mp-ai-key-state is-own";
      els.detail.textContent = "このキーが所属するOpenAIプロジェクトへ利用料金が計上されます。アプリの1日3回制限は適用されません。";
      return;
    }
    els.state.textContent = status.service_available ? "サービス提供枠を利用中" : "APIキー未設定";
    els.state.className = "mp-ai-key-state";
    els.detail.textContent = status.service_available
      ? "現在はサービス共通の利用枠（1日3回まで）を使います。自分のキーを登録すると本人課金へ切り替わります。"
      : "AI旅行相談を使うには、自分のOpenAI APIキーを登録してください。";
  }

  async function renderAiKey(): Promise<void> {
    if (loading) return loading;
    if (!isLoggedIn()) {
      els.state.textContent = "ログインが必要です";
      els.state.className = "mp-ai-key-state";
      els.detail.textContent = "APIキーはログイン中のアカウントに暗号化して保存されます。";
      els.deleteButton.hidden = true;
      setBusy(false);
      return;
    }
    loading = (async () => {
      setBusy(true);
      try {
        showStatus(await db.getAiCredentialStatus());
        setMessage("");
      } catch (error) {
        setMessage(errorMessage(error) || "APIキーの設定状態を取得できませんでした。", "error");
      } finally {
        setBusy(false);
        loading = null;
      }
    })();
    return loading;
  }

  els.revealButton.addEventListener("click", () => {
    const reveal = els.input.type === "password";
    els.input.type = reveal ? "text" : "password";
    els.revealButton.textContent = reveal ? "隠す" : "表示";
    els.revealButton.setAttribute("aria-pressed", String(reveal));
  });

  els.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const apiKey = els.input.value.trim();
    if (!apiKey) {
      setMessage("sk- から始まるOpenAI APIキーを入力してください。", "error");
      els.input.focus();
      return;
    }
    setBusy(true);
    setMessage("OpenAIへ接続してキーを確認しています…");
    try {
      const status = await db.saveAiCredential(apiKey);
      els.input.value = "";
      els.input.type = "password";
      els.revealButton.textContent = "表示";
      els.revealButton.setAttribute("aria-pressed", "false");
      showStatus(status);
      setMessage("APIキーを確認し、安全に保存しました。次回のAI利用から本人課金になります。", "done");
    } catch (error) {
      setMessage(errorMessage(error) || "APIキーを保存できませんでした。", "error");
    } finally {
      setBusy(false);
    }
  });

  els.deleteButton.addEventListener("click", async () => {
    if (!window.confirm("保存済みのOpenAI APIキーを削除しますか？")) return;
    setBusy(true);
    try {
      showStatus(await db.deleteAiCredential());
      setMessage("保存済みのAPIキーを削除しました。", "done");
    } catch (error) {
      setMessage(errorMessage(error) || "APIキーを削除できませんでした。", "error");
    } finally {
      setBusy(false);
    }
  });

  return { renderAiKey };
}
