#!/usr/bin/env bash
# ============================================================
#  ZAMBIA POLICE SERVICE — Occurrence Book
#  ufw-setup.sh  |  UFW firewall hardening
#
#  Run as root on the Ubuntu/Debian server:
#    sudo bash ufw-setup.sh
#
#  Allows: SSH (22), HTTP (80), HTTPS (443)
#  Blocks: everything else, including direct access to
#          Node.js on port 3000 from outside the server.
# ============================================================

set -euo pipefail

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ZP OB — UFW Firewall Setup                         ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Confirm before proceeding ────────────────────────────
read -r -p "This will reconfigure the UFW firewall. Continue? [y/N] " CONFIRM
if [[ "${CONFIRM}" != "y" && "${CONFIRM}" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

# ── Ensure UFW is installed ──────────────────────────────
if ! command -v ufw &>/dev/null; then
  echo "[*] Installing ufw..."
  apt-get install -y ufw
fi

# ── Reset to clean state ─────────────────────────────────
echo "[*] Resetting UFW to defaults..."
ufw --force reset

# ── Default policies ─────────────────────────────────────
echo "[*] Setting default policies: deny incoming, allow outgoing..."
ufw default deny incoming
ufw default allow outgoing

# ── Allow SSH (port 22) — do this FIRST to avoid locking yourself out ───────
echo "[*] Allowing SSH (22/tcp)..."
ufw allow 22/tcp comment 'SSH'

# ── Allow HTTP (port 80) — for Let's Encrypt ACME challenge ─────────────────
echo "[*] Allowing HTTP (80/tcp)..."
ufw allow 80/tcp comment 'HTTP (ACME / redirect)'

# ── Allow HTTPS (port 443) ──────────────────────────────────────────────────
echo "[*] Allowing HTTPS (443/tcp)..."
ufw allow 443/tcp comment 'HTTPS'

# ── Block Node.js port 3000 from external access ────────────────────────────
# Node listens on 127.0.0.1:3000. Nginx proxies to it.
# No external rule is added for 3000 — it is blocked by the default deny policy.
echo "[*] Port 3000 (Node.js) blocked externally by default deny policy."

# ── Enable the firewall ──────────────────────────────────
echo "[*] Enabling UFW..."
ufw --force enable

# ── Show status ──────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  UFW Status                                         ║"
echo "╚══════════════════════════════════════════════════════╝"
ufw status verbose

echo ""
echo "✓ Firewall configured. Open ports: 22 (SSH), 80 (HTTP), 443 (HTTPS)."
echo "  Node.js port 3000 is NOT accessible from outside this machine."
