#!/usr/bin/env bash
# ============================================================
#  ZAMBIA POLICE SERVICE — Occurrence Book
#  backup.sh  |  Automated daily database backup
#
#  Crontab setup (run as the user that owns the app):
#    crontab -e
#    # Add this line to run every day at 02:00 AM server time:
#    0 2 * * * /opt/zp_ob/backup.sh >> /var/log/zp_ob_backup.log 2>&1
#
#  Make executable:
#    chmod +x /opt/zp_ob/backup.sh
# ============================================================

set -euo pipefail

# ── Configuration ─────────────────────────────────────────
APP_DIR="/opt/zp_ob"
DB_FILE="${APP_DIR}/zp_ob.db"
BACKUP_DIR="${APP_DIR}/backups"
RETAIN_DAYS=30          # delete backups older than this many days
TIMESTAMP=$(date +"%Y-%m-%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/zp_ob_${TIMESTAMP}.db"

# ── Create backup directory if it does not exist ──────────
mkdir -p "${BACKUP_DIR}"

# ── Verify the database file exists ───────────────────────
if [ ! -f "${DB_FILE}" ]; then
  echo "[$(date)] ERROR: Database not found at ${DB_FILE}" >&2
  exit 1
fi

# ── Create a hot backup using SQLite's online backup API ──
# sqlite3 .backup is safe even while the server is running.
sqlite3 "${DB_FILE}" ".backup '${BACKUP_FILE}'"

# Verify the backup was written
if [ ! -s "${BACKUP_FILE}" ]; then
  echo "[$(date)] ERROR: Backup file is empty or missing: ${BACKUP_FILE}" >&2
  exit 1
fi

SIZE=$(du -h "${BACKUP_FILE}" | cut -f1)
echo "[$(date)] SUCCESS: Backup written to ${BACKUP_FILE} (${SIZE})"

# ── Prune old backups ──────────────────────────────────────
DELETED=$(find "${BACKUP_DIR}" -name "zp_ob_*.db" -mtime "+${RETAIN_DAYS}" -print -delete | wc -l)
if [ "${DELETED}" -gt 0 ]; then
  echo "[$(date)] PRUNED: Removed ${DELETED} backup(s) older than ${RETAIN_DAYS} days."
fi

# ── (Optional) Copy to remote/external storage ────────────
# Uncomment and configure one of the options below:

# Option A — rsync to a remote host (SSH key auth required):
# rsync -az --delete "${BACKUP_DIR}/" backup_user@remote.host:/srv/zp_ob_backups/

# Option B — copy to a mounted external drive:
# EXTERNAL_MOUNT="/mnt/backup_drive"
# if mountpoint -q "${EXTERNAL_MOUNT}"; then
#   cp "${BACKUP_FILE}" "${EXTERNAL_MOUNT}/zp_ob/"
#   echo "[$(date)] Copied to external drive: ${EXTERNAL_MOUNT}"
# fi

echo "[$(date)] Backup job complete."
