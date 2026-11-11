#!/bin/bash
set -euo pipefail

# Build the AgentoC macOS DMG: a self-contained .app with a bundled Node
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

PKG_VERSION="$(node -p "require('$ROOT/package.json').version")"
SOURCE_COMMIT="$(git -C "$ROOT" rev-parse --short=8 HEAD 2>/dev/null || echo nogit)"
if [ -n "${AGENTOC_PACKAGE_VERSION:-}" ]; then
  VERSION="$AGENTOC_PACKAGE_VERSION"
else
  VERSION="$PKG_VERSION+main.$SOURCE_COMMIT.$(date +%Y%m%d%H%M)"
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
    echo "Codex $CODEX_VERSION is outside the validated AgentoC adapter range (target $CODEX_ADAPTER_TARGET_VERSION)." >&2
    exit 1
  fi
fi
CLAUDE_ADAPTER_COMPATIBLE="$(node --input-type=module -e \
  'import(process.argv[1]).then((m) => process.stdout.write(m.isAdapterCompatible("claude", process.argv[2]) ? "yes" : "no"))' \
  "$ROOT/chat/harness-compatibility.mjs" "$CLAUDE_VERSION")"
if [ "$CLAUDE_ADAPTER_COMPATIBLE" != "yes" ]; then
  echo "Claude Code $CLAUDE_VERSION is outside the validated AgentoC adapter range." >&2
  exit 1
fi
printf 'Building AgentoC %s (darwin/%s) with Codex %s and Claude Code %s\n' \
  "$VERSION" "$ARCH" "$CODEX_VERSION" "$CLAUDE_VERSION"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentoc-dmg.XXXXXX")"
STAGE="$WORK_DIR/stage"
CONTENTS="$STAGE/AgentoC.app/Contents"
APP_DIR="$CONTENTS/Resources/app"
OUTPUT_NAME="agentoc_${VERSION}-darwin-${ARCH}.dmg"
FINAL_OUTPUT="$OUTPUT_DIR/$OUTPUT_NAME"
DMG_PATH="$WORK_DIR/$OUTPUT_NAME"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources" "$APP_DIR" "$OUTPUT_DIR"

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

# ── 1. Application files from the shared committed runtime allowlist ────────
node "$ROOT/scripts/stage-runtime-payload.mjs" \
  --source "$ROOT" --destination "$APP_DIR" --profile desktop
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
MANAGER="$CONTENTS/Resources/Manager.app"
cp -R "$DESKTOP_BUILD/node_modules/electron/dist/Electron.app" "$MANAGER"
MANAGER_APP="$MANAGER/Contents/Resources/app"
mkdir -p "$MANAGER_APP/assets"
for name in main.cjs preload.cjs update-check.cjs wait.html; do
  install -m 0644 "$ROOT/desktop/$name" "$MANAGER_APP/$name"
done
install -m 0644 "$ROOT/static/desktop/agentoc-android-logo.png" "$MANAGER_APP/assets/agentoc-android-logo.png"
DESKTOP_VERSION="$(node -p "require('$ROOT/desktop/package.json').version")"
printf '{"name":"ragent-desktop-manager","version":"%s","private":true,"main":"main.cjs"}\n' "$DESKTOP_VERSION" > "$MANAGER_APP/package.json"
plutil -replace CFBundleIdentifier -string cloud.agenton.ragent.manager "$MANAGER/Contents/Info.plist"
plutil -replace CFBundleName -string Ragent "$MANAGER/Contents/Info.plist"

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
lipo -verify_arch "$ARCH" "$CONTENTS/Resources/runtime/node"
lipo -verify_arch "$ARCH" "$MANAGER/Contents/MacOS/Electron"
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
install -m 0755 "$P2P_HOST_BINARY" "$APP_DIR/bin/agentoc-p2p-host"
P2P_BINARY_SHA="$(shasum -a 256 "$APP_DIR/bin/agentoc-p2p-host" | awk '{print $1}')"

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
install -m 0755 "$ROOT/packaging/macos/AgentoC" "$CONTENTS/MacOS/AgentoC"
install -m 0755 "$ROOT/packaging/macos/agentoc-service" "$CONTENTS/MacOS/agentoc-service"
install -m 0755 "$ROOT/packaging/macos/agentoc-stop" "$CONTENTS/MacOS/agentoc-stop"
install -m 0755 "$ROOT/packaging/macos/agentoc-cli" "$CONTENTS/MacOS/agentoc-cli"
install -m 0644 "$ROOT/packaging/macos/agentoc-env.sh" "$CONTENTS/MacOS/agentoc-env.sh"
install -m 0644 "$ROOT/packaging/macos/com.agentoc.agentoc.plist" "$CONTENTS/Resources/com.agentoc.agentoc.plist"
install -m 0644 "$ROOT/packaging/macos/README.txt" "$CONTENTS/Resources/README.txt"
install -m 0644 "$ROOT/packaging/macos/README.txt" "$STAGE/README.txt"
ln -s /Applications "$STAGE/Applications"

