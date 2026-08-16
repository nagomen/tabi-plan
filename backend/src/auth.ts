// パスワード認証トークンの署名・検証と暗号ユーティリティ。

const AUTH_ATTEMPT_LIMIT_PER_MINUTE = 30;

/** Apps Scriptでは接続元IPを取得できないため、スクリプト全体の試行数を制限する。 */
function enforceAuthRateLimit_(): void {
  const minute = Math.floor(Date.now() / 60000);
  const key = `auth_attempts_${minute}`;
  const lock = LockService.getScriptLock();
  lock.waitLock(3000);
  try {
    const cache = CacheService.getScriptCache();
    const attempts = Number(cache.get(key) || 0) + 1;
    cache.put(key, String(attempts), 90);
    if (attempts > AUTH_ATTEMPT_LIMIT_PER_MINUTE) {
      throw new Error('認証の試行回数が多すぎます。しばらく待ってから再試行してください');
    }
  } finally {
    lock.releaseLock();
  }
}


function signToken_(payload: any, secret: string): string {
  const body = base64UrlEncode_(JSON.stringify(payload));
  const signature = base64UrlEncodeBytes_(Utilities.computeHmacSha256Signature(body, secret));
  return `${body}.${signature}`;
}

function verifyToken_(token: string, secret: string): any {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) throw new Error('Authentication is required');

  const expected = base64UrlEncodeBytes_(Utilities.computeHmacSha256Signature(parts[0], secret));
  if (!constantTimeEqual_(parts[1], expected)) throw new Error('Invalid token');

  const payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  if (!payload.exp || Date.now() > Number(payload.exp)) throw new Error('Token expired');
  return payload;
}

function sha256Hex_(text: string): string {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text)
    .map(byte => (byte < 0 ? byte + 256 : byte).toString(16).padStart(2, '0'))
    .join('');
}

function base64UrlEncode_(text: string): string {
  return Utilities.base64EncodeWebSafe(text).replace(/=+$/, '');
}

function base64UrlEncodeBytes_(bytes: number[]): string {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function constantTimeEqual_(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
