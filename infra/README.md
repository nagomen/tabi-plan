# Static Deploy

This app ships the frontend as Vite static files. GitHub remains the source of truth for source code, CI, and deploy orchestration.

- GitHub Pages is a preview target.
- Production should be nginx on a VPS/EC2, with the API either on the same origin under `/api/` or on a dedicated API domain.
- `frontend/public/trip-config.js` is included in the static build. Do not put secrets in it.

## Server Setup

On a fresh Ubuntu 24.04 server:

```bash
sudo APP_USER=ubuntu bash infra/setup-static-vps.sh
```

Clone this repository to `/home/ubuntu/travel-dashboard` or set `APP_DIR` to your chosen path.

## First nginx Install

Point DNS for your domain to the server, then install nginx config:

```bash
sudo -u ubuntu APP_DIR=/home/ubuntu/travel-dashboard DOMAIN=travel.example.com \
  bash /home/ubuntu/travel-dashboard/infra/deploy-static.sh --install-nginx --skip-git
```

Issue TLS:

```bash
sudo certbot --nginx -d travel.example.com -d www.travel.example.com --redirect
```

## Deploy

```bash
sudo -u ubuntu APP_DIR=/home/ubuntu/travel-dashboard DOMAIN=travel.example.com \
  bash /home/ubuntu/travel-dashboard/infra/deploy-static.sh
```

The script:

- pulls `restructure-frontend-backend-ts` by default
- runs `npm ci`
- runs `npm run build`
- publishes `frontend/dist` under `/var/www/travel-dashboard/releases/<timestamp>`
- atomically points `/var/www/travel-dashboard/current` to that release
- reloads nginx

For GitHub Actions production deploy, use `.github/workflows/deploy-production.yml`.
It builds in Actions, uploads `frontend/dist` to the VPS, then runs:

```bash
bash infra/deploy-static.sh --skip-build
```

Required repository/environment settings:

| Name | Kind | Purpose |
| --- | --- | --- |
| `PRODUCTION_SSH_HOST` | Secret | VPS hostname or IP |
| `PRODUCTION_SSH_USER` | Secret | SSH user |
| `PRODUCTION_SSH_KEY` | Secret | Private deploy key |
| `PRODUCTION_SSH_PORT` | Secret | Optional SSH port, defaults to `22` |
| `PRODUCTION_DOMAIN` | Variable | Public frontend domain |
| `PRODUCTION_APP_DIR` | Variable | Repo path on the VPS, for example `/home/ubuntu/travel-dashboard` |
| `PRODUCTION_TRIP_CONFIG_JSON` | Variable | Optional production config. Falls back to `TRIP_CONFIG_JSON` |

If `sharedBackend.apiBaseUrl` is empty, the frontend calls the same origin (`/api/...`).
Enable the `/api/` proxy block in `infra/nginx/travel-dashboard.conf.template` when using that setup.

For the API process, set a strong `SESSION_SECRET` in addition to `API_TOKEN`.
`API_TOKEN` is still exposed to the static frontend as a basic API gate; per-user permissions rely on the server-signed `X-Travel-Session` token issued by `/api/auth/login` and `/api/auth/signup`.
Leave `LEGACY_STORE_TOKEN` empty in normal operation. Set it only while running old `/api/store` migration or maintenance scripts.

## App Config

`frontend/public/trip-config.js` is included in the static build. Do not put secrets in it. Apps Script URLs and public IDs are okay; passwords, reservation numbers, private addresses, and emergency contacts are not.
