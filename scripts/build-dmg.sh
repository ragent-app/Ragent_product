#!/bin/bash
set -euo pipefail

# Build the Ragent macOS DMG: a self-contained .app with a bundled Node
# runtime, production node_modules, the darwin P2P host sidecar, and bundled
# codex/claude provider engines. Mirrors scripts/build-deb.sh: the installer
# never depends on a system Node, npm, or Go at install time.
#
# Env overrides:
#   AGENTOC_DMG_OUTPUT_DIR    output directory (default: <repo>/release)
#   AGENTOC_PACKAGE_VERSION   manual version override
#   AGENTOC_NODE_VERSION      bundled Node version (default: v24.12.0)
#   AGENTOC_NODE_CACHE_DIR    Node tarball cache (default: ~/.cache/agentoc-build)
#   AGENTOC_NPM_REGISTRY      npm registry (default: https://registry.npmjs.org)
#   AGENTOC_CODEX_VERSION     codex version (default: adapter catalog target)
#   AGENTOC_CLAUDE_VERSION    claude code version (default: adapter catalog target)
#   AGENTOC_P2P_HOST_BINARY   prebuilt darwin sidecar (requires SHA-256 below)
#   AGENTOC_P2P_HOST_SHA256   expected lowercase SHA-256 for the prebuilt sidecar
#   AGENTOC_MAC_SIGN_IDENTITY Developer ID Application signing identity
#   AGENTOC_MAC_NOTARY_PROFILE notarytool keychain profile (submits to Apple)
#   AGENTOC_SOURCE_GIT_DIR    bare Git object store for a frozen source build
#   AGENTOC_SOURCE_COMMIT     expected full commit ID (required with the above)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-dmg.sh must run on macOS (codesign/hdiutil/iconutil are required)" >&2
  exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
  arm64)
    NODE_ARCH=arm64
    P2P_GOARCH=arm64
    CODEX_NATIVE_PACKAGE='@openai/codex-darwin-arm64'
    CODEX_NATIVE_TARGET='darwin-arm64'
    CLAUDE_NATIVE_PACKAGE='@anthropic-ai/claude-code-darwin-arm64'
    ;;
  x86_64)
    NODE_ARCH=x64
      P2P_GOARCH=amd64
    CODEX_NATIVE_PACKAGE='@openai/codex-darwin-x64'
    CODEX_NATIVE_TARGET='darwin-x64'
    CLAUDE_NATIVE_PACKAGE='@anthropic-ai/claude-code-darwin-x64'
    ;;
  *)
    echo "Unsupported macOS architecture: $ARCH" >&2
    exit 1
    ;;
esac

