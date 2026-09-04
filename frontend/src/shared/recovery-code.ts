/** 一度しか表示されないアカウント復旧コードを、安全な保管先へコピーしてもらう。 */
export function showRecoveryCode(code: string): void {
  if (!code) return;
  window.prompt(
    "この復旧コードは再表示できません。パスワード管理アプリなど安全な場所へコピーしてください。",
    code,
  );
}
