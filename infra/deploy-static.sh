#!/usr/bin/env bash
# Build the Vite frontend and atomically publish frontend/dist through nginx.

set -euo pipefail
trap 'echo "[deploy-static] failed at line $LINENO: $BASH_COMMAND" >&2' ERR

APP_DIR="${APP_DIR:-$HOME/travel-dashboard}"
REPO_BRANCH="${REPO_BRANCH:-restructure-frontend-backend-ts}"
DOMAIN="${DOMAIN:-example.com}"
WEB_BASE="${WEB_BASE:-/var/www/travel-dashboard}"
RELEASES_DIR="${RELEASES_DIR:-$WEB_BASE/releases}"
WEB_ROOT="${WEB_ROOT:-$WEB_BASE/current}"
NGINX_CONF="${NGINX_CONF:-/etc/nginx/conf.d/travel-dashboard.conf}"
NGINX_SECURITY_SNIPPET="${NGINX_SECURITY_SNIPPET:-/etc/nginx/snippets/travel-dashboard-security-headers.conf}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
SKIP_GIT="${SKIP_GIT:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
INSTALL_NGINX="${INSTALL_NGINX:-0}"

for arg in "$@"; do
  case "$arg" in
    --skip-git) SKIP_GIT=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --install-nginx) INSTALL_NGINX=1 ;;
    --help|-h)
      cat <<'EOF'
Usage: infra/deploy-static.sh [--skip-git] [--skip-build] [--install-nginx]

Environment:
  APP_DIR       Repository directory. Default: $HOME/travel-dashboard
  REPO_BRANCH   Branch to deploy. Default: restructure-frontend-backend-ts
  DOMAIN        Public domain, e.g. travel.example.com
  WEB_BASE      Web root base. Default: /var/www/travel-dashboard
  KEEP_RELEASES Number of old releases to keep. Default: 5
EOF
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

render_nginx() {
  local tmp
  tmp="$(mktemp)"
  sed \
    -e "s|__DOMAIN__|$DOMAIN|g" \
    -e "s|__WEB_ROOT__|$WEB_ROOT|g" \
    "$APP_DIR/infra/nginx/travel-dashboard.conf.template" > "$tmp"
  sudo install -m 0644 "$tmp" "$NGINX_CONF"
  sudo install -d -m 0755 "$(dirname "$NGINX_SECURITY_SNIPPET")"
  sudo install -m 0644 "$APP_DIR/infra/nginx/travel-dashboard-security-headers.conf" "$NGINX_SECURITY_SNIPPET"
  rm -f "$tmp"
  sudo nginx -t
  sudo systemctl reload nginx
}

build_frontend() {
  cd "$APP_DIR"
  if [[ "$SKIP_GIT" != "1" ]]; then
    git fetch origin "$REPO_BRANCH"
    git checkout "$REPO_BRANCH"
    git pull --ff-only origin "$REPO_BRANCH"
  fi
  if [[ "$SKIP_BUILD" == "1" ]]; then
    test -d "$APP_DIR/frontend/dist"
    return
  fi
  npm ci
  npm run build
}

publish_release() {
  local release
  release="$RELEASES_DIR/$(date +%Y%m%d%H%M%S)"
  sudo install -d -m 755 "$RELEASES_DIR"
  sudo rsync -a --delete "$APP_DIR/frontend/dist/" "$release/"
  sudo ln -sfn "$release" "$WEB_ROOT"
  sudo nginx -t
  sudo systemctl reload nginx
  find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d | sort -r | tail -n +"$((KEEP_RELEASES + 1))" | xargs -r sudo rm -rf
  echo "[deploy-static] published: $release"
}

main() {
  build_frontend
  if [[ "$INSTALL_NGINX" == "1" ]]; then
    render_nginx
  fi
  publish_release
}

main "$@"
