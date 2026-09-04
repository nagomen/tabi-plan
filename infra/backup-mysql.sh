#!/usr/bin/env bash
# Tabi Plan の MySQL を、ローカル世代と Cloudflare R2 の両方へ保存する。

set -euo pipefail
umask 077

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:?DB_NAME is required}"
DB_USER="${DB_USER:?DB_USER is required}"
DB_PASSWORD="${DB_PASSWORD:?DB_PASSWORD is required}"
BACKUP_DIR="${BACKUP_DIR:?BACKUP_DIR is required}"
RCLONE_REMOTE="${RCLONE_REMOTE:?RCLONE_REMOTE is required}"
LOCAL_RETENTION_DAYS="${LOCAL_RETENTION_DAYS:-7}"
REMOTE_RETENTION_DAYS="${REMOTE_RETENTION_DAYS:-30}"
BACKUP_LOCAL_ONLY="${BACKUP_LOCAL_ONLY:-0}"
HEALTHCHECK_URL_START="${BACKUP_HEALTHCHECK_URL_START:-}"
HEALTHCHECK_URL_OK="${BACKUP_HEALTHCHECK_URL_OK:-}"
HEALTHCHECK_URL_FAIL="${BACKUP_HEALTHCHECK_URL_FAIL:-}"

ping_healthcheck() {
  local url="$1"
  [[ -z "$url" ]] && return 0
  curl -fsS --max-time 10 --retry 2 "$url" -o /dev/null || true
}

tmp_dump=""
on_exit() {
  local status=$?
  if [[ -n "$tmp_dump" && -f "$tmp_dump" ]]; then
    rm -f "$tmp_dump"
  fi
  if [[ "$status" -ne 0 ]]; then
    echo "[travel-backup] FAILED (exit=$status) at $(date -Iseconds)" >&2
    ping_healthcheck "$HEALTHCHECK_URL_FAIL"
  fi
  exit "$status"
}
trap on_exit EXIT

required_commands=(mysqldump gzip sha256sum)
if [[ "$BACKUP_LOCAL_ONLY" != "1" ]]; then required_commands+=(rclone); fi
for command_name in "${required_commands[@]}"; do
  command -v "$command_name" >/dev/null || {
    echo "[travel-backup] missing command: $command_name" >&2
    exit 1
  }
done
if [[ "$BACKUP_LOCAL_ONLY" != "1" ]]; then
  rclone listremotes | grep -q "^${RCLONE_REMOTE%%:*}:$" || {
    echo "[travel-backup] rclone remote is not configured: ${RCLONE_REMOTE%%:*}:" >&2
    exit 1
  }
fi

ping_healthcheck "$HEALTHCHECK_URL_START"
mkdir -p "$BACKUP_DIR"

timestamp="$(date '+%Y%m%d_%H%M%S')"
base_name="${DB_NAME}_${timestamp}.sql.gz"
dump_file="$BACKUP_DIR/$base_name"
checksum_file="$dump_file.sha256"
tmp_dump="$(mktemp "$BACKUP_DIR/.${DB_NAME}.XXXXXX.sql.gz")"

echo "[travel-backup] dumping $DB_NAME"
MYSQL_PWD="$DB_PASSWORD" mysqldump \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --user="$DB_USER" \
  --single-transaction \
  --quick \
  --skip-lock-tables \
  --no-tablespaces \
  --default-character-set=utf8mb4 \
  "$DB_NAME" \
  | gzip -9 > "$tmp_dump"

gzip -t "$tmp_dump"
dump_bytes="$(stat -c%s "$tmp_dump")"
if [[ "$dump_bytes" -lt 1024 ]]; then
  echo "[travel-backup] dump is unexpectedly small: $dump_bytes bytes" >&2
  exit 1
fi

mv "$tmp_dump" "$dump_file"
tmp_dump=""
(
  cd "$BACKUP_DIR"
  sha256sum "$base_name" > "$base_name.sha256"
)

if [[ "$BACKUP_LOCAL_ONLY" != "1" ]]; then
  echo "[travel-backup] uploading $base_name"
  rclone copyto --no-traverse "$dump_file" "$RCLONE_REMOTE/$base_name" \
    --transfers 1 --checkers 1 --retries 3 --low-level-retries 10
  rclone copyto --no-traverse "$checksum_file" "$RCLONE_REMOTE/$base_name.sha256" \
    --transfers 1 --checkers 1 --retries 3 --low-level-retries 10
fi

find "$BACKUP_DIR" -type f \
  \( -name "${DB_NAME}_*.sql.gz" -o -name "${DB_NAME}_*.sql.gz.sha256" \) \
  -mtime "+$LOCAL_RETENTION_DAYS" -delete
if [[ "$BACKUP_LOCAL_ONLY" != "1" ]]; then
  rclone delete "$RCLONE_REMOTE/" --min-age "${REMOTE_RETENTION_DAYS}d" \
    --include "${DB_NAME}_*.sql.gz" --include "${DB_NAME}_*.sql.gz.sha256"
fi

echo "[travel-backup] OK: $base_name ($dump_bytes bytes)"
ping_healthcheck "$HEALTHCHECK_URL_OK"