OUTPUT_DIR="${AGENTOC_DMG_OUTPUT_DIR:-$ROOT/release}"
NODE_VERSION="${AGENTOC_NODE_VERSION:-v24.12.0}"
[[ "$NODE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ -s "$ROOT/third_party_licenses/node/${NODE_VERSION}-LICENSE.txt" ] || {
  echo 'Bundled Node version requires its matching third-party license notice.' >&2
  exit 1
}
NODE_CACHE_DIR="${AGENTOC_NODE_CACHE_DIR:-$HOME/.cache/agentoc-build/node}"
NPM_REGISTRY="${AGENTOC_NPM_REGISTRY:-https://registry.npmjs.org}"
SIGN_IDENTITY="${AGENTOC_MAC_SIGN_IDENTITY:-}"
NOTARY_PROFILE="${AGENTOC_MAC_NOTARY_PROFILE:-}"
if [ -n "$NOTARY_PROFILE" ]; then
  [ -n "$SIGN_IDENTITY" ] || { echo 'Notarization requires a Developer ID signing identity.' >&2; exit 1; }
  [[ "$NOTARY_PROFILE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo 'Invalid notarytool keychain profile name.' >&2; exit 1; }
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentoc-dmg.XXXXXX")"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

SOURCE_GIT_DIR="${AGENTOC_SOURCE_GIT_DIR:-}"
if [ -n "$SOURCE_GIT_DIR" ]; then
  SOURCE_GIT_DIR="$(cd "$SOURCE_GIT_DIR" && pwd -P)"
  export GIT_NO_REPLACE_OBJECTS=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
  [ ! -e "$SOURCE_GIT_DIR/objects/info/alternates" ] &&
    [ ! -e "$SOURCE_GIT_DIR/objects/info/http-alternates" ] || {
      echo 'Frozen source Git directory must not use alternate object stores.' >&2; exit 1;
    }
  [ -n "${AGENTOC_DMG_OUTPUT_DIR:-}" ] || {
    echo 'Frozen source builds require an explicit output directory.' >&2; exit 1;
  }
  [ "$(git -C "$SOURCE_GIT_DIR" rev-parse --is-bare-repository)" = true ] || {
    echo 'Frozen source Git directory must be bare.' >&2; exit 1;
  }
  SOURCE_COMMIT="${AGENTOC_SOURCE_COMMIT:-}"
  [[ "$SOURCE_COMMIT" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ ]] &&
    [ "$(git -C "$SOURCE_GIT_DIR" rev-parse --verify HEAD)" = "$SOURCE_COMMIT" ] || {
      echo 'Frozen source requires the expected full commit ID at bare HEAD.' >&2; exit 1;
    }
  # Bootstrap the frozen staging code only after comparing its exact bytes
  # against the specified commit. The object store has no working checkout.
  for input in scripts/build-dmg.sh scripts/stage-runtime-payload.mjs scripts/verify-runtime-payload.mjs; do
    git -C "$SOURCE_GIT_DIR" show "$SOURCE_COMMIT:$input" > "$WORK_DIR/bootstrap-input" || exit 1
    cmp -s "$ROOT/$input" "$WORK_DIR/bootstrap-input" || {
      echo "Frozen source bootstrap differs from the specified commit: $input" >&2; exit 1;
    }
  done
  node "$ROOT/scripts/stage-runtime-payload.mjs" --source "$SOURCE_GIT_DIR" \
    --destination "$WORK_DIR/frozen-source" --profile desktop --source-mode git-objects
  ROOT="$WORK_DIR/frozen-source"
  [ "$(cat "$ROOT/.agentoc-source-commit")" = "$SOURCE_COMMIT" ] || {
    echo 'Frozen source staging returned a different commit.' >&2; exit 1;
  }
  [ -s "$ROOT/third_party_licenses/node/${NODE_VERSION}-LICENSE.txt" ] || {
    echo 'The frozen commit does not contain the bundled Node license.' >&2; exit 1;
  }
  FROZEN_MANIFEST_SHA="$(shasum -a 256 "$ROOT/runtime-payload-manifest.json" | awk '{print $1}')"
else
  SOURCE_COMMIT="$(git -C "$ROOT" rev-parse --verify HEAD)"
fi
[[ "$SOURCE_COMMIT" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ ]] || {
  echo 'A full committed source identity is required for macOS packaging.' >&2; exit 1;
}
if [ -z "$SOURCE_GIT_DIR" ]; then
  SOURCE_STATUS="$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)" || {
    echo 'Unable to verify macOS source tree status.' >&2; exit 1;
  }
  [ -z "$SOURCE_STATUS" ] || {
    echo 'macOS packaging requires a clean committed source tree.' >&2; exit 1;
  }
fi
SOURCE_SHORT="${SOURCE_COMMIT:0:8}"
PKG_VERSION="$(node -p "require('$ROOT/package.json').version")"
assert_source_unchanged() {
  local current status
  if [ -n "$SOURCE_GIT_DIR" ]; then
    current="$(git -C "$SOURCE_GIT_DIR" rev-parse --verify HEAD)" || exit 1
    [ "$current" = "$SOURCE_COMMIT" ] &&
      [ "$(cat "$ROOT/.agentoc-source-commit")" = "$SOURCE_COMMIT" ] &&
      [ "$(shasum -a 256 "$ROOT/runtime-payload-manifest.json" | awk '{print $1}')" = "$FROZEN_MANIFEST_SHA" ] || {
        echo 'Frozen source identity changed during macOS packaging.' >&2; exit 1;
      }
    node --input-type=module - "$ROOT" <<'NODE'
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
const manifest = JSON.parse(readFileSync(join(root, 'runtime-payload-manifest.json'), 'utf8'));
const expected = new Map(manifest.files.map(({ path, sha256 }) => [path, sha256]));
const found = new Set();
function walk(dir, prefix = '') {
  for (const name of readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const file = join(dir, name);
    const st = lstatSync(file);
    if (st.isSymbolicLink()) throw new Error(`Frozen source contains a symlink: ${rel}`);
    if (st.isDirectory()) { walk(file, rel); continue; }
    if (!st.isFile()) throw new Error(`Frozen source contains a non-file: ${rel}`);
    if (!prefix && ['.agentoc-source-commit', 'runtime-payload-manifest.json'].includes(name)) continue;
    if (!expected.has(rel) || createHash('sha256').update(readFileSync(file)).digest('hex') !== expected.get(rel)) {
      throw new Error(`Frozen source changed: ${rel}`);
    }
    found.add(rel);
  }
}
walk(root);
if (found.size !== expected.size) throw new Error('Frozen source is incomplete');
NODE
    return
  fi
  current="$(git -C "$ROOT" rev-parse --verify HEAD)" || {
    echo 'Unable to verify macOS source commit.' >&2; exit 1;
  }
  status="$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)" || {
    echo 'Unable to verify macOS source tree status.' >&2; exit 1;
  }
  [ "$current" = "$SOURCE_COMMIT" ] && [ -z "$status" ] || {
      echo 'Source changed during macOS packaging; refusing to publish the candidate.' >&2; exit 1;
    }
}
if [ -n "${AGENTOC_PACKAGE_VERSION:-}" ]; then
  VERSION="$AGENTOC_PACKAGE_VERSION"
else
  VERSION="$PKG_VERSION+main.$SOURCE_SHORT.$(date +%Y%m%d%H%M)"
fi
BUNDLE_VERSION="${VERSION%%+*}"
[[ "$BUNDLE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo 'macOS bundle version must have three numeric components.' >&2
  exit 1
}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(\+main\.[a-f0-9]{8}\.[0-9]{12})?$ ]] || {
  echo 'Invalid macOS package version.' >&2
  exit 1
}

resolve_npm_version() {
  local package_name="$1"
  local configured_version="$2"
  if [ -n "$configured_version" ]; then
    printf '%s\n' "$configured_version"
    return
  fi
  npm view "$package_name" version --registry="$NPM_REGISTRY" | tr -d '[:space:]'
}

verify_npm_sri() {
  local archive_path="$1"
  local integrity="$2"
  local label="$3"
  node -e '
    const { createHash } = require("crypto");
    const { readFileSync } = require("fs");
    const [archivePath, integrity, label] = process.argv.slice(1);
    const entry = integrity.split(/\s+/).find((value) => value.startsWith("sha512-"));
    if (!entry) {
      throw new Error(`${label}: registry metadata does not include a sha512 SRI digest`);
    }
    const expected = entry.slice("sha512-".length);
    const actual = createHash("sha512").update(readFileSync(archivePath)).digest("base64");
    if (actual !== expected) {
      throw new Error(`${label}: npm tarball SRI mismatch`);
    }
  ' "$archive_path" "$integrity" "$label"
}

download_npm_package() {
  local package_spec="$1"
  local cache_path="$2"
  local label="$3"
  local tarball_url integrity
  tarball_url="$(npm view "$package_spec" dist.tarball --registry="$NPM_REGISTRY" | tr -d '[:space:]')"
  integrity="$(npm view "$package_spec" dist.integrity --registry="$NPM_REGISTRY" | tr -d '[:space:]')"
  [ -n "$tarball_url" ] || { echo "$label: registry returned no tarball URL" >&2; exit 1; }
  [ -n "$integrity" ] || { echo "$label: registry returned no integrity digest" >&2; exit 1; }
  if [ ! -f "$cache_path" ]; then
    mkdir -p "$(dirname "$cache_path")"
    curl -fsSL --retry 3 --connect-timeout 15 "$tarball_url" -o "$cache_path"
  fi
  verify_npm_sri "$cache_path" "$integrity" "$label"
}

# Provider runtimes must ship as matched launcher/native pairs. Codex is
# pinned to the adapter catalog target so the shipped engine stays inside the
# validated compatibility range; an explicit override is verified against the
# same range.
CODEX_ADAPTER_TARGET_VERSION="$(node --input-type=module -e \
  'import(process.argv[1]).then((m) => process.stdout.write(m.CODEX_HARNESS_VERSION_CONTRACT.targetVersion))' \
  "$ROOT/lib/harness-version-catalog.mjs")"
CODEX_VERSION="$(resolve_npm_version '@openai/codex' "${AGENTOC_CODEX_VERSION:-$CODEX_ADAPTER_TARGET_VERSION}")"
CLAUDE_ADAPTER_TARGET_VERSION="$(node --input-type=module -e \
  'import(process.argv[1]).then((m) => process.stdout.write(m.HARNESS_VERSION_CONTRACTS.claude.targetVersion))' \
  "$ROOT/lib/harness-version-catalog.mjs")"
CLAUDE_VERSION="$(resolve_npm_version '@anthropic-ai/claude-code' "${AGENTOC_CLAUDE_VERSION:-$CLAUDE_ADAPTER_TARGET_VERSION}")"
case "$CODEX_VERSION" in
  *[!0-9.]*|'') echo "Invalid Codex version from registry: '$CODEX_VERSION'" >&2; exit 1 ;;
esac
if [ "$CODEX_VERSION" != "$CODEX_ADAPTER_TARGET_VERSION" ]; then
  CODEX_ADAPTER_COMPATIBLE="$(node --input-type=module -e \
    'import(process.argv[1]).then((m) => process.stdout.write(m.isAdapterCompatible("codex", process.argv[2]) ? "yes" : "no"))' \
    "$ROOT/chat/harness-compatibility.mjs" "$CODEX_VERSION")"
  if [ "$CODEX_ADAPTER_COMPATIBLE" != "yes" ]; then
    echo "Codex $CODEX_VERSION is outside the validated Ragent adapter range (target $CODEX_ADAPTER_TARGET_VERSION)." >&2
    exit 1
  fi
fi
CLAUDE_ADAPTER_COMPATIBLE="$(node --input-type=module -e \
  'import(process.argv[1]).then((m) => process.stdout.write(m.isAdapterCompatible("claude", process.argv[2]) ? "yes" : "no"))' \
  "$ROOT/chat/harness-compatibility.mjs" "$CLAUDE_VERSION")"
if [ "$CLAUDE_ADAPTER_COMPATIBLE" != "yes" ]; then
  echo "Claude Code $CLAUDE_VERSION is outside the validated Ragent adapter range." >&2
  exit 1
fi
printf 'Building Ragent %s (darwin/%s) with Codex %s and Claude Code %s\n' \
  "$VERSION" "$ARCH" "$CODEX_VERSION" "$CLAUDE_VERSION"

STAGE="$WORK_DIR/stage"
CONTENTS="$STAGE/Ragent.app/Contents"
APP_DIR="$CONTENTS/Resources/app"
OUTPUT_NAME="ragent_${VERSION}-darwin-${ARCH}.dmg"
FINAL_OUTPUT="$OUTPUT_DIR/$OUTPUT_NAME"
DMG_PATH="$WORK_DIR/$OUTPUT_NAME"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources" "$APP_DIR" "$OUTPUT_DIR"

# ── 1. Application files from the shared committed runtime allowlist ────────
if [ -n "$SOURCE_GIT_DIR" ]; then
  node "$ROOT/scripts/stage-runtime-payload.mjs" \
    --source "$SOURCE_GIT_DIR" --destination "$APP_DIR" --profile desktop --source-mode git-objects
else
  node "$ROOT/scripts/stage-runtime-payload.mjs" \
    --source "$ROOT" --destination "$APP_DIR" --profile desktop
fi
[ "$(cat "$APP_DIR/.agentoc-source-commit")" = "$SOURCE_COMMIT" ] || {
  echo 'Staged source does not match the requested commit.' >&2; exit 1;
}
# Keep the explicit version so frontend asset URLs change per packaged build.
printf '%s\n' "$VERSION" > "$APP_DIR/.agentoc-package-version"
# The vendored Codex launcher is assembled from verified downloads below.
rm -rf "$APP_DIR/vendor"

# ── 2. Production dependencies ────────────────────────────────────────────────
PROD_DIRECT_DEPENDENCY_LIST="$WORK_DIR/prod-direct-dependencies.txt"
[ -f "$ROOT/package-lock.json" ] || { echo "Missing package-lock.json; cannot stage reproducible production dependencies" >&2; exit 1; }
node -e "const pkg=require('$ROOT/package.json'); for (const name of Object.keys(pkg.dependencies || {})) console.log(name)" > "$PROD_DIRECT_DEPENDENCY_LIST"
install -m 0644 "$ROOT/package-lock.json" "$APP_DIR/package-lock.json"
(cd "$APP_DIR" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
rm -f "$APP_DIR/package-lock.json"
while IFS= read -r package_name; do
  [ -n "$package_name" ] || continue
  if [ ! -f "$APP_DIR/node_modules/$package_name/package.json" ]; then
    echo "Missing staged production dependency: $package_name" >&2
    exit 1
  fi
done < "$PROD_DIRECT_DEPENDENCY_LIST"

# Embed the pinned cross-platform manager inside the main application bundle.
DESKTOP_BUILD="$WORK_DIR/desktop-build"
mkdir -p "$DESKTOP_BUILD"
install -m 0644 "$ROOT/desktop/package.json" "$ROOT/desktop/package-lock.json" "$DESKTOP_BUILD/"
(cd "$DESKTOP_BUILD" && ELECTRON_CACHE="${ELECTRON_CACHE:-$NODE_CACHE_DIR/electron}" npm ci --no-audit --no-fund)
(cd "$DESKTOP_BUILD" && ELECTRON_CACHE="${ELECTRON_CACHE:-$NODE_CACHE_DIR/electron}" node node_modules/electron/install.js)
MANAGER="$CONTENTS/Resources/Ragent.app"
cp -R "$DESKTOP_BUILD/node_modules/electron/dist/Electron.app" "$MANAGER"
MANAGER_APP="$MANAGER/Contents/Resources/app"
mkdir -p "$MANAGER_APP/assets"
for name in main.cjs preload.cjs update-check.cjs wait.html; do
  install -m 0644 "$ROOT/desktop/$name" "$MANAGER_APP/$name"
done
install -m 0644 "$ROOT/static/desktop/agentoc-android-logo.png" "$MANAGER_APP/assets/agentoc-android-logo.png"
install -m 0644 "$ROOT/static/icon-512.png" "$MANAGER_APP/assets/ragent-icon.png"
install -m 0644 "$ROOT/static/desktop/ragent-trayTemplate.png" "$MANAGER_APP/assets/ragent-trayTemplate.png"
install -m 0644 "$ROOT/static/desktop/ragent-trayTemplate@2x.png" "$MANAGER_APP/assets/ragent-trayTemplate@2x.png"
DESKTOP_VERSION="$(node -p "require('$ROOT/desktop/package.json').version")"
printf '{"name":"ragent-desktop-manager","productName":"Ragent","version":"%s","private":true,"main":"main.cjs"}\n' "$DESKTOP_VERSION" > "$MANAGER_APP/package.json"
plutil -replace CFBundleIdentifier -string cloud.agenton.ragent.manager "$MANAGER/Contents/Info.plist"
plutil -replace CFBundleName -string Ragent "$MANAGER/Contents/Info.plist"
plutil -replace CFBundleDisplayName -string Ragent "$MANAGER/Contents/Info.plist" 2>/dev/null || plutil -insert CFBundleDisplayName -string Ragent "$MANAGER/Contents/Info.plist"

# ── 3. Bundled Node runtime ──────────────────────────────────────────────────
NODE_DIST="node-${NODE_VERSION}-darwin-${NODE_ARCH}"
NODE_TARBALL="${NODE_DIST}.tar.gz"
NODE_BASE_URL="https://nodejs.org/dist/${NODE_VERSION}"
mkdir -p "$NODE_CACHE_DIR"
if [ ! -f "$NODE_CACHE_DIR/$NODE_TARBALL" ]; then
  curl -fsSL --retry 3 --connect-timeout 15 "$NODE_BASE_URL/$NODE_TARBALL" -o "$NODE_CACHE_DIR/$NODE_TARBALL"
fi
curl -fsSL --retry 3 --connect-timeout 15 "$NODE_BASE_URL/SHASUMS256.txt" -o "$WORK_DIR/SHASUMS256.txt"
EXPECTED_SHA="$(awk -v name="$NODE_TARBALL" '$2 == name { print $1 }' "$WORK_DIR/SHASUMS256.txt")"
[ -n "$EXPECTED_SHA" ] || { echo "Missing Node checksum for $NODE_TARBALL" >&2; exit 1; }
ACTUAL_SHA="$(shasum -a 256 "$NODE_CACHE_DIR/$NODE_TARBALL" | awk '{ print $1 }')"
[ "$EXPECTED_SHA" = "$ACTUAL_SHA" ] || { echo "Node runtime checksum mismatch" >&2; exit 1; }
mkdir -p "$CONTENTS/Resources/runtime"
tar -xzf "$NODE_CACHE_DIR/$NODE_TARBALL" -C "$WORK_DIR"
install -m 0755 "$WORK_DIR/$NODE_DIST/bin/node" "$CONTENTS/Resources/runtime/node"
bash "$ROOT/scripts/stage-posix-node-toolchain.sh" "$WORK_DIR/$NODE_DIST" "$CONTENTS/Resources/runtime"
lipo -verify_arch "$ARCH" "$CONTENTS/Resources/runtime/node"
lipo -verify_arch "$ARCH" "$MANAGER/Contents/MacOS/Electron"
xcrun clang -Wall -Wextra -Werror -mmacosx-version-min=13.0 \
  "$ROOT/native/macos-run-cleanup.c" -o "$CONTENTS/Resources/runtime/ragent-macos-run-cleanup"
lipo -verify_arch "$ARCH" "$CONTENTS/Resources/runtime/ragent-macos-run-cleanup"
xcrun clang -Wall -Wextra -Werror -mmacosx-version-min=13.0 \
  "$ROOT/native/macos-instance-check.c" -o "$CONTENTS/Resources/runtime/ragent-macos-instance-check"
lipo -verify_arch "$ARCH" "$CONTENTS/Resources/runtime/ragent-macos-instance-check"
install -m 0755 "$ROOT/packaging/macos/runtime-codex" "$CONTENTS/Resources/runtime/codex"
install -m 0755 "$ROOT/packaging/macos/runtime-claude" "$CONTENTS/Resources/runtime/claude"

# ── 4. P2P host sidecar (darwin Mach-O) ──────────────────────────────────────
if [ -n "${AGENTOC_P2P_HOST_BINARY:-}" ]; then
  P2P_HOST_BINARY="$AGENTOC_P2P_HOST_BINARY"
  P2P_EXPECTED_SHA="${AGENTOC_P2P_HOST_SHA256:-}"
  [[ "$P2P_EXPECTED_SHA" =~ ^[a-f0-9]{64}$ ]] || { echo 'Prebuilt P2P host requires AGENTOC_P2P_HOST_SHA256.' >&2; exit 1; }
  [ -f "$P2P_HOST_BINARY" ] || { echo 'Prebuilt P2P host is missing.' >&2; exit 1; }
  [ "$(shasum -a 256 "$P2P_HOST_BINARY" | awk '{print $1}')" = "$P2P_EXPECTED_SHA" ] || { echo 'Prebuilt P2P host checksum mismatch.' >&2; exit 1; }
else
  command -v go >/dev/null 2>&1 || {
    echo "Go toolchain is required to build the P2P host sidecar (or set AGENTOC_P2P_HOST_BINARY)" >&2
    exit 1
  }
  P2P_HOST_BINARY="$WORK_DIR/agentoc-p2p-host"
  (cd "$ROOT/p2p" && GOOS=darwin GOARCH="$P2P_GOARCH" CGO_ENABLED=0 go build -trimpath -o "$P2P_HOST_BINARY" ./cmd/agentoc-p2p-host)
fi
[ -f "$P2P_HOST_BINARY" ] || { echo "Missing P2P host sidecar: $P2P_HOST_BINARY" >&2; exit 1; }
P2P_MACHO_MAGIC="$(head -c 4 "$P2P_HOST_BINARY" | od -An -tx1 | tr -d ' \n')"
case "$P2P_MACHO_MAGIC" in
  cffaedfe|cafebabe|feedfacf) ;;  # MH_MAGIC_64 / FAT / swapped variants
  *) echo "Refusing to package non-Mach-O P2P host sidecar (magic $P2P_MACHO_MAGIC)" >&2; exit 1 ;;
