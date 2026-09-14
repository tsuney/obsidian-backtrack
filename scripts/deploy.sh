#!/bin/bash
# ---------------------------------------------------------------------------
# Copy the plugin into an Obsidian vault so you can test it.
#
#   bash scripts/deploy.sh /path/to/vault
#   OBSIDIAN_VAULT=/path/to/vault bash scripts/deploy.sh
#   bash scripts/deploy.sh                 # uses .vault-path, if you made one
#
#   --no-test    skip the unit tests (they run first and stop a broken copy)
#
# To save typing the path every time, put it in a file called .vault-path in
# the root of this repository. That file is not tracked, so your own vault
# name never leaves your machine:
#
#   echo "$HOME/Obsidian/MyVault" > .vault-path
#
# data.json in the destination is never touched, so your settings survive.
# ---------------------------------------------------------------------------

set -euo pipefail

PLUGIN_ID="backtrack"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILES="main.js manifest.json styles.css"

RUN_TESTS=1
VAULT=""
for arg in "$@"; do
  case "$arg" in
    --no-test) RUN_TESTS=0 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) VAULT="$arg" ;;
  esac
done

if [ -z "$VAULT" ] && [ -n "${OBSIDIAN_VAULT:-}" ]; then
  VAULT="$OBSIDIAN_VAULT"
fi
if [ -z "$VAULT" ] && [ -f "$REPO/.vault-path" ]; then
  VAULT="$(head -1 "$REPO/.vault-path" | tr -d '\r')"
fi

if [ -z "$VAULT" ]; then
  echo "No vault given." >&2
  echo "  bash scripts/deploy.sh /path/to/vault" >&2
  echo "  or set OBSIDIAN_VAULT, or write the path into .vault-path" >&2
  exit 1
fi

if [ ! -d "$VAULT/.obsidian" ]; then
  echo "Not an Obsidian vault: $VAULT" >&2
  exit 1
fi

# Run the tests before copying. A red build should never reach the vault, and
# finding out inside Obsidian costs a reload to learn what Node says in a
# second.
if [ "$RUN_TESTS" = "1" ]; then
  if command -v node >/dev/null 2>&1; then
    echo "running tests..."
    if ! (cd "$REPO" && node test.js > /tmp/backtrack-test.log 2>&1); then
      tail -20 /tmp/backtrack-test.log >&2
      echo "---" >&2
      echo "Tests failed. Nothing was copied. Use --no-test to override." >&2
      exit 1
    fi
    tail -1 /tmp/backtrack-test.log
  else
    echo "node not found, skipping tests"
  fi
fi

for f in $FILES; do
  if [ ! -f "$REPO/$f" ]; then
    echo "missing: $f" >&2
    exit 1
  fi
done

DEST="$VAULT/.obsidian/plugins/$PLUGIN_ID"
FIRST_RUN=0
[ -d "$DEST" ] || FIRST_RUN=1

mkdir -p "$DEST"
for f in $FILES; do
  cp "$REPO/$f" "$DEST/$f"
done

VERSION="$(grep -o '"version"[^,]*' "$REPO/manifest.json" | head -1 | sed 's/.*: *"//; s/"//')"
STAMP="$(cksum "$DEST/main.js" | awk '{print $1}')"

echo "---"
echo "Backtrack v${VERSION}  ->  ${DEST}"
echo "main.js checksum ${STAMP}  ($(wc -l < "$DEST/main.js" | tr -d ' ') lines)"
if [ -f "$DEST/data.json" ]; then
  echo "data.json left as it was"
fi
echo ""
if [ "$FIRST_RUN" = "1" ]; then
  echo "First install. In Obsidian:"
  echo "  1. Settings -> Community plugins -> Reload plugins (or restart)"
  echo "  2. Turn Backtrack on"
  echo "  3. Follow a link. The button appears in the bottom right corner."
else
  echo "Updated. In Obsidian, run the command 'Reload app without saving'."
fi
