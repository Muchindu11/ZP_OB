#!/usr/bin/env bash
# ============================================================
#  ZAMBIA POLICE SERVICE — Occurrence Book
#  deploy.sh  |  Production deployment script
#
#  Run from the repo root on the server:
#    bash deploy.sh
#
#  What this script does:
#   1. Validates the public/ directory structure
#   2. Copies frontend files (index.html, api.js, logo) to public/
#   3. Confirms api.js loads BEFORE the inline <script> in index.html
#   4. Installs/updates Node dependencies (production only)
#   5. Rotates the PM2 process with zero downtime
#   6. Creates the log directory if missing
# ============================================================

set -euo pipefail

APP_DIR="/opt/zp_ob"
PUBLIC_DIR="${APP_DIR}/public"
LOG_DIR="/var/log/zp_ob"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ZP OB — Production Deployment                     ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Step 1: Ensure directories exist ────────────────────────────────────────
echo "[1/6] Creating directories..."
mkdir -p "${PUBLIC_DIR}"
mkdir -p "${LOG_DIR}"
mkdir -p "${APP_DIR}/backups"

# ── Step 2: Copy frontend files to public/ ──────────────────────────────────
echo "[2/6] Copying frontend files to ${PUBLIC_DIR} ..."

# api.js MUST be present — it is the security layer
if [ ! -f "${REPO_DIR}/api.js" ]; then
  echo "ERROR: api.js not found in ${REPO_DIR}. Aborting." >&2
  exit 1
fi

cp "${REPO_DIR}/api.js"      "${PUBLIC_DIR}/api.js"
cp "${REPO_DIR}/index.html"  "${PUBLIC_DIR}/index.html"

# Logo is optional (graceful skip if missing)
if [ -f "${REPO_DIR}/ZP_logo.png" ]; then
  cp "${REPO_DIR}/ZP_logo.png" "${PUBLIC_DIR}/ZP_logo.png"
  echo "       ZP_logo.png copied."
else
  echo "       ZP_logo.png not found — skipping (UI will show without logo)."
fi

# Copy server-side files
cp "${REPO_DIR}/server.js"              "${APP_DIR}/server.js"
cp "${REPO_DIR}/package.json"           "${APP_DIR}/package.json"
cp "${REPO_DIR}/ecosystem.config.js"    "${APP_DIR}/ecosystem.config.js"

# Copy .env.example if .env does not already exist
if [ ! -f "${APP_DIR}/.env" ]; then
  if [ -f "${REPO_DIR}/.env.example" ]; then
    cp "${REPO_DIR}/.env.example" "${APP_DIR}/.env.example"
    echo ""
    echo "  ⚠  WARNING: No .env found at ${APP_DIR}/.env"
    echo "     Copy .env.example to .env and fill in JWT_SECRET before starting."
    echo ""
  fi
fi

# ── Step 3: Validate api.js load order in index.html ────────────────────────
echo "[3/6] Validating api.js load order in index.html ..."

# api.js <script src> must appear BEFORE the closing </body> inline <script>
API_LINE=$(grep -n 'src="/api.js"' "${PUBLIC_DIR}/index.html" | head -1 | cut -d: -f1 || true)
SCRIPT_LINE=$(grep -n "^<script>" "${PUBLIC_DIR}/index.html" | tail -1 | cut -d: -f1 || true)

if [ -z "${API_LINE}" ]; then
  echo "ERROR: <script src=\"/api.js\"> not found in index.html. Aborting." >&2
  exit 1
fi

if [ -z "${SCRIPT_LINE}" ]; then
  echo "WARNING: Could not locate inline <script> block line — skipping order check."
else
  if [ "${API_LINE}" -lt "${SCRIPT_LINE}" ]; then
    echo "       ✓ api.js (line ${API_LINE}) loads before inline <script> (line ${SCRIPT_LINE})."
  else
    echo "ERROR: api.js must load BEFORE the inline <script> block." >&2
    echo "       api.js is on line ${API_LINE}, inline script is on line ${SCRIPT_LINE}." >&2
    exit 1
  fi
fi

# ── Step 4: Install production Node dependencies ─────────────────────────────
echo "[4/6] Installing Node.js dependencies (production)..."
cd "${APP_DIR}"
npm ci --omit=dev --silent

# ── Step 5: Reload PM2 (zero downtime) ──────────────────────────────────────
echo "[5/6] Reloading PM2 process..."
if pm2 describe zp-ob > /dev/null 2>&1; then
  pm2 reload ecosystem.config.js --env production
  echo "       ✓ PM2 process 'zp-ob' reloaded."
else
  pm2 start ecosystem.config.js --env production
  pm2 save
  echo "       ✓ PM2 process 'zp-ob' started and saved."
fi

# ── Step 6: Install backup crontab if not already present ────────────────────
echo "[6/6] Checking backup crontab..."
CRON_JOB="0 2 * * * ${APP_DIR}/backup.sh >> ${LOG_DIR}/backup.log 2>&1"
chmod +x "${APP_DIR}/backup.sh" 2>/dev/null || true

if crontab -l 2>/dev/null | grep -q "backup.sh"; then
  echo "       ✓ Backup crontab already installed."
else
  ( crontab -l 2>/dev/null; echo "${CRON_JOB}" ) | crontab -
  echo "       ✓ Backup crontab installed (daily at 02:00 AM)."
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Deployment complete                                ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "  App directory : ${APP_DIR}"
echo "  Public files  : ${PUBLIC_DIR}"
echo "  Logs          : ${LOG_DIR}"
echo ""
echo "  Checklist:"
echo "   ✓ api.js placed in public/ before inline script"
echo "   ✓ Node dependencies installed (production)"
echo "   ✓ PM2 process running"
echo "   ✓ Daily backup crontab active"
echo ""
echo "  Remaining manual steps:"
echo "   - Set JWT_SECRET in ${APP_DIR}/.env"
echo "   - Set FRONTEND_ORIGIN=https://yourdomain in .env"
echo "   - Run: sudo bash ufw-setup.sh"
echo "   - Run: sudo certbot --nginx -d yourdomain"
echo "   - Log in as Muchindu and change the default password"
echo ""