esac
lipo -verify_arch "$ARCH" "$P2P_HOST_BINARY"
mkdir -p "$APP_DIR/bin"
rm -f "$APP_DIR/bin/agentoc-p2p-host-amd64" "$APP_DIR/bin/agentoc-p2p-host-arm64"
rm -f "$APP_DIR/bin/agentoc-p2p-host-darwin-arm64" "$APP_DIR/bin/agentoc-p2p-host-darwin-x64"
rm -f "$APP_DIR/bin/agentoc-p2p-host" "$APP_DIR/bin/agentoc-p2p-host.exe"
install -m 0755 "$P2P_HOST_BINARY" "$APP_DIR/bin/ragent-p2p-host"
P2P_BINARY_SHA="$(shasum -a 256 "$APP_DIR/bin/ragent-p2p-host" | awk '{print $1}')"

# ── 5. Codex engine (launcher + darwin native, same release) ─────────────────
CODEX_MAIN_TARBALL="codex-${CODEX_VERSION}.tgz"
CODEX_MAIN_CACHE_PATH="$NODE_CACHE_DIR/$CODEX_MAIN_TARBALL"
download_npm_package "@openai/codex@$CODEX_VERSION" "$CODEX_MAIN_CACHE_PATH" "Codex launcher $CODEX_VERSION"
CODEX_MAIN_CONTENTS="$WORK_DIR/codex-launcher-contents.txt"
tar -tzf "$CODEX_MAIN_CACHE_PATH" > "$CODEX_MAIN_CONTENTS"
grep -Fx 'package/bin/codex.js' "$CODEX_MAIN_CONTENTS" >/dev/null || {
  echo "Codex launcher tarball has no package/bin/codex.js" >&2
  exit 1
}
mkdir -p "$APP_DIR/vendor/codex"
tar -xzf "$CODEX_MAIN_CACHE_PATH" -C "$APP_DIR/vendor/codex" --strip-components=1