# App icon (best effort: sips + iconutil are stock macOS tools).
if [ -f "$ROOT/static/icon-512.png" ] && command -v iconutil >/dev/null 2>&1 && command -v sips >/dev/null 2>&1; then
  ICONSET="$WORK_DIR/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$ROOT/static/icon-512.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    doubled=$((size * 2))
    sips -z "$doubled" "$doubled" "$ROOT/static/icon-512.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  if iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns" >/dev/null 2>&1; then
    plutil -insert CFBundleIconFile -string AppIcon "$CONTENTS/Info.plist" >/dev/null
  fi
fi

# Set the final bundle permissions before signing. Do not change the signed
# app's resources or executable bits after the signature has been verified.
chmod -R u+rwX,go+rX "$STAGE/AgentoC.app"

# ── 8. Sign the app; ad-hoc candidates are not trusted distribution builds ──
SIGNING_STATUS=ad-hoc
if [ -n "$SIGN_IDENTITY" ]; then
  codesign --force --deep --options runtime --timestamp \
    --entitlements "$ROOT/packaging/macos/entitlements.plist" \
    --sign "$SIGN_IDENTITY" "$STAGE/AgentoC.app"
  codesign --verify --deep --strict "$STAGE/AgentoC.app"
  SIGNING_STATUS=developer-id
elif command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$STAGE/AgentoC.app" 2>/dev/null || {
    echo 'Ad-hoc signing failed.' >&2; exit 1;
  }
else
  echo 'codesign is required to build the macOS app.' >&2; exit 1
fi
[ "$(shasum -a 256 "$APP_DIR/bin/claude" | awk '{print $1}')" = "$CLAUDE_BINARY_SHA" ] || {
  echo 'Signing changed the bundled Claude Code binary; refusing this package.' >&2; exit 1;
}

# ── 9. Post-build verification ───────────────────────────────────────────────
BUNDLED_NODE_VERSION="$("$CONTENTS/Resources/runtime/node" --version)"
[ "$BUNDLED_NODE_VERSION" = "$NODE_VERSION" ] || {
  echo "Bundled Node reports $BUNDLED_NODE_VERSION, expected $NODE_VERSION" >&2
  exit 1
}
for script in "$CONTENTS/MacOS/AgentoC" "$CONTENTS/MacOS/agentoc-service" "$CONTENTS/MacOS/agentoc-stop" "$CONTENTS/MacOS/agentoc-cli" "$CONTENTS/MacOS/agentoc-env.sh"; do
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
  "$APP_DIR/bin/agentoc-p2p-host" \
  "$APP_DIR/static/chat/ui.js" \
  "$APP_DIR/templates/chat.html"
do
  [ -e "$required" ] || { echo "Built bundle is missing $required" >&2; exit 1; }
done
node "$ROOT/scripts/verify-runtime-payload.mjs" "$CONTENTS"
codesign --verify --deep --strict "$STAGE/AgentoC.app"

# ── 10. DMG ──────────────────────────────────────────────────────────────────
hdiutil create -volname AgentoC -srcfolder "$STAGE" -format UDZO "$DMG_PATH" >/dev/null
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
if [ ! -d "$MOUNT_DIR/AgentoC.app/Contents/MacOS" ]; then
  hdiutil detach "$MOUNT_DIR" >/dev/null 2>&1 || true
  echo "DMG verification failed: AgentoC.app missing from mounted volume" >&2
  exit 1
fi
hdiutil detach "$MOUNT_DIR" >/dev/null

[ ! -e "$FINAL_OUTPUT" ] || { echo 'Candidate output already exists; refusing to overwrite it.' >&2; exit 1; }
mv "$DMG_PATH" "$FINAL_OUTPUT"
printf '%s\n' "$SIGNING_STATUS" > "$OUTPUT_DIR/${OUTPUT_NAME}.signing-status.txt"
if [ -n "$NOTARY_PROFILE" ]; then
  cp "$WORK_DIR/notary-result.json" "$OUTPUT_DIR/${OUTPUT_NAME}.notary-result.json"
fi
printf '%s\n' "$FINAL_OUTPUT"
