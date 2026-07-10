#!/usr/bin/env bash
# Static VPS setup for the travel dashboard.
# Ubuntu 24.04 LTS is assumed. Run as root or with sudo.

set -euo pipefail
trap 'echo "[setup-static-vps] failed at line $LINENO: $BASH_COMMAND" >&2' ERR

APP_USER="${APP_USER:-ubuntu}"
APP_DIR="${APP_DIR:-/home/$APP_USER/travel-dashboard}"
RELEASES_DIR="${RELEASES_DIR:-/var/www/travel-dashboard/releases}"
WEB_ROOT="${WEB_ROOT:-/var/www/travel-dashboard/current}"
NODE_MAJOR="${NODE_MAJOR:-22}"
TIMEZONE="${TIMEZONE:-Asia/Tokyo}"

require_root() {
  if [[ "$EUID" -ne 0 ]]; then
    echo "[setup-static-vps] run with sudo" >&2
    exit 1
  fi
}

ensure_user() {
  if ! id -u "$APP_USER" >/dev/null 2>&1; then
    adduser --disabled-password --gecos "" "$APP_USER"
    usermod -aG sudo "$APP_USER"
  fi
}

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  timedatectl set-timezone "$TIMEZONE" || true
  apt-get update
  apt-get install -y ca-certificates curl gnupg git rsync nginx certbot python3-certbot-nginx ufw
}

install_node() {
  if command -v node >/dev/null 2>&1 && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR" ]]; then
    return 0
  fi
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
}

setup_directories() {
  install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
  install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$RELEASES_DIR"
  install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$(dirname "$WEB_ROOT")"
}

setup_firewall() {
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
}

main() {
  require_root
  ensure_user
  install_packages
  install_node
  setup_directories
  setup_firewall

  cat <<EOF
[setup-static-vps] done.

Next:
  1. Clone this repository into:
       $APP_DIR
  2. Put infra/nginx/travel-dashboard.conf.template into nginx with infra/deploy-static.sh --install-nginx
  3. Issue a certificate:
       sudo certbot --nginx -d YOUR_DOMAIN -d www.YOUR_DOMAIN --redirect
  4. Deploy:
       sudo -u $APP_USER APP_DIR=$APP_DIR DOMAIN=YOUR_DOMAIN bash $APP_DIR/infra/deploy-static.sh
EOF
}

main "$@"