CODEX_NATIVE_VERSION="$CODEX_VERSION-$CODEX_NATIVE_TARGET"
CODEX_NATIVE_TARBALL="codex-${CODEX_NATIVE_VERSION}.tgz"
CODEX_NATIVE_CACHE_PATH="$NODE_CACHE_DIR/$CODEX_NATIVE_TARBALL"
download_npm_package "@openai/codex@$CODEX_NATIVE_VERSION" "$CODEX_NATIVE_CACHE_PATH" "Codex native engine $CODEX_NATIVE_VERSION"
mkdir -p "$APP_DIR/vendor/codex/node_modules/$CODEX_NATIVE_PACKAGE"
tar -xzf "$CODEX_NATIVE_CACHE_PATH" \
  -C "$APP_DIR/vendor/codex/node_modules/$CODEX_NATIVE_PACKAGE" \
  --strip-components=1
printf 'codex=%s\nclaude=%s\np2p_input_sha256=%s\n' "$CODEX_VERSION" "$CLAUDE_VERSION" "$P2P_BINARY_SHA" > "$CONTENTS/Resources/runtime/provider-versions"

# ── 6. Claude Code native binary ─────────────────────────────────────────────
CLAUDE_NATIVE_TARBALL="claude-code-${CLAUDE_VERSION}-darwin-${NODE_ARCH}.tgz"
CLAUDE_NATIVE_CACHE_PATH="$NODE_CACHE_DIR/$CLAUDE_NATIVE_TARBALL"
download_npm_package "$CLAUDE_NATIVE_PACKAGE@$CLAUDE_VERSION" "$CLAUDE_NATIVE_CACHE_PATH" "Claude Code $CLAUDE_VERSION"
CLAUDE_NATIVE_CONTENTS="$WORK_DIR/claude-native-contents.txt"
tar -tzf "$CLAUDE_NATIVE_CACHE_PATH" > "$CLAUDE_NATIVE_CONTENTS"
grep -Fx 'package/claude' "$CLAUDE_NATIVE_CONTENTS" >/dev/null || {
  echo "Claude Code tarball has no package/claude binary" >&2
  exit 1
}
CLAUDE_EXTRACT_DIR="$WORK_DIR/claude-native"
mkdir -p "$CLAUDE_EXTRACT_DIR"
tar -xzf "$CLAUDE_NATIVE_CACHE_PATH" -C "$CLAUDE_EXTRACT_DIR" --strip-components=1
CLAUDE_MACHO_MAGIC="$(head -c 4 "$CLAUDE_EXTRACT_DIR/claude" | od -An -tx1 | tr -d ' \n')"
case "$CLAUDE_MACHO_MAGIC" in
  cffaedfe|cafebabe|feedfacf) ;;
  *) echo "Refusing to package non-Mach-O Claude Code binary (magic $CLAUDE_MACHO_MAGIC)" >&2; exit 1 ;;
