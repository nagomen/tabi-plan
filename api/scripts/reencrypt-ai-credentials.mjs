#!/usr/bin/env node
// 登録済みのAI APIキーを、現行の AI_CREDENTIAL_ENCRYPTION_KEY で暗号化し直す。
//
// 使いどころ: マスターキーをローテーションしたあと、旧鍵
// （AI_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS）を環境から外す前に 1 回実行する。
// APIは利用のたびに旧鍵の行を現行鍵へ寄せるが、しばらくAIを使っていない
// 利用者の行は残るため、ここでまとめて移す。
//
//   AI_CREDENTIAL_ENCRYPTION_KEY=<新> AI_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS=<旧> \
//     npm run reencrypt-ai-credentials -w api

import { reencryptStoredCredentials } from "../dist/ai-credential-repo.js";
import { pool } from "../dist/db.js";

try {
  const summary = await reencryptStoredCredentials();
  console.log(`対象 ${summary.total} 件 / 再暗号化 ${summary.reencrypted} 件 / 復号できず ${summary.failed} 件`);
  if (summary.failed > 0) {
    console.error("現行・旧いずれの鍵でも復号できない行があります。該当の利用者にはキーの再登録が必要です。");
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
