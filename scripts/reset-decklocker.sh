#!/usr/bin/env bash
# Wipes Deck Locker's saved settings (your lock credential — PIN, password, pattern,
# or Knock Code — and every lock/customization choice) back to a clean install — the
# recovery path for a forgotten credential. Run this from Desktop Mode in an actual
# terminal (Konsole, or SSH into the Deck): doing so requires filesystem and sudo
# access that Game Mode doesn't hand you, which is what actually restricts this to
# Desktop Mode, not anything in the plugin itself.
#
# Usage: ./reset-decklocker.sh
set -euo pipefail

SETTINGS_DIR="$HOME/homebrew/settings/DeckLocker"
SETTINGS_FILE="$SETTINGS_DIR/settings.json"

if [ ! -f "$SETTINGS_FILE" ]; then
  echo "No Deck Locker settings found at $SETTINGS_FILE — nothing to reset."
  exit 0
fi

echo "This will erase your Deck Locker lock credential and every lock/customization setting."
echo "A backup of the current settings will be kept alongside it."
read -r -p "Continue? [y/N] " confirm
case "$confirm" in
  [yY]|[yY][eE][sS]) ;;
  *) echo "Cancelled."; exit 1 ;;
esac

backup="$SETTINGS_FILE.bak.$(date +%Y%m%d%H%M%S)"
cp "$SETTINGS_FILE" "$backup"
echo "Backed up existing settings to $backup"

rm "$SETTINGS_FILE"
echo "Deck Locker settings reset. It will start fresh (lock disabled, no credential set) the next time it loads."

if command -v systemctl >/dev/null 2>&1; then
  read -r -p "Restart the Decky plugin loader now so this takes effect immediately? [y/N] " restart
  case "$restart" in
    [yY]|[yY][eE][sS])
      sudo systemctl restart plugin_loader
      echo "plugin_loader restarted."
      ;;
    *)
      echo "Skipped — the reset will take effect next time Steam or the plugin loader restarts."
      ;;
  esac
fi