esac
lipo -verify_arch "$ARCH" "$CLAUDE_EXTRACT_DIR/claude"
install -m 0755 "$CLAUDE_EXTRACT_DIR/claude" "$APP_DIR/bin/claude"
[ -s "$CLAUDE_EXTRACT_DIR/LICENSE.md" ] || { echo 'Claude Code license is missing.' >&2; exit 1; }
mkdir -p "$APP_DIR/third_party_licenses/claude-code"
install -m 0644 "$CLAUDE_EXTRACT_DIR/LICENSE.md" "$APP_DIR/third_party_licenses/claude-code/LICENSE.md"
CLAUDE_BINARY_SHA="$(shasum -a 256 "$APP_DIR/bin/claude" | awk '{print $1}')"
printf 'claude_sha256=%s\n' "$CLAUDE_BINARY_SHA" >> "$CONTENTS/Resources/runtime/provider-versions"

# ── 7. App bundle metadata + launchers ───────────────────────────────────────
sed "s/{{VERSION}}/$BUNDLE_VERSION/g" "$ROOT/packaging/macos/Info.plist" > "$CONTENTS/Info.plist"
install -m 0755 "$ROOT/packaging/macos/AgentoC" "$CONTENTS/MacOS/Ragent"
install -m 0755 "$ROOT/packaging/macos/agentoc-service" "$CONTENTS/Resources/ragent-service"
install -m 0755 "$ROOT/packaging/macos/agentoc-stop" "$CONTENTS/Resources/ragent-stop"
install -m 0755 "$ROOT/packaging/macos/agentoc-cli" "$CONTENTS/Resources/ragent"
install -m 0755 "$ROOT/packaging/macos/agentoc-login" "$CONTENTS/Resources/ragent-login"
install -m 0644 "$ROOT/packaging/macos/agentoc-login.cjs" "$CONTENTS/Resources/ragent-login.cjs"
install -m 0644 "$ROOT/packaging/macos/agentoc-env.sh" "$CONTENTS/Resources/ragent-env.sh"
install -m 0644 "$ROOT/packaging/macos/README.txt" "$CONTENTS/Resources/README.txt"
install -m 0644 "$ROOT/packaging/macos/README.txt" "$STAGE/README.txt"
ln -s /Applications "$STAGE/Applications"

