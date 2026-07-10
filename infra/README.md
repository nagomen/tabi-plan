# Static VPS Deploy

This app is a Vite static frontend. It does not need the VOTE FastAPI, MySQL, RDS, or systemd service stack.

Use this `infra/` only when deploying to a VPS/EC2 with nginx. For the simplest deploy, GitHub Pages is still the default path in `.github/workflows/deploy-pages.yml`.

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

- pulls `main`
- runs `npm ci`
- runs `npm run build`
- publishes `frontend/dist` under `/var/www/travel-dashboard/releases/<timestamp>`
- atomically points `/var/www/travel-dashboard/current` to that release
- reloads nginx

## App Config

`frontend/public/trip-config.js` is included in the static build. Do not put secrets in it. Apps Script URLs and public IDs are okay; passwords, reservation numbers, private addresses, and emergency contacts are not.
