#!/usr/bin/env bash
# 旅行ダッシュボード API を VPS へデプロイする。
#
# Vote とは完全に独立している:
#   - Vote の deploy.sh / vote.conf / Vote データベースには一切触れない
#   - 使うのは同じ MySQL サーバー上の TravelPlan データベースだけ
#   - nginx も /etc/nginx/conf.d/travel-api.conf という別ファイル
#
# 前提:
#   - Node 22 が入っていること（Vote の setup-vps.sh が導入済み）
#   - TravelPlan データベースと travelapp ユーザーが作成済み（api/schema/）
#   - 秘密情報が $ENV_FILE に置いてあること（.env.sample 参照）
#   - TLS は既存の Cloudflare Origin Certificate（*.vote-jt.com）を流用するので
#     certbot は不要
#
# 使い方（サーバー上で）:
#   APP_DIR=$HOME/travel-dashboard API_DOMAIN=travel-api.example.com \
#     bash infra/deploy-api.sh --install-nginx

set -euo pipefail
trap 'echo "[deploy-api] failed at line $LINENO: $BASH_COMMAND" >&2' ERR

APP_DIR="${APP_DIR:-$HOME/travel-dashboard}"
REPO_BRANCH="${REPO_BRANCH:-main}"
API_PORT="${API_PORT:-8001}"
API_DOMAIN="${API_DOMAIN:-}"
ENV_FILE="${ENV_FILE:-$HOME/secure_env/travel-api.env}"
SERVICE_NAME="travel-api.service"
SERVICE_PATH="/etc/systemd/system/$SERVICE_NAME"
NGINX_CONF="${NGINX_CONF:-/etc/nginx/conf.d/travel-api.conf}"
# TLS は Cloudflare Origin Certificate を流用する（*.vote-jt.com を含むため certbot 不要）
SSL_CERT="${SSL_CERT:-/etc/ssl/cloudflare/vote-jt.com.pem}"
SSL_KEY="${SSL_KEY:-/etc/ssl/cloudflare/vote-jt.com.key}"
APP_USER="${APP_USER:-$(id -un)}"
SKIP_GIT="${SKIP_GIT:-0}"
INSTALL_NGINX="${INSTALL_NGINX:-0}"

for arg in "$@"; do
  case "$arg" in
    --skip-git) SKIP_GIT=1 ;;
    --install-nginx) INSTALL_NGINX=1 ;;
    --help|-h)
      cat <<'EOF'
Usage: infra/deploy-api.sh [--skip-git] [--install-nginx]

Environment:
  APP_DIR      リポジトリの場所。既定: $HOME/travel-dashboard
  API_DOMAIN   API の公開ホスト名（--install-nginx のとき必須）
  API_PORT     待ち受けポート。既定: 8001
  ENV_FILE     秘密情報の置き場。既定: $HOME/secure_env/travel-api.env
  SSL_CERT     証明書。既定: /etc/ssl/cloudflare/vote-jt.com.pem
  SSL_KEY      秘密鍵。既定: /etc/ssl/cloudflare/vote-jt.com.key
EOF
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[deploy-api] $ENV_FILE がありません。.env.sample を元に作成してください。" >&2
  exit 1
fi

build_api() {
  cd "$APP_DIR"
  if [[ "$SKIP_GIT" != "1" ]]; then
    git fetch origin "$REPO_BRANCH"
    git checkout "$REPO_BRANCH"
    git pull --ff-only origin "$REPO_BRANCH"
  fi
  npm ci
  npm run build -w api
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  npm run migrate -w api
}

install_service() {
  local tmp
  tmp="$(mktemp)"
  sed -e "s|__APP_USER__|$APP_USER|g" \
      -e "s|__APP_DIR__|$APP_DIR|g" \
      -e "s|__ENV_FILE__|$ENV_FILE|g" \
      "$APP_DIR/infra/travel-api.service" > "$tmp"
  sudo install -m 0644 "$tmp" "$SERVICE_PATH"
  rm -f "$tmp"
  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE_NAME"
  sudo systemctl restart "$SERVICE_NAME"
  sleep 2
  sudo systemctl is-active --quiet "$SERVICE_NAME" || {
    echo "[deploy-api] サービスが起動しませんでした:" >&2
    sudo journalctl -u "$SERVICE_NAME" -n 40 --no-pager >&2
    exit 1
  }
}

install_nginx() {
  if [[ -z "$API_DOMAIN" ]]; then
    echo "[deploy-api] --install-nginx には API_DOMAIN が必要です。" >&2
    exit 1
  fi
  if [[ ! -f "$SSL_CERT" || ! -f "$SSL_KEY" ]]; then
    echo "[deploy-api] 証明書が見つかりません: $SSL_CERT / $SSL_KEY" >&2
    echo "[deploy-api] SSL_CERT / SSL_KEY で別のパスを指定できます。" >&2
    exit 1
  fi
  # 証明書のワイルドカードが API_DOMAIN を含むかを確認しておく
  if ! sudo openssl x509 -in "$SSL_CERT" -noout -ext subjectAltName 2>/dev/null \
      | grep -qE "DNS:(\*\.${API_DOMAIN#*.}|${API_DOMAIN})"; then
    echo "[deploy-api] 警告: $SSL_CERT が $API_DOMAIN を含んでいないようです。" >&2
  fi
  local tmp
  tmp="$(mktemp)"
  sed -e "s|__API_DOMAIN__|$API_DOMAIN|g" \
      -e "s|__API_PORT__|$API_PORT|g" \
      -e "s|__SSL_CERT__|$SSL_CERT|g" \
      -e "s|__SSL_KEY__|$SSL_KEY|g" \
      "$APP_DIR/infra/nginx/travel-api.conf.template" > "$tmp"
  sudo install -m 0644 "$tmp" "$NGINX_CONF"
  rm -f "$tmp"
  sudo nginx -t
  sudo systemctl reload nginx
}

health_check() {
  local url="http://127.0.0.1:$API_PORT/api/health"
  for _ in $(seq 1 10); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "[deploy-api] health OK: $url"
      return 0
    fi
    sleep 1
  done
  echo "[deploy-api] health check 失敗: $url" >&2
  sudo journalctl -u "$SERVICE_NAME" -n 40 --no-pager >&2
  exit 1
}

main() {
  build_api
  install_service
  health_check
  if [[ "$INSTALL_NGINX" == "1" ]]; then
    install_nginx
  fi
  echo "[deploy-api] 完了。ログ: sudo journalctl -u $SERVICE_NAME -f"
}

main "$@"
