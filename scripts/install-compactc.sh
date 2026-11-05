#!/usr/bin/env bash
# Installs the pinned Compact toolchain (compactc) WITHOUT the `compact`
# version manager, by downloading the release asset directly.
#
# Why: `compact update` / `compact list` query api.github.com via octocrab,
# which is rate-limited (403) from some networks. The release assets on
# github.com download fine, so we fetch the compiler zip directly.
#
# Usage: ./scripts/install-compactc.sh [version]   (default: 0.31.1)
set -euo pipefail

VERSION="${1:-0.31.1}"
DEST="${COMPACT_VERSIONS_DIR:-$HOME/.compact/versions/$VERSION}"
URL="https://github.com/midnightntwrk/compact/releases/download/compactc-v${VERSION}/compactc_v${VERSION}_x86_64-unknown-linux-musl.zip"

echo "Installing compactc $VERSION -> $DEST"
mkdir -p "$DEST"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -sSL --proto '=https' --tlsv1.2 --max-time 300 "$URL" -o "$tmp/compactc.zip"
unzip -o -q "$tmp/compactc.zip" -d "$DEST"
chmod +x "$DEST/compactc"
"$DEST/compactc" --version
echo "Done. Compile with:"
echo "  $DEST/compactc contract/src/AmplopAuction.compact src/managed/AmplopAuction"
