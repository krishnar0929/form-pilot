#!/bin/bash
# Saves your Anthropic API key into config.local.js (git-ignored) for local testing,
# verifies it, and opens Chrome's extensions page ready to load FormPilot.
# Usage:  ./scripts/set-key.sh          (copy your key to the clipboard first, or paste when asked)
set -euo pipefail

cd "$(dirname "$0")/.."
DIR="$(pwd)"

CLIP="$(pbpaste 2>/dev/null | tr -d '[:space:]' || true)"
if [[ "$CLIP" == sk-ant-* ]]; then
  KEY="$CLIP"
  echo "✔ Using the API key from your clipboard."
else
  read -rsp "Paste your Anthropic API key (input hidden), then press Enter: " KEY
  echo
  KEY="$(echo "$KEY" | tr -d '[:space:]')"
fi

if [[ "$KEY" != sk-ant-* ]]; then
  echo "✘ That doesn't look like an Anthropic key (should start with sk-ant-)." >&2
  exit 1
fi

echo "… Checking the key with api.anthropic.com"
CODE="$(curl -s -o /dev/null -w '%{http_code}' https://api.anthropic.com/v1/models \
  -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" || echo 000)"
case "$CODE" in
  200) echo "✔ Key works." ;;
  401) echo "✘ The API rejected this key (401). Check it at console.anthropic.com." >&2; exit 1 ;;
  000) echo "! Couldn't reach the API (offline?). Saving anyway." ;;
  *)   echo "! API returned HTTP $CODE. Saving anyway." ;;
esac

MODE="${FORMPILOT_MODE:-judge}"
cat > config.local.js <<EOF
// TEMPORARY local test config — git-ignored, never commit. Created by scripts/set-key.sh
window.FORMPILOT_CONFIG = {
  apiKey: '$KEY',
  model: 'claude-sonnet-5-5',
  mode: '$MODE',
  profile: '',
  autofill: true,
};
EOF
chmod 600 config.local.js
echo "✔ Saved config.local.js (git-ignored)."

if git check-ignore -q config.local.js; then
  echo "✔ Confirmed git will not commit it."
else
  echo "! WARNING: config.local.js is NOT git-ignored. Add it to .gitignore before committing." >&2
fi

VERSION="$(grep '"version"' manifest.json | sed -E 's/.*"([0-9.]+)".*/\1/')"
printf '%s' "$DIR" | pbcopy
open -a "Google Chrome" "chrome://extensions" 2>/dev/null || true

cat <<EOF

Next, in Chrome (the extensions page just opened):
  1. If FormPilot is already listed, click Remove on it.
  2. Click "Load unpacked". In the folder picker press Cmd+Shift+G,
     press Cmd+V (the path is on your clipboard), Enter, then "Select".
       $DIR
  3. Check the FormPilot card shows version $VERSION.
  4. Close and reopen the FormPilot side panel — the key is already filled in.

Already loaded from this folder? Just click the reload ↻ icon on the card instead.
EOF