# Both the outer launcher and the visible Electron manager need the product
# icon.  Failing the build is preferable to shipping a default Electron icon.
[ -f "$ROOT/static/icon-512.png" ] && command -v iconutil >/dev/null 2>&1 && command -v sips >/dev/null 2>&1 || {
  echo 'Ragent icon source or macOS icon tools are missing.' >&2; exit 1;
}
ICONSET="$WORK_DIR/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ROOT/static/icon-512.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  doubled=$((size * 2))
  sips -z "$doubled" "$doubled" "$ROOT/static/icon-512.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns"
install -m 0644 "$CONTENTS/Resources/AppIcon.icns" "$MANAGER/Contents/Resources/AppIcon.icns"
plutil -insert CFBundleIconFile -string AppIcon "$CONTENTS/Info.plist"
plutil -replace CFBundleIconFile -string AppIcon "$MANAGER/Contents/Info.plist" || \
  plutil -insert CFBundleIconFile -string AppIcon "$MANAGER/Contents/Info.plist"

# Set the final bundle permissions before signing. Do not change the signed
# app's resources or executable bits after the signature has been verified.
chmod -R u+rwX,go+rX "$STAGE/Ragent.app"

# ── 8. Sign inside out; ad-hoc candidates are for controlled testing only ──
command -v codesign >/dev/null 2>&1 || { echo 'codesign is required.' >&2; exit 1; }
SIGNING_STATUS=ad-hoc
EFFECTIVE_IDENTITY="${SIGN_IDENTITY:--}"
# Electron needs per-helper entitlements; its maintained signer walks the
# nested framework and helper apps rather than applying --deep at signing.
node --input-type=module - "$DESKTOP_BUILD/node_modules/@electron/osx-sign/dist/sign.js" "$MANAGER" "$EFFECTIVE_IDENTITY" <<'NODE'
import { pathToFileURL } from 'node:url';
const [modulePath, app, identity] = process.argv.slice(2);
const { sign } = await import(pathToFileURL(modulePath).href);
const adhoc = identity === '-';
await sign({ app, platform: 'darwin', identity, identityValidation: !adhoc,
  preAutoEntitlements: false, preEmbedProvisioningProfile: false,
  ...(adhoc ? { optionsForFile: () => ({ timestamp: 'none', hardenedRuntime: false }) } : {}) });
