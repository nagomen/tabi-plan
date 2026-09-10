import * as db from "../shared/db";
import { escapeHtml, errorMessage } from "../shared/dom";
import { showRecoveryCode } from "../shared/recovery-code";

export interface LoginMethodEls {
  loginMethodsEl: HTMLElement | null;
  loginNoteEl: HTMLElement | null;
}

// ---- ログイン方法（メール / LINE） --------------------------------------

export function mountLoginMethods(els: LoginMethodEls): { renderLoginMethods: () => void } {
  const { loginMethodsEl, loginNoteEl } = els;

  /** 行の下に開いている入力欄（"password" | "email" | ""）。 */
  let openLoginForm: "password" | "email" = "password";
  let loginFormShown = false;

  function loginFormHtml(): string {
    if (!loginFormShown) return "";
    return openLoginForm === "password"
      ? '<div class="mp-login-form" data-pw-form>' +
        '<input type="password" autocomplete="current-password" placeholder="いまのパスワード" data-pw-current>' +
        '<input type="password" autocomplete="new-password" placeholder="新しいパスワード（8文字以上）" data-pw-next>' +
        '<button type="button" data-pw-save>変更する</button>' +
        '<p class="mp-login-msg" data-login-msg>変更すると、他の端末のログインは切れます。</p></div>'
      : '<div class="mp-login-form" data-mail-form>' +
        '<input type="email" autocomplete="email" placeholder="メールアドレス" data-mail-address>' +
        '<input type="password" autocomplete="new-password" placeholder="パスワード（8文字以上）" data-mail-password>' +
        '<button type="button" data-mail-save>登録する</button>' +
        '<p class="mp-login-msg" data-login-msg>LINEが使えなくなったときの入り口になります。</p></div>';
  }

  function renderLoginMethods(): void {
    if (!loginMethodsEl || !loginNoteEl) return;
    if (!db.isEnabled()) {
      loginNoteEl.textContent = "この構成ではアカウント連携を使いません。";
      loginMethodsEl.innerHTML = "";
      return;
    }
    const line = db.identities().find((entry) => entry.provider === "line");
    // bootstrap は自分の認証情報だけ返すので、行があればメール登録済み。
    const mail = db.credentials()[0];
    const hasMail = Boolean(mail);
    loginNoteEl.textContent = line
      ? "LINEアカウントでログインできます。表示名はここで変えても LINE 名に戻りません。"
      : "LINEと連携すると、次回からメールアドレスの入力なしでログインできます。";
    const name = line?.display_name ? `（${escapeHtml(line.display_name)}）` : "";

    const mailRow = '<div class="mp-login-row"><span class="mp-login-mark is-mail">メール</span>' +
      (hasMail
        ? `<span class="mp-login-state">${escapeHtml(mail.email)}</span>` +
          '<button class="mp-login-act" type="button" data-pw-open>パスワードを変更</button>' +
          '<button class="mp-login-act" type="button" data-recovery-code>復旧コードを再発行</button>'
        : '<span class="mp-login-state">未登録</span>' +
          '<button class="mp-login-act is-primary" type="button" data-mail-open>登録する</button>') +
      (loginFormShown && ((hasMail && openLoginForm === "password") || (!hasMail && openLoginForm === "email"))
        ? loginFormHtml()
        : "") +
      "</div>";

    const lineRow = line
      ? '<div class="mp-login-row"><span class="mp-login-mark">LINE</span>' +
        `<span class="mp-login-state">連携済み${name}</span>` +
        (hasMail
          ? '<button class="mp-login-act" type="button" data-line-unlink>解除する</button>'
          : '<span class="mp-login-hint">解除するには、先にメールアドレスとパスワードを登録してください</span>') +
        "</div>"
      : '<div class="mp-login-row"><span class="mp-login-mark">LINE</span>' +
        '<span class="mp-login-state">未連携</span>' +
        '<button class="mp-login-act is-primary" type="button" data-line-link>LINEと連携する</button></div>';

    // 端末を失くしたときに自分で切れるようにする（ログアウトは今の端末だけ）。
    const devicesRow = '<div class="mp-login-row"><span class="mp-login-mark is-mail">端末</span>' +
      '<span class="mp-login-state">他の端末のログイン</span>' +
      '<button class="mp-login-act" type="button" data-revoke-others>すべて切る</button>' +
      '<p class="mp-login-msg" data-devices-msg></p></div>';

    loginMethodsEl.innerHTML = mailRow + lineRow + devicesRow;
  }

  function loginMsg(text: string, kind: "" | "error" | "done" = ""): void {
    const el = loginMethodsEl?.querySelector<HTMLElement>("[data-login-msg]");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("is-error", kind === "error");
    el.classList.toggle("is-done", kind === "done");
  }

  loginMethodsEl?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest("[data-pw-open]") || target.closest("[data-mail-open]")) {
      openLoginForm = target.closest("[data-pw-open]") ? "password" : "email";
      loginFormShown = !loginFormShown;
      renderLoginMethods();
      loginMethodsEl?.querySelector<HTMLInputElement>(".mp-login-form input")?.focus();
      return;
    }

    if (target.closest("[data-pw-save]")) {
      const button = target.closest<HTMLButtonElement>("[data-pw-save]");
      const current = loginMethodsEl?.querySelector<HTMLInputElement>("[data-pw-current]")?.value || "";
      const next = loginMethodsEl?.querySelector<HTMLInputElement>("[data-pw-next]")?.value || "";
      if (next.length < 8) {
        loginMsg("新しいパスワードは8文字以上にしてください", "error");
        return;
      }
      if (button) button.disabled = true;
      loginMsg("変更しています…");
      void db.changePassword({ current_password: current, new_password: next })
        .then((result) => {
          loginFormShown = false;
          renderLoginMethods();
          showRecoveryCode(result.recovery_code);
          const tail = result.revoked ? `他の端末（${result.revoked}件）のログインも切りました。` : "";
          window.alert("パスワードを変更しました。" + tail);
        })
        .catch((error) => {
          if (button) button.disabled = false;
          loginMsg(errorMessage(error) || "変更できませんでした", "error");
        });
      return;
    }

    if (target.closest("[data-mail-save]")) {
      const button = target.closest<HTMLButtonElement>("[data-mail-save]");
      const email = loginMethodsEl?.querySelector<HTMLInputElement>("[data-mail-address]")?.value.trim() || "";
      const password = loginMethodsEl?.querySelector<HTMLInputElement>("[data-mail-password]")?.value || "";
      if (password.length < 8) {
        loginMsg("パスワードは8文字以上にしてください", "error");
        return;
      }
      if (button) button.disabled = true;
      loginMsg("登録しています…");
      void db.addCredentials({ email, password })
        .then((result) => {
          loginFormShown = false;
          renderLoginMethods();
          showRecoveryCode(result.recovery_code);
          window.alert("メールアドレスとパスワードを登録しました。次回はどちらでもログインできます。");
        })
        .catch((error) => {
          if (button) button.disabled = false;
          loginMsg(errorMessage(error) || "登録できませんでした", "error");
        });
      return;
    }

    if (target.closest("[data-recovery-code]")) {
      if (!window.confirm("古い復旧コードを無効にして、新しいコードを発行します。よろしいですか。")) return;
      const button = target.closest<HTMLButtonElement>("[data-recovery-code]");
      if (button) button.disabled = true;
      void db.rotateRecoveryCode()
        .then((code) => showRecoveryCode(code))
        .catch((error) => window.alert(errorMessage(error) || "復旧コードを発行できませんでした"))
        .finally(() => { if (button) button.disabled = false; });
      return;
    }

    if (target.closest("[data-revoke-others]")) {
      if (!window.confirm("この端末以外のログインを切ります。よろしいですか。")) return;
      const msg = loginMethodsEl?.querySelector<HTMLElement>("[data-devices-msg]");
      void db.revokeOtherSessions()
        .then((revoked) => {
          if (msg) msg.textContent = revoked ? `${revoked}件のログインを切りました。` : "他の端末のログインはありませんでした。";
        })
        .catch((error) => {
          if (msg) {
            msg.textContent = errorMessage(error) || "切れませんでした";
            msg.classList.add("is-error");
          }
        });
      return;
    }

    if (target.closest("[data-line-link]")) {
      void db.lineAuthorizeUrl(new URL("mypage.html", location.href).toString())
        .then((url) => {
          if (url) location.href = url;
          else window.alert("LINEとの連携を開始できませんでした");
        })
        .catch((error) => window.alert(errorMessage(error)));
      return;
    }
    if (target.closest("[data-line-unlink]")) {
      if (!window.confirm("LINEでのログインを解除します。よろしいですか。")) return;
      void db.unlinkLine()
        .then(() => renderLoginMethods())
        .catch((error) => window.alert(errorMessage(error)));
    }
  });

  return { renderLoginMethods };
}
