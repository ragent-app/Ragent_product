#!/bin/bash
set -euo pipefail

# Builds the Accounts service as an independent, versioned release archive.
# This never stages the local AgentoC control plane, its providers, or a Deb.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${AGENTOC_ACCOUNTS_RELEASE_VERSION:-$(node -p "require('$ROOT/package.json').version")+accounts}"
ARCH="${AGENTOC_ACCOUNTS_RELEASE_ARCH:-$(dpkg --print-architecture)}"
OUTPUT_DIR="${AGENTOC_ACCOUNTS_RELEASE_OUTPUT_DIR:-$ROOT/release}"
NODE_VERSION="${AGENTOC_ACCOUNTS_NODE_VERSION:-v24.18.0}"
NODE_CACHE_DIR="${AGENTOC_ACCOUNTS_NODE_CACHE_DIR:-$ROOT/cache/node}"
SOURCE_REVISION="${AGENTOC_ACCOUNTS_SOURCE_REVISION:-$(git -C "$ROOT" rev-parse HEAD)}"
SOURCE_MODE="${AGENTOC_ACCOUNTS_SOURCE_MODE:-git-objects}"
if [[ ! "$SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Accounts source revision must be a full 40-character Git commit SHA" >&2
  exit 1
fi

case "$ARCH" in
  amd64) NODE_ARCH=x64 ;;
  arm64) NODE_ARCH=arm64 ;;
  *) echo "Unsupported Accounts release architecture: $ARCH" >&2; exit 1 ;;
esac

mkdir -p "$OUTPUT_DIR" "$NODE_CACHE_DIR"
WORK_DIR="$(mktemp -d "$OUTPUT_DIR/.agentoc-accounts-release.XXXXXX")"
export npm_config_cache="${AGENTOC_ACCOUNTS_NPM_CACHE:-$WORK_DIR/npm-cache}"
RELEASE_NAME="agentoc-accounts-${VERSION}-${ARCH}"
RELEASE_DIR="$WORK_DIR/$RELEASE_NAME"
APP_DIR="$RELEASE_DIR/app"
OUTPUT="$OUTPUT_DIR/${RELEASE_NAME}.tar.gz"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$APP_DIR" "$RELEASE_DIR/runtime"
node "$ROOT/scripts/stage-runtime-payload.mjs" \
  --source "$ROOT" --destination "$APP_DIR" --profile accounts --source-mode "$SOURCE_MODE"
install -m 0644 "$ROOT/deploy/accounts/agentoc-accounts.service" "$RELEASE_DIR/agentoc-accounts.service"

(cd "$APP_DIR" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
rm -f "$APP_DIR/package-lock.json"

NODE_DIST="node-${NODE_VERSION}-linux-${NODE_ARCH}"
NODE_TARBALL="${NODE_DIST}.tar.xz"
NODE_CACHE_PATH="$NODE_CACHE_DIR/$NODE_TARBALL"
NODE_BASE_URL="https://nodejs.org/dist/${NODE_VERSION}"
if [ ! -f "$NODE_CACHE_PATH" ]; then
  curl -fsSL --retry 3 --connect-timeout 15 "$NODE_BASE_URL/$NODE_TARBALL" -o "$NODE_CACHE_PATH"
fi
curl -fsSL --retry 3 --connect-timeout 15 "$NODE_BASE_URL/SHASUMS256.txt" -o "$WORK_DIR/SHASUMS256.txt"
EXPECTED_SHA="$(awk -v name="$NODE_TARBALL" '$2 == name { print $1 }' "$WORK_DIR/SHASUMS256.txt")"
ACTUAL_SHA="$(sha256sum "$NODE_CACHE_PATH" | awk '{ print $1 }')"
[ -n "$EXPECTED_SHA" ] && [ "$EXPECTED_SHA" = "$ACTUAL_SHA" ] || {
  echo "Accounts Node runtime checksum mismatch" >&2
  exit 1
}
tar -xJf "$NODE_CACHE_PATH" -C "$WORK_DIR"
install -m 0755 "$WORK_DIR/$NODE_DIST/bin/node" "$RELEASE_DIR/runtime/node"

cat > "$RELEASE_DIR/release.json" <<EOF
{"service":"agentoc-accounts","version":"$VERSION","architecture":"$ARCH","nodeVersion":"$NODE_VERSION","sourceRevision":"$SOURCE_REVISION"}
EOF

chmod -R a+rX "$RELEASE_DIR"
node "$ROOT/scripts/verify-runtime-payload.mjs" "$RELEASE_DIR"
# Git Bash on Windows/NTFS reports archived file modes as non-executable even
# after chmod. Archive the tree, then append the Linux runtime with an explicit
# executable mode so systemd can start it after extraction on ARM64 hosts.
tar -C "$WORK_DIR" --exclude="$RELEASE_NAME/runtime/node" -cf "$WORK_DIR/release.tar" "$RELEASE_NAME"
tar -C "$WORK_DIR" --mode=0755 -rf "$WORK_DIR/release.tar" "$RELEASE_NAME/runtime/node"
gzip -n -c "$WORK_DIR/release.tar" > "$OUTPUT"
printf '%s\n' "$OUTPUT"