NODE
if [ -n "$SIGN_IDENTITY" ]; then
  # The upstream Node binary contains get-task-allow. Replace its signature
  # with the app's narrow JIT entitlement before notarization.
  codesign --force --options runtime --timestamp --entitlements "$ROOT/packaging/macos/entitlements.plist" \
    --sign "$SIGN_IDENTITY" "$CONTENTS/Resources/runtime/node"
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP_DIR/bin/ragent-p2p-host"
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$CONTENTS/Resources/runtime/ragent-macos-run-cleanup"
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$CONTENTS/Resources/runtime/ragent-macos-instance-check"
  codesign --force --options runtime --timestamp --entitlements "$ROOT/packaging/macos/entitlements.plist" \
    --sign "$SIGN_IDENTITY" "$STAGE/Ragent.app"
  codesign --display --entitlements :- "$CONTENTS/Resources/runtime/node" > "$WORK_DIR/node-entitlements.plist" 2>/dev/null
  [ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.cs.allow-jit' "$WORK_DIR/node-entitlements.plist")" = true ] || {
    echo 'Signed Node runtime is missing its JIT entitlement.' >&2; exit 1;
  }
  [ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.get-task-allow' "$WORK_DIR/node-entitlements.plist" 2>/dev/null || true)" != true ] || {
    echo 'Signed Node runtime has a disallowed debugging entitlement.' >&2; exit 1;
  }
  codesign --display --verbose=4 "$CONTENTS/Resources/runtime/node" 2> "$WORK_DIR/node-signature.txt"
  grep -q '^Authority=Developer ID Application:' "$WORK_DIR/node-signature.txt" &&
    grep -Eq '^CodeDirectory .*flags=.*runtime' "$WORK_DIR/node-signature.txt" &&
    grep -q '^Timestamp=' "$WORK_DIR/node-signature.txt" || {
      echo 'The signing identity must produce a timestamped Developer ID signature with hardened runtime.' >&2; exit 1;
    }
  SIGNING_STATUS=developer-id
else
  codesign --force --sign - --entitlements "$ROOT/packaging/macos/entitlements.plist" "$CONTENTS/Resources/runtime/node"
  codesign --force --sign - "$APP_DIR/bin/ragent-p2p-host"
  codesign --force --sign - "$CONTENTS/Resources/runtime/ragent-macos-run-cleanup"
  codesign --force --sign - "$CONTENTS/Resources/runtime/ragent-macos-instance-check"
  codesign --force --sign - "$STAGE/Ragent.app"
