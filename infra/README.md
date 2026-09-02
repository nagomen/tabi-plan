# Production operations

Tabi Plan has one production path per responsibility:

- Frontend: GitHub Pages, deployed by `.github/workflows/deploy-pages.yml`.
- API: nginx and `travel-api.service` on the VPS, deployed by `.github/workflows/deploy-api.yml`.
- Data: the `TravelPlan` MySQL database on the VPS.
- Backups: `travel-mysql-backup.timer`, stored locally for 7 days and in Cloudflare R2 for 30 days.

The frontend is not served from the VPS. Do not create a second nginx frontend root or copy `frontend/dist` to the VPS.

## API deployment

Run the `Deploy API` GitHub Actions workflow with the Git ref to deploy. It validates the API, synchronizes the source, applies backward-compatible migrations, restarts the API, checks its health, and installs the backup timer.

Required repository settings:

| Name | Kind | Purpose |
| --- | --- | --- |
| `PRODUCTION_SSH_HOST` | Secret | VPS hostname or IP |
| `PRODUCTION_SSH_USER` | Secret | VPS deploy user |
| `PRODUCTION_SSH_KEY` | Secret | CI deploy key |
| `PRODUCTION_SSH_PORT` | Secret | Optional SSH port; defaults to `22` |
| `PRODUCTION_SSH_KNOWN_HOSTS` | Secret | Pinned output of `ssh-keyscan` |
| `PRODUCTION_SSH_FINGERPRINT` | Secret | Pinned host-key SHA256 fingerprint |
| `PRODUCTION_APP_DIR` | Variable | API source directory on the VPS |
| `PRODUCTION_API_DOMAIN` | Variable | Public API hostname |
| `PRODUCTION_API_ENV_FILE` | Variable | Server-only environment file |

## Database backups

`infra/backup-mysql.sh` creates a transactionally consistent compressed dump, validates gzip integrity, writes a SHA-256 checksum, uploads both files to R2, and prunes expired generations.

The API environment file supplies `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD`. Optional monitoring endpoints are:

- `BACKUP_HEALTHCHECK_URL_START`
- `BACKUP_HEALTHCHECK_URL_OK`
- `BACKUP_HEALTHCHECK_URL_FAIL`

Check the timer and the latest run with:

```bash
systemctl list-timers travel-mysql-backup.timer
systemctl status travel-mysql-backup.service
journalctl -u travel-mysql-backup.service -n 50 --no-pager
```

A backup is not considered proven until an R2 copy has been downloaded, its checksum has passed, and it has been restored into a temporary database.
