#!/usr/bin/env bash
# Job Search Email Sync — one-time setup
# Run from the repo root:  bash scripts/setup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "======================================"
echo "  Job Search Email Sync — Setup"
echo "======================================"
echo ""

# ── Prerequisites ──────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js >=18 is required. Get it at https://nodejs.org/"
  exit 1
fi
NODE_VER=$(node -e "process.stdout.write(process.versions.node)")
MAJOR=${NODE_VER%%.*}
if [[ $MAJOR -lt 18 ]]; then
  echo "ERROR: Node.js 18+ required (found $NODE_VER). Update at https://nodejs.org/"
  exit 1
fi

# ── npm install ───────────────────────────────────────────────────────────────
echo "Installing MCP server dependencies (mail-mcp/)…"
(cd "$PROJECT_DIR/mail-mcp" && npm install --omit=dev)

echo "Installing sync script dependencies (scripts/)…"
(cd "$PROJECT_DIR/scripts" && npm install --omit=dev)

# ── config.json ───────────────────────────────────────────────────────────────
if [[ ! -f "$SCRIPT_DIR/config.json" ]]; then
  cp "$SCRIPT_DIR/config.example.json" "$SCRIPT_DIR/config.json"
  echo ""
  echo "Created scripts/config.json — please edit it:"
  echo "  • apiUrl  → paste your Google Apps Script Web App URL"
  echo "  • mailbox → name of the mailbox to watch (default: INBOX)"
  echo "  • daysBack→ how many days back to look (default: 14)"
  echo "  • anthropicApiKey → your key, or leave blank and export ANTHROPIC_API_KEY"
  echo ""
fi

# ── manual test ───────────────────────────────────────────────────────────────
echo "--------------------------------------"
echo "You can test the sync now:"
echo "  ANTHROPIC_API_KEY=sk-... node scripts/sync-emails.js"
echo "--------------------------------------"
echo ""

# ── LaunchAgent (auto-sync every 10 min) ─────────────────────────────────────
read -r -p "Install LaunchAgent for automatic sync every 10 minutes? [y/N] " REPLY
echo ""
if [[ "$REPLY" =~ ^[Yy]$ ]]; then
  NODE_BIN="$(command -v node)"
  PLIST_SRC="$PROJECT_DIR/launchagent/com.jobsearch.mail-sync.plist"
  PLIST_DST="$HOME/Library/LaunchAgents/com.jobsearch.mail-sync.plist"

  read -r -s -p "Enter your ANTHROPIC_API_KEY (input hidden): " API_KEY
  echo ""

  mkdir -p "$HOME/Library/LaunchAgents"
  sed \
    -e "s|PLACEHOLDER_NODE|${NODE_BIN}|g" \
    -e "s|PLACEHOLDER_PROJECT_PATH|${PROJECT_DIR}|g" \
    -e "s|PLACEHOLDER_API_KEY|${API_KEY}|g" \
    "$PLIST_SRC" > "$PLIST_DST"

  # Unload any previous version first
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  launchctl load   "$PLIST_DST"

  echo "LaunchAgent installed and started."
  echo "  Logs : tail -f /tmp/job-search-sync.log"
  echo "  Errors: tail -f /tmp/job-search-sync.error.log"
  echo "  Stop : launchctl unload ~/Library/LaunchAgents/com.jobsearch.mail-sync.plist"
fi

echo ""
echo "======================================"
echo "  Setup complete!"
echo "======================================"
echo ""
echo "Next steps:"
echo "  1. Edit scripts/config.json with your Google Apps Script URL"
echo "  2. Run once manually to confirm everything works:"
echo "       ANTHROPIC_API_KEY=sk-... node scripts/sync-emails.js"
echo "  3. Open the tracker in your browser and hit Refresh"
echo ""
echo "Claude Code MCP:"
echo "  .claude/settings.json is already configured — restart Claude Code"
echo "  and use tools like 'list_emails' or 'search_emails' interactively."
