#!/bin/bash
set -euo pipefail

# Builds the Accounts service as an independent, versioned release archive.
# This never stages the local Ragent control plane, its providers, or a Deb.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${RAGENT_ACCOUNTS_RELEASE_VERSION:-$(node -p "require('$ROOT/package.json').version")+accounts}"
ARCH="${RAGENT_ACCOUNTS_RELEASE_ARCH:-$(dpkg --print-architecture)}"
OUTPUT_DIR="${RAGENT_ACCOUNTS_RELEASE_OUTPUT_DIR:-$ROOT/release}"
NODE_VERSION="${RAGENT_ACCOUNTS_NODE_VERSION:-v24.18.0}"
NODE_CACHE_DIR="${RAGENT_ACCOUNTS_NODE_CACHE_DIR:-$ROOT/cache/node}"
SOURCE_MODE="${RAGENT_ACCOUNTS_SOURCE_MODE:-git-objects}"
if [[ "$SOURCE_MODE" = dev-snapshot ]]; then
  SOURCE_REVISION=''
else
  SOURCE_REVISION="${RAGENT_ACCOUNTS_SOURCE_REVISION:-$(git -C "$ROOT" rev-parse HEAD)}"
fi
if [[ "$SOURCE_MODE" != dev-snapshot && ! "$SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Accounts source revision must be a full 40-character Git commit SHA" >&2
  exit 1
fi

case "$ARCH" in
  amd64) NODE_ARCH=x64 ;;
  arm64) NODE_ARCH=arm64 ;;
  *) echo "Unsupported Accounts release architecture: $ARCH" >&2; exit 1 ;;
esac

mkdir -p "$OUTPUT_DIR" "$NODE_CACHE_DIR"
WORK_DIR="$(mktemp -d "$OUTPUT_DIR/.ragent-accounts-release.XXXXXX")"
export npm_config_cache="${RAGENT_ACCOUNTS_NPM_CACHE:-$WORK_DIR/npm-cache}"
RELEASE_NAME="ragent-accounts-${VERSION}-${ARCH}"
RELEASE_DIR="$WORK_DIR/$RELEASE_NAME"
APP_DIR="$RELEASE_DIR/app"
OUTPUT="$OUTPUT_DIR/${RELEASE_NAME}.tar.gz"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$APP_DIR" "$RELEASE_DIR/runtime"
if [[ "$SOURCE_MODE" = dev-snapshot ]]; then
  SNAPSHOT="${RAGENT_ACCOUNTS_DEV_SNAPSHOT:?Development snapshot archive required}"
  SNAPSHOT_SHA="${RAGENT_ACCOUNTS_DEV_SNAPSHOT_SHA256:?Development snapshot SHA-256 required}"
  [[ "$SNAPSHOT_SHA" =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid development snapshot SHA-256' >&2; exit 1; }
  [ "$(sha256sum "$SNAPSHOT" | awk '{print $1}')" = "$SNAPSHOT_SHA" ] || { echo 'Development snapshot checksum mismatch' >&2; exit 1; }
  mkdir "$WORK_DIR/snapshot"
  python3 - "$SNAPSHOT" "$WORK_DIR/snapshot" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for member in archive.getmembers():
        if not (member.isfile() or member.isdir()) or member.name.startswith('/') or '..' in member.name.split('/'):
            raise SystemExit('Unsafe snapshot member')
    archive.extractall(sys.argv[2], filter='data')
PY
  node "$ROOT/scripts/stage-runtime-payload.mjs" --source "$WORK_DIR/snapshot" --destination "$APP_DIR" --profile accounts --source-mode dev-snapshot --snapshot-sha256 "$SNAPSHOT_SHA"
  SERVICE_SOURCE="$WORK_DIR/snapshot/deploy/accounts/ragent-accounts.service"
  SOURCE_REVISION="dev-snapshot-sha256:$SNAPSHOT_SHA"
else
  node "$ROOT/scripts/stage-runtime-payload.mjs" \
    --source "$ROOT" --destination "$APP_DIR" --profile accounts --source-mode "$SOURCE_MODE"
  actual_source_revision="$(tr -d '\r\n' < "$APP_DIR/.ragent-source-commit")"
  if [[ "$actual_source_revision" != "$SOURCE_REVISION" ]]; then
    echo "Accounts staged source revision differs from the requested release revision" >&2
    exit 1
  fi
  SERVICE_SOURCE="$ROOT/deploy/accounts/ragent-accounts.service"
fi
install -m 0644 "$SERVICE_SOURCE" "$RELEASE_DIR/ragent-accounts.service"

(cd "$APP_DIR" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
node --input-type=module - "$APP_DIR" <<'NODE'
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.argv[2];
const manifest = JSON.parse(await readFile(join(root, 'runtime-payload-manifest.json'), 'utf8'));
for (const file of manifest.files) {
  const content = await readFile(join(root, file.path));
  if (content.length !== file.bytes || createHash('sha256').update(content).digest('hex') !== file.sha256) {
    throw new Error(`Final Accounts payload differs from its manifest: ${file.path}`);
  }
}
NODE

NODE_DIST="node-${NODE_VERSION}-linux-${NODE_ARCH}"
NODE_TARBALL="${NODE_DIST}.tar.xz"
NODE_CACHE_PATH="$NODE_CACHE_DIR/$NODE_TARBALL"
NODE_BASE_URL="https://nodejs.org/dist/${NODE_VERSION}"
if [ ! -f "$NODE_CACHE_PATH" ]; then
  curl -fsSL --retry 3 --connect-timeout 15 "$NODE_BASE_URL/$NODE_TARBALL" -o "$NODE_CACHE_PATH"
fi
curl -fsSL --retry 3 --connect-timeout 15 "$NODE_BASE_URL/SHASUMS256.txt" -o "$WORK_DIR/SHASUMS256.txt"
EXPECTED_SHA="$(awk -v name="$NODE_TARBALL" '{ filename = $2; sub(/^\*/, "", filename); sub(/\r$/, "", filename); if (filename == name) print $1 }' "$WORK_DIR/SHASUMS256.txt")"
ACTUAL_SHA="$(cd "$NODE_CACHE_DIR" && sha256sum "$NODE_TARBALL" | awk '{ print $1 }')"
[ -n "$EXPECTED_SHA" ] && [ "$EXPECTED_SHA" = "$ACTUAL_SHA" ] || {
  echo "Accounts Node runtime checksum mismatch" >&2
  exit 1
}
tar -xJf "$NODE_CACHE_PATH" -C "$WORK_DIR"
install -m 0755 "$WORK_DIR/$NODE_DIST/bin/node" "$RELEASE_DIR/runtime/node"

cat > "$RELEASE_DIR/release.json" <<EOF
{"service":"ragent-accounts","version":"$VERSION","architecture":"$ARCH","nodeVersion":"$NODE_VERSION","sourceRevision":"$SOURCE_REVISION"}
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