fi
codesign --verify --strict "$CONTENTS/Resources/runtime/node"
codesign --verify --strict "$APP_DIR/bin/ragent-p2p-host"
codesign --verify --strict "$CONTENTS/Resources/runtime/ragent-macos-run-cleanup"
codesign --verify --strict "$CONTENTS/Resources/runtime/ragent-macos-instance-check"
codesign --verify --deep --strict "$MANAGER"
codesign --verify --strict "$APP_DIR/bin/claude"
while IFS= read -r -d '' native_file; do
  if file -b "$native_file" | grep -q 'Mach-O'; then
    codesign --verify --strict "$native_file" || {
      echo "Invalid bundled Codex native signature: $native_file" >&2; exit 1;
    }
  fi
done < <(find "$APP_DIR/vendor/codex/node_modules/$CODEX_NATIVE_PACKAGE" -type f -print0)
[ "$(shasum -a 256 "$APP_DIR/bin/claude" | awk '{print $1}')" = "$CLAUDE_BINARY_SHA" ] || {
  echo 'Signing changed the bundled Claude Code binary; refusing this package.' >&2; exit 1;
}

# ── 9. Post-build verification ───────────────────────────────────────────────
BUNDLED_NODE_VERSION="$("$CONTENTS/Resources/runtime/node" --version)"
[ "$BUNDLED_NODE_VERSION" = "$NODE_VERSION" ] || {
  echo "Bundled Node reports $BUNDLED_NODE_VERSION, expected $NODE_VERSION" >&2
  exit 1
}
for script in "$CONTENTS/MacOS/Ragent" "$CONTENTS/Resources/ragent-service" "$CONTENTS/Resources/ragent-stop" "$CONTENTS/Resources/ragent" "$CONTENTS/Resources/ragent-login" "$CONTENTS/Resources/ragent-env.sh"; do
  bash -n "$script" || { echo "Launcher syntax error: $script" >&2; exit 1; }
done
for required in \
  "$APP_DIR/chat-server.mjs" \
  "$APP_DIR/cli.js" \
  "$APP_DIR/vendor/codex/bin/codex.js" \
  "$CONTENTS/Resources/runtime/codex" \
  "$CONTENTS/Resources/runtime/claude" \
  "$APP_DIR/vendor/codex/node_modules/$CODEX_NATIVE_PACKAGE/package.json" \
  "$APP_DIR/bin/claude" \
  "$APP_DIR/bin/ragent-p2p-host" \
  "$APP_DIR/static/chat/ui.js" \
  "$APP_DIR/templates/chat.html"
do
  [ -e "$required" ] || { echo "Built bundle is missing $required" >&2; exit 1; }
done
node "$ROOT/scripts/verify-runtime-payload.mjs" "$CONTENTS"
codesign --verify --deep --strict "$STAGE/Ragent.app"

# ── 10. DMG ──────────────────────────────────────────────────────────────────
# Refuse a mixed-source bundle before optional notarization submits it.
assert_source_unchanged
hdiutil create -volname Ragent -srcfolder "$STAGE" -format UDZO "$DMG_PATH" >/dev/null
if [ -n "$SIGN_IDENTITY" ]; then
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG_PATH"
  codesign --verify --strict "$DMG_PATH"
fi
if [ -n "$NOTARY_PROFILE" ]; then
  xcrun notarytool submit "$DMG_PATH" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json > "$WORK_DIR/notary-result.json"
  node -e 'const r=require(process.argv[1]); if(r.status!=="Accepted") { console.error("Apple notarization did not accept the candidate."); process.exit(1); }' "$WORK_DIR/notary-result.json"
  xcrun stapler staple "$DMG_PATH"
  xcrun stapler validate "$DMG_PATH"
  SIGNING_STATUS=developer-id-notarized
fi

# Mount verification: the .app must be present and launchable-looking.
MOUNT_DIR="$WORK_DIR/verify-mount"
mkdir -p "$MOUNT_DIR"
hdiutil attach "$DMG_PATH" -readonly -nobrowse -mountpoint "$MOUNT_DIR" >/dev/null
if [ ! -d "$MOUNT_DIR/Ragent.app/Contents/MacOS" ]; then
  hdiutil detach "$MOUNT_DIR" >/dev/null 2>&1 || true
  echo "DMG verification failed: Ragent.app missing from mounted volume" >&2
  exit 1
fi
hdiutil detach "$MOUNT_DIR" >/dev/null

assert_source_unchanged
[ ! -e "$FINAL_OUTPUT" ] || { echo 'Candidate output already exists; refusing to overwrite it.' >&2; exit 1; }
mv "$DMG_PATH" "$FINAL_OUTPUT"
if [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] && [ "$ARCH" = arm64 ]; then
  node "$ROOT/scripts/create-release-buildinfo.mjs" "$FINAL_OUTPUT" "$VERSION" "$SOURCE_COMMIT"
fi
printf '%s\n' "$SIGNING_STATUS" > "$OUTPUT_DIR/${OUTPUT_NAME}.signing-status.txt"
if [ -n "$NOTARY_PROFILE" ]; then
  cp "$WORK_DIR/notary-result.json" "$OUTPUT_DIR/${OUTPUT_NAME}.notary-result.json"
fi
printf '%s\n' "$FINAL_OUTPUT"
