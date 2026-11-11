#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# DS-01 parity preflight (off by default; enable with AGENTOC_PARITY_GATE=1).
# Compares the source tree against itself: fails on uncommitted changes to
# shipped artifacts or drift from the recorded package manifest. Never touches
# the installed root or any running service.
if [ "${AGENTOC_PARITY_GATE:-0}" = "1" ]; then
  node "$ROOT/scripts/verify-source-parity.mjs" \
    --source "$ROOT" --install "$ROOT" --live-url none >/dev/null || {
    echo "Parity preflight failed (dirty source or package-manifest drift); refusing to package." >&2
    exit 1
  }
fi

ARCH="${AGENTOC_PACKAGE_ARCH:-$(dpkg --print-architecture)}"
OUTPUT_DIR="${AGENTOC_DEB_OUTPUT_DIR:-/srv/agentoc-promoted-data/workspace/releases}"
SIGNALING_URL="${AGENTOC_PACKAGE_SIGNALING_URL:-}"
PACKAGE_PUBLIC_BASE_URL="${AGENTOC_PACKAGE_PUBLIC_BASE_URL:-https://app.agentoncloud.com}"
PACKAGE_ACCOUNTS_URL="${AGENTOC_PACKAGE_ACCOUNTS_URL:-https://agentoc.andyscodexagent.cyou/accounts}"
PACKAGE_ACCOUNTS_JWKS_URL="${AGENTOC_PACKAGE_ACCOUNTS_JWKS_URL:-https://agentoc.andyscodexagent.cyou/accounts/.well-known/jwks.json}"
PACKAGE_ACCOUNTS_ISSUER="${AGENTOC_PACKAGE_ACCOUNTS_ISSUER:-https://agentoc.andyscodexagent.cyou}"
PACKAGE_TURN_BROKER_URL="${AGENTOC_PACKAGE_TURN_BROKER_URL:-https://agentoc.andyscodexagent.cyou/turn}"
PACKAGE_GOOGLE_NATIVE_SERVER_CLIENT_IDS="${AGENTOC_PACKAGE_GOOGLE_NATIVE_SERVER_CLIENT_IDS:-}"

# Auto-version: resolve a version strictly higher than the highest version this
# host already knows about (installed package + previously built debs in
# OUTPUT_DIR, or an explicit AGENTOC_ONLINE_VERSION seed). AGENTOC_PACKAGE_VERSION
# keeps its old meaning as a manual override.
resolve_package_version() {
  local pkg_version best candidate name
  pkg_version="$(node -p "require('$ROOT/package.json').version")"
  best="${AGENTOC_ONLINE_VERSION:-}"

  if command -v dpkg-query >/dev/null 2>&1; then
    candidate="$(dpkg-query -W -f='${Version}' agentoc 2>/dev/null || true)"
    if [ -n "$candidate" ]; then
      if [ -z "$best" ] || dpkg --compare-versions "$candidate" gt "$best"; then
        best="$candidate"
      fi
    fi
  fi

  for name in "$OUTPUT_DIR"/agentoc_*_"$ARCH".deb; do
    [ -e "$name" ] || continue
    candidate="$(basename "$name")"
    candidate="${candidate#agentoc_}"
    candidate="${candidate%_${ARCH}.deb}"
    if [ -z "$best" ] || dpkg --compare-versions "$candidate" gt "$best"; then
      best="$candidate"
    fi
  done

  local source_commit
  source_commit="$(git -C "$ROOT" rev-parse --short=8 HEAD 2>/dev/null || true)"
  if [ -z "$source_commit" ] && [ -f "$ROOT/.agentoc-source-commit" ]; then
    source_commit="$(cut -c1-8 "$ROOT/.agentoc-source-commit")"
  fi

  if [ -n "$best" ]; then
    local upstream major minor patch
    upstream="${best%%+*}"
    IFS='.' read -r major minor patch <<< "$upstream"
    if ! [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ && "$patch" =~ ^[0-9]+$ ]]; then
      echo "Cannot parse online version '$best'; set AGENTOC_PACKAGE_VERSION explicitly" >&2
      exit 1
    fi
    if ! dpkg --compare-versions "$pkg_version" gt "$upstream"; then
      pkg_version="$major.$minor.$((patch + 1))"
    fi
  fi

  printf '%s+main.%s.%s\n' \
    "$pkg_version" \
    "${source_commit:-nogit}" \
    "$(date +%Y%m%d%H%M)"
}

if [ -n "${AGENTOC_PACKAGE_VERSION:-}" ]; then
  VERSION="$AGENTOC_PACKAGE_VERSION"
else
  VERSION="$(resolve_package_version)"
fi
if [ "${AGENTOC_PRINT_VERSION_ONLY:-0}" = "1" ]; then
  printf '%s\n' "$VERSION"
  exit 0
fi
NODE_VERSION="${AGENTOC_NODE_VERSION:-v24.12.0}"
[[ "$NODE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ -s "$ROOT/third_party_licenses/node/${NODE_VERSION}-LICENSE.txt" ] || {
  echo 'Bundled Node version requires its matching third-party license notice.' >&2
  exit 1
}
NODE_CACHE_DIR="${AGENTOC_NODE_CACHE_DIR:-/srv/agentoc-promoted-data/workspace/cache/node}"
NPM_REGISTRY="${AGENTOC_NPM_REGISTRY:-https://registry.npmjs.org}"
QRCODE_TERMINAL_VERSION=0.12.0
QRCODE_TERMINAL_SHA256=3a6260c4e0d80bd527a3f930e90ea2348c03646621f25aa0bd960ee205a0a706

# Provider runtimes must ship as matched launcher/native pairs.  Resolve the
# current stable npm version by default, but keep explicit version overrides
# for a reproducible rollback or an air-gapped mirror build.
resolve_npm_version() {
  local package_name="$1"
  local configured_version="$2"
  if [ -n "$configured_version" ]; then
    printf '%s\n' "$configured_version"
    return
  fi

  npm view "$package_name" version --registry="$NPM_REGISTRY" | tr -d '[:space:]'
}

npm_dist_field() {
  local package_spec="$1"
  local field_name="$2"
  npm view "$package_spec" "dist.$field_name" --registry="$NPM_REGISTRY" | tr -d '[:space:]'
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

  tarball_url="$(npm_dist_field "$package_spec" tarball)"
  integrity="$(npm_dist_field "$package_spec" integrity)"
  [ -n "$tarball_url" ] || { echo "$label: registry returned no tarball URL" >&2; exit 1; }
  [ -n "$integrity" ] || { echo "$label: registry returned no integrity digest" >&2; exit 1; }
  if [ ! -f "$cache_path" ]; then
    curl -fsSL --retry 3 --connect-timeout 15 "$tarball_url" -o "$cache_path"
  fi
  verify_npm_sri "$cache_path" "$integrity" "$label"
}

case "$ARCH" in
  arm64)
    NODE_ARCH=arm64
    P2P_GOARCH=arm64
    CODEX_NATIVE_TARGET=linux-arm64
    CODEX_NATIVE_PACKAGE='@openai/codex-linux-arm64'
    CLAUDE_NATIVE_PACKAGE='@anthropic-ai/claude-code-linux-arm64'
    P2P_HOST_BINARY="$ROOT/bin/agentoc-p2p-host"
    EXPECTED_ELF_MACHINE=b700
    ;;
  amd64)
    NODE_ARCH=x64
    P2P_GOARCH=amd64
    CODEX_NATIVE_TARGET=linux-x64
    CODEX_NATIVE_PACKAGE='@openai/codex-linux-x64'
    CLAUDE_NATIVE_PACKAGE='@anthropic-ai/claude-code-linux-x64'
    P2P_HOST_BINARY="$ROOT/bin/agentoc-p2p-host-amd64"
    EXPECTED_ELF_MACHINE=3e00
    ;;
  *)
    echo "Unsupported Deb architecture for bundled runtimes: $ARCH" >&2
    exit 1
    ;;
esac

CODEX_ADAPTER_TARGET_VERSION="$(node --input-type=module -e \
  'import(process.argv[1]).then((m) => process.stdout.write(m.CODEX_HARNESS_VERSION_CONTRACT.targetVersion))' \
  "$ROOT/lib/harness-version-catalog.mjs")"
CLAUDE_ADAPTER_TARGET_VERSION="$(node --input-type=module -e \
  'import(process.argv[1]).then((m) => process.stdout.write(m.HARNESS_VERSION_CONTRACTS.claude.targetVersion))' \
  "$ROOT/lib/harness-version-catalog.mjs")"
CODEX_VERSION="$(resolve_npm_version '@openai/codex' "${AGENTOC_CODEX_VERSION:-$CODEX_ADAPTER_TARGET_VERSION}")"
CLAUDE_VERSION="$(resolve_npm_version '@anthropic-ai/claude-code' "${AGENTOC_CLAUDE_VERSION:-$CLAUDE_ADAPTER_TARGET_VERSION}")"
case "$CODEX_VERSION" in
  *[!0-9.]*|'') echo "Invalid Codex version from registry: '$CODEX_VERSION'" >&2; exit 1 ;;
esac
case "$CLAUDE_VERSION" in
  *[!0-9.]*|'') echo "Invalid Claude Code version from registry: '$CLAUDE_VERSION'" >&2; exit 1 ;;
esac
CODEX_ADAPTER_COMPATIBLE="$(node --input-type=module -e \
  'import(process.argv[1]).then((m) => process.stdout.write(m.isAdapterCompatible("codex", process.argv[2]) ? "yes" : "no"))' \
  "$ROOT/chat/harness-compatibility.mjs" "$CODEX_VERSION")"
if [ "$CODEX_ADAPTER_COMPATIBLE" != "yes" ]; then
  echo "Codex $CODEX_VERSION is outside the validated AgentoC adapter range." >&2
  exit 1
fi
CLAUDE_ADAPTER_COMPATIBLE="$(node --input-type=module -e \
  'import(process.argv[1]).then((m) => process.stdout.write(m.isAdapterCompatible("claude", process.argv[2]) ? "yes" : "no"))' \
  "$ROOT/chat/harness-compatibility.mjs" "$CLAUDE_VERSION")"
if [ "$CLAUDE_ADAPTER_COMPATIBLE" != "yes" ]; then
  echo "Claude Code $CLAUDE_VERSION is outside the validated AgentoC adapter range." >&2
  exit 1
fi
printf 'Bundling Codex %s and Claude Code %s from %s\n' "$CODEX_VERSION" "$CLAUDE_VERSION" "$NPM_REGISTRY"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentoc-deb.XXXXXX")"
STAGE="$WORK_DIR/stage"
APP_DIR="$STAGE/opt/agentoc/app"
OUTPUT_NAME="agentoc_${VERSION}_${ARCH}.deb"
OUTPUT="$WORK_DIR/$OUTPUT_NAME"
FINAL_OUTPUT="$OUTPUT_DIR/$OUTPUT_NAME"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$APP_DIR" "$STAGE/opt/agentoc/runtime" "$STAGE/usr/bin" "$STAGE/usr/sbin" "$STAGE/usr/lib/agentoc"
mkdir -p "$STAGE/opt/agentoc/vendor"
mkdir -p "$STAGE/lib/systemd/system" "$STAGE/etc/agentoc" "$STAGE/usr/share/applications"
mkdir -p "$STAGE/usr/share/icons/hicolor/512x512/apps" "$STAGE/DEBIAN" "$OUTPUT_DIR"
if [ ! -w "$OUTPUT_DIR" ]; then
  echo "Package output directory is not writable: $OUTPUT_DIR. Set AGENTOC_DEB_OUTPUT_DIR or repair its ownership." >&2
  exit 1
fi
if [ ! -w "$NODE_CACHE_DIR" ]; then
  echo "Package cache is not writable: $NODE_CACHE_DIR. Set AGENTOC_NODE_CACHE_DIR or repair its ownership." >&2
  exit 1
fi

PACK_JSON="$(cd "$ROOT" && npm pack --json --pack-destination "$WORK_DIR")"
PACK_FILE="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(value[0].filename)' "$PACK_JSON")"
# Linux package staging: never let platform/scratch trees ride along even if a
# future npm "files" glob widens. Excluded paths are not part of the shipped app.
tar -xzf "$WORK_DIR/$PACK_FILE" -C "$APP_DIR" --strip-components=1 \
  --exclude='./android' --exclude='./windows' --exclude='./macos' \
  --exclude='./ios' --exclude='./design' --exclude='./work' \
  --exclude='./release' --exclude='./releases' --exclude='./cache'
# npm pack normalizes file mtimes for reproducibility. Keep the package's
# explicit version available to the running service so frontend asset URLs
# still change after each packaged deployment instead of reusing a stale PWA
# cache when the normalized mtimes happen to be identical.
printf '%s\n' "$VERSION" > "$APP_DIR/.agentoc-package-version"

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

# Build the same locked Electron manager as Windows in a disposable directory.
# Electron's install step downloads the distribution for the build host, so a
# cross-architecture package must not silently ship the wrong executable.
if [ "$ARCH" != "$(dpkg --print-architecture)" ]; then
  echo 'The desktop manager requires a native-architecture Debian build host.' >&2
  exit 1
fi
DESKTOP_BUILD="$WORK_DIR/desktop-build"
DESKTOP_ROOT="$STAGE/opt/agentoc/Desktop"
mkdir -p "$DESKTOP_BUILD" "$DESKTOP_ROOT"
install -m 0644 "$ROOT/desktop/package.json" "$ROOT/desktop/package-lock.json" "$DESKTOP_BUILD/"
(cd "$DESKTOP_BUILD" && ELECTRON_CACHE="${ELECTRON_CACHE:-$NODE_CACHE_DIR/electron}" npm ci --no-audit --no-fund)
# Electron 44 exposes an explicit installer rather than an npm lifecycle hook.
(cd "$DESKTOP_BUILD" && ELECTRON_CACHE="${ELECTRON_CACHE:-$NODE_CACHE_DIR/electron}" node node_modules/electron/install.js)
cp -a "$DESKTOP_BUILD/node_modules/electron/dist/." "$DESKTOP_ROOT/"
mv "$DESKTOP_ROOT/electron" "$DESKTOP_ROOT/ragent"
DESKTOP_MACHINE="$(od -An -tx1 -j18 -N2 "$DESKTOP_ROOT/ragent" | tr -d ' \n')"
[ "$DESKTOP_MACHINE" = "$EXPECTED_ELF_MACHINE" ] || { echo 'Electron architecture mismatch' >&2; exit 1; }
DESKTOP_APP="$DESKTOP_ROOT/resources/app"
mkdir -p "$DESKTOP_APP/assets"
for name in main.cjs preload.cjs update-check.cjs wait.html; do
  install -m 0644 "$ROOT/desktop/$name" "$DESKTOP_APP/$name"
done
install -m 0644 "$ROOT/static/desktop/agentoc-android-logo.png" "$DESKTOP_APP/assets/agentoc-android-logo.png"
DESKTOP_VERSION="$(node -p "require('$ROOT/desktop/package.json').version")"
printf '{"name":"ragent-desktop-manager","version":"%s","private":true,"main":"main.cjs"}\n' "$DESKTOP_VERSION" > "$DESKTOP_APP/package.json"
# Chromium's setuid helper is installed root-owned by dpkg; the renderer still
# uses Electron's sandbox and must not fall back to --no-sandbox.
chmod 4755 "$DESKTOP_ROOT/chrome-sandbox"

NODE_DIST="node-${NODE_VERSION}-linux-${NODE_ARCH}"
NODE_TARBALL="${NODE_DIST}.tar.xz"
NODE_BASE_URL="https://nodejs.org/dist/${NODE_VERSION}"
mkdir -p "$NODE_CACHE_DIR"
if [ ! -f "$NODE_CACHE_DIR/$NODE_TARBALL" ]; then
  curl -fsSL --retry 3 --connect-timeout 15 "$NODE_BASE_URL/$NODE_TARBALL" -o "$NODE_CACHE_DIR/$NODE_TARBALL"
fi
curl -fsSL --retry 3 --connect-timeout 15 "$NODE_BASE_URL/SHASUMS256.txt" -o "$WORK_DIR/SHASUMS256.txt"
EXPECTED_SHA="$(awk -v name="$NODE_TARBALL" '$2 == name { print $1 }' "$WORK_DIR/SHASUMS256.txt")"
[ -n "$EXPECTED_SHA" ] || { echo "Missing Node checksum for $NODE_TARBALL" >&2; exit 1; }
ACTUAL_SHA="$(sha256sum "$NODE_CACHE_DIR/$NODE_TARBALL" | awk '{ print $1 }')"
[ "$EXPECTED_SHA" = "$ACTUAL_SHA" ] || { echo "Node runtime checksum mismatch" >&2; exit 1; }
tar -xJf "$NODE_CACHE_DIR/$NODE_TARBALL" -C "$WORK_DIR"
cp "$WORK_DIR/$NODE_DIST/bin/node" "$STAGE/opt/agentoc/runtime/node"
chmod 0755 "$STAGE/opt/agentoc/runtime/node" "$APP_DIR/cli.js"

# Fetch the Codex launcher and target-native engine from the same official
# release. A source checkout's vendored launcher may be older, and combining
# it with a newer engine is unsupported and can fail before app-server emits a
# terminal event.
CODEX_MAIN_TARBALL="codex-${CODEX_VERSION}.tgz"
CODEX_MAIN_CACHE_PATH="$NODE_CACHE_DIR/$CODEX_MAIN_TARBALL"
download_npm_package "@openai/codex@$CODEX_VERSION" "$CODEX_MAIN_CACHE_PATH" "Codex launcher $CODEX_VERSION"
CODEX_MAIN_CONTENTS="$WORK_DIR/codex-launcher-contents.txt"
tar -tzf "$CODEX_MAIN_CACHE_PATH" > "$CODEX_MAIN_CONTENTS"
grep -Fx 'package/bin/codex.js' "$CODEX_MAIN_CONTENTS" >/dev/null || {
  echo "Codex launcher tarball has no package/bin/codex.js" >&2
  exit 1
}
mkdir -p "$STAGE/opt/agentoc/vendor/codex"
tar -xzf "$CODEX_MAIN_CACHE_PATH" -C "$STAGE/opt/agentoc/vendor/codex" --strip-components=1

# The current Codex package publishes platform executables as package aliases
# of the same release (`@openai/codex@<version>-linux-<arch>`). Keep the
# optional-dependency directory name expected by bin/codex.js while verifying
# the registry's sha512 SRI for the exact native artifact.
CODEX_NATIVE_VERSION="$CODEX_VERSION-$CODEX_NATIVE_TARGET"
CODEX_NATIVE_TARBALL="codex-${CODEX_NATIVE_VERSION}.tgz"
CODEX_NATIVE_CACHE_PATH="$NODE_CACHE_DIR/$CODEX_NATIVE_TARBALL"
download_npm_package "@openai/codex@$CODEX_NATIVE_VERSION" "$CODEX_NATIVE_CACHE_PATH" "Codex native engine $CODEX_NATIVE_VERSION"
mkdir -p "$STAGE/opt/agentoc/vendor/codex/node_modules/$CODEX_NATIVE_PACKAGE"
tar -xzf "$CODEX_NATIVE_CACHE_PATH" \
  -C "$STAGE/opt/agentoc/vendor/codex/node_modules/$CODEX_NATIVE_PACKAGE" \
  --strip-components=1
cat > "$STAGE/opt/agentoc/runtime/codex" <<'EOF'
#!/bin/sh
exec /opt/agentoc/runtime/node /opt/agentoc/vendor/codex/bin/codex.js "$@"
EOF
cat > "$STAGE/opt/agentoc/runtime/agentoc-codex-app-server" <<'EOF'
#!/bin/sh
exec /opt/agentoc/runtime/node /opt/agentoc/vendor/codex/bin/codex.js "$@"
EOF
chmod 0755 "$STAGE/opt/agentoc/runtime/codex" "$STAGE/opt/agentoc/runtime/agentoc-codex-app-server"
ln -s /opt/agentoc/runtime/codex "$STAGE/usr/bin/codex"

# Prefer the official current Claude Code native package. An explicit local
# binary remains an escape hatch for offline rebuilds, but never silently
# falls back to a stale version under ~/.local/share/claude.
CLAUDE_BINARY_SOURCE="${AGENTOC_CLAUDE_BINARY_SOURCE:-}"
if [ -z "$CLAUDE_BINARY_SOURCE" ]; then
  CLAUDE_NATIVE_TARBALL="claude-code-${CLAUDE_VERSION}-linux-${NODE_ARCH}.tgz"
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
  CLAUDE_BINARY_SOURCE="$CLAUDE_EXTRACT_DIR/claude"
fi

[ -x "$CLAUDE_BINARY_SOURCE" ] || { echo "Missing Claude Code binary: $CLAUDE_BINARY_SOURCE" >&2; exit 1; }
if [ "$(head -c 2 "$CLAUDE_BINARY_SOURCE" | od -An -tx1 | tr -d ' \n')" != "7f45" ]; then
  echo "Refusing to package non-ELF Claude Code binary (likely the runtime wrapper): $CLAUDE_BINARY_SOURCE" >&2
  exit 1
fi
CLAUDE_ELF_MACHINE="$(od -An -tx1 -j18 -N2 "$CLAUDE_BINARY_SOURCE" | tr -d ' \n')"
[ "$CLAUDE_ELF_MACHINE" = "$EXPECTED_ELF_MACHINE" ] || {
  echo "Refusing to package Claude Code binary for the wrong architecture: expected $EXPECTED_ELF_MACHINE, got $CLAUDE_ELF_MACHINE" >&2
  exit 1
}
install -m 0755 "$CLAUDE_BINARY_SOURCE" "$STAGE/opt/agentoc/vendor/claude"
cat > "$STAGE/opt/agentoc/runtime/claude" <<'EOF'
#!/bin/sh
exec /opt/agentoc/vendor/claude "$@"
EOF
chmod 0755 "$STAGE/opt/agentoc/runtime/claude"
ln -s /opt/agentoc/runtime/claude "$STAGE/usr/bin/claude"
printf 'codex=%s\nclaude=%s\n' "$CODEX_VERSION" "$CLAUDE_VERSION" > "$STAGE/opt/agentoc/runtime/provider-versions"

P2P_BUILD_BINARY="$WORK_DIR/agentoc-p2p-host-$ARCH"
command -v go >/dev/null 2>&1 || {
  echo "Go toolchain is required to build the P2P host sidecar from source" >&2
  exit 1
}
(cd "$ROOT/p2p" && GOOS=linux GOARCH="$P2P_GOARCH" CGO_ENABLED=0 go build -trimpath -o "$P2P_BUILD_BINARY" ./cmd/agentoc-p2p-host)
P2P_HOST_BINARY="$P2P_BUILD_BINARY"
[ -x "$P2P_HOST_BINARY" ] || { echo "Missing P2P host sidecar: $P2P_HOST_BINARY" >&2; exit 1; }
P2P_ELF_MACHINE="$(od -An -tx1 -j18 -N2 "$P2P_HOST_BINARY" | tr -d ' \n')"
[ "$P2P_ELF_MACHINE" = "$EXPECTED_ELF_MACHINE" ] || {
  echo "Refusing to package P2P host sidecar for the wrong architecture: expected $EXPECTED_ELF_MACHINE, got $P2P_ELF_MACHINE" >&2
  exit 1
}
# Debian installs one target-architecture sidecar at the canonical path. Do
# not let a source checkout's architecture-specific helper leak into the
# package, where it could shadow the freshly built sidecar after an upgrade.
mkdir -p "$APP_DIR/bin"
rm -f "$APP_DIR/bin/agentoc-p2p-host-amd64" "$APP_DIR/bin/agentoc-p2p-host-arm64"
rm -f "$APP_DIR/bin/agentoc-p2p-host-darwin-arm64" "$APP_DIR/bin/agentoc-p2p-host-darwin-x64"
install -m 0755 "$P2P_HOST_BINARY" "$APP_DIR/bin/agentoc-p2p-host"

QRCODE_TARBALL="qrcode-terminal-${QRCODE_TERMINAL_VERSION}.tgz"
QRCODE_CACHE_PATH="$NODE_CACHE_DIR/$QRCODE_TARBALL"
if [ ! -f "$QRCODE_CACHE_PATH" ]; then
  curl -fsSL --retry 3 --connect-timeout 15 \
    "https://registry.npmjs.org/qrcode-terminal/-/$QRCODE_TARBALL" \
    -o "$QRCODE_CACHE_PATH"
fi
QRCODE_ACTUAL_SHA="$(sha256sum "$QRCODE_CACHE_PATH" | awk '{ print $1 }')"
[ "$QRCODE_TERMINAL_SHA256" = "$QRCODE_ACTUAL_SHA" ] || { echo "qrcode-terminal checksum mismatch" >&2; exit 1; }
mkdir -p "$STAGE/opt/agentoc/vendor/qrcode-terminal"
tar -xzf "$QRCODE_CACHE_PATH" -C "$STAGE/opt/agentoc/vendor/qrcode-terminal" --strip-components=1
cat > "$STAGE/opt/agentoc/runtime/qrcode-terminal" <<'EOF'
#!/bin/sh
exec /opt/agentoc/runtime/node /opt/agentoc/vendor/qrcode-terminal/bin/qrcode-terminal.js "$@"
EOF
chmod 0755 "$STAGE/opt/agentoc/runtime/qrcode-terminal"

install -m 0755 "$ROOT/packaging/deb/agentoc-wrapper" "$STAGE/usr/bin/agentoc"
install -m 0755 "$ROOT/packaging/deb/run-as-service-user" "$STAGE/usr/lib/agentoc/run-as-service-user"
install -m 0755 "$ROOT/packaging/deb/repair-state-access" "$STAGE/usr/lib/agentoc/repair-state-access"
install -m 0755 "$ROOT/packaging/deb/retire-legacy-cc-switch" "$STAGE/usr/lib/agentoc/retire-legacy-cc-switch"
install -m 0755 "$ROOT/packaging/deb/notify-exec" "$STAGE/usr/lib/agentoc/notify-exec"
PRIVILEGED_CC="${AGENTOC_PRIVILEGED_CC:-cc}"
"$PRIVILEGED_CC" -O2 -Wall -Wextra \
  "$ROOT/native/privileged-peercred.c" \
  -o "$STAGE/usr/lib/agentoc/privileged-peercred"
chmod 0755 "$STAGE/usr/lib/agentoc/privileged-peercred"
PRIVILEGED_PEERCRED_ELF_MACHINE="$(od -An -tx1 -j18 -N2 "$STAGE/usr/lib/agentoc/privileged-peercred" | tr -d ' \n')"
[ "$PRIVILEGED_PEERCRED_ELF_MACHINE" = "$EXPECTED_ELF_MACHINE" ] || {
  echo "Refusing to package privileged peercred helper for the wrong architecture: expected $EXPECTED_ELF_MACHINE, got $PRIVILEGED_PEERCRED_ELF_MACHINE" >&2
  exit 1
}
install -m 0644 "$ROOT/packaging/deb/agentoc.service" "$STAGE/lib/systemd/system/agentoc.service"
install -m 0644 "$ROOT/packaging/deb/agentoc-runner-lifecycle.service" "$STAGE/lib/systemd/system/agentoc-runner-lifecycle.service"
install -m 0644 "$ROOT/packaging/deb/agentoc-runner-supervisor.service" "$STAGE/lib/systemd/system/agentoc-runner-supervisor.service"
# P2-C: systemd socket-activation units for the runner services.
install -m 0644 "$ROOT/packaging/deb/agentoc-runner-lifecycle.socket" "$STAGE/lib/systemd/system/agentoc-runner-lifecycle.socket"
install -m 0644 "$ROOT/packaging/deb/agentoc-runner-supervisor.socket" "$STAGE/lib/systemd/system/agentoc-runner-supervisor.socket"
install -m 0644 "$ROOT/packaging/deb/agentoc-privileged-executor.service" "$STAGE/lib/systemd/system/agentoc-privileged-executor.service"
install -m 0644 "$ROOT/packaging/deb/agentoc-storage-gc.service" "$STAGE/lib/systemd/system/agentoc-storage-gc.service"
install -m 0644 "$ROOT/packaging/deb/agentoc-storage-gc.timer" "$STAGE/lib/systemd/system/agentoc-storage-gc.timer"
install -m 0640 "$ROOT/packaging/deb/agentoc.env" "$STAGE/etc/agentoc/agentoc.env"
install -m 0644 "$ROOT/packaging/deb/agentoc.desktop" "$STAGE/usr/share/applications/agentoc.desktop"
install -m 0644 "$ROOT/packaging/deb/ragent.desktop" "$STAGE/usr/share/applications/ragent.desktop"
install -m 0644 "$ROOT/static/icon-512.png" "$STAGE/usr/share/icons/hicolor/512x512/apps/agentoc.png"
install -m 0755 "$ROOT/packaging/deb/postinst" "$STAGE/DEBIAN/postinst"
install -m 0755 "$ROOT/packaging/deb/preinst" "$STAGE/DEBIAN/preinst"
install -m 0755 "$ROOT/packaging/deb/prerm" "$STAGE/DEBIAN/prerm"
install -m 0755 "$ROOT/packaging/deb/postrm" "$STAGE/DEBIAN/postrm"

if [ -n "$SIGNALING_URL" ]; then
  case "$SIGNALING_URL" in
    https://*) printf 'AGENTOC_P2P_SIGNALING_URL=%s\n' "$SIGNALING_URL" > "$STAGE/etc/agentoc/connectivity.env" ;;
    *) echo 'AGENTOC_PACKAGE_SIGNALING_URL must use https://' >&2; exit 1 ;;
  esac
fi

# Owner-auth configuration is deployment metadata, not source code. Render it
# into a separate conffile for every package so owner auth is Accounts-only by
# default. Public callback and native client values remain optional overrides.
for account_auth_url in \
  "$PACKAGE_ACCOUNTS_URL" \
  "$PACKAGE_ACCOUNTS_JWKS_URL" \
  "$PACKAGE_ACCOUNTS_ISSUER" \
  "$PACKAGE_TURN_BROKER_URL"
do
  case "$account_auth_url" in
    https://[A-Za-z0-9._/-]*) ;;
    *) echo 'Accounts package URLs must be absolute https:// URLs without shell metacharacters' >&2; exit 1 ;;
  esac
  case "$account_auth_url" in
    *[!A-Za-z0-9:/._-]*) echo 'Accounts package URLs contain unsupported characters' >&2; exit 1 ;;
  esac
done
if [ -n "$PACKAGE_PUBLIC_BASE_URL" ]; then
  case "$PACKAGE_PUBLIC_BASE_URL" in
    https://[A-Za-z0-9._/-]*) ;;
    *) echo 'AGENTOC_PACKAGE_PUBLIC_BASE_URL must be an absolute https:// URL without shell metacharacters' >&2; exit 1 ;;
  esac
  case "$PACKAGE_PUBLIC_BASE_URL" in
    *[!A-Za-z0-9:/._-]*) echo 'AGENTOC_PACKAGE_PUBLIC_BASE_URL contains unsupported characters' >&2; exit 1 ;;
  esac
fi
case "$PACKAGE_GOOGLE_NATIVE_SERVER_CLIENT_IDS" in
  *[!A-Za-z0-9.,_-]*) echo 'AGENTOC_PACKAGE_GOOGLE_NATIVE_SERVER_CLIENT_IDS contains unsupported characters' >&2; exit 1 ;;
esac

ACCOUNT_AUTH_ENV="$STAGE/etc/agentoc/account-auth.env"
{
  printf '%s\n' '# Generated at package build time; installation preserves this conffile.'
  printf 'AGENTOC_PUBLIC_BASE_URL=%s\n' "$PACKAGE_PUBLIC_BASE_URL"
  printf 'AGENTOC_ACCOUNTS_URL=%s\n' "$PACKAGE_ACCOUNTS_URL"
  printf 'AGENTOC_ACCOUNTS_JWKS_URL=%s\n' "$PACKAGE_ACCOUNTS_JWKS_URL"
  printf 'AGENTOC_ACCOUNTS_ISSUER=%s\n' "$PACKAGE_ACCOUNTS_ISSUER"
  printf 'AGENTOC_TURN_BROKER_URL=%s\n' "$PACKAGE_TURN_BROKER_URL"
  printf 'AGENTOC_GOOGLE_NATIVE_SERVER_CLIENT_IDS=%s\n' "$PACKAGE_GOOGLE_NATIVE_SERVER_CLIENT_IDS"
} > "$ACCOUNT_AUTH_ENV"
chmod 0640 "$ACCOUNT_AUTH_ENV"

cat > "$STAGE/DEBIAN/control" <<EOF
Package: agentoc
Version: $VERSION
Section: net
Priority: optional
Architecture: $ARCH
Maintainer: Ninglo
Depends: adduser, ca-certificates, util-linux, acl, libasound2t64 | libasound2, libatk-bridge2.0-0, libatk1.0-0, libatspi2.0-0, libc6, libcairo2, libcups2, libdbus-1-3, libdrm2, libexpat1, libgbm1, libglib2.0-0, libgtk-3-0, libnspr4, libnss3, libpango-1.0-0, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxkbcommon0, libxrandr2
Description: AgentoC local AI workbench with TURN-first mobile pairing
 AgentoC runs an AI automation control plane on the local machine and can
 pair through authenticated Cloudflare Realtime TURN and upgrade to LAN/P2P
 without requiring a public domain or routing application state through a
 second control plane.
EOF

cat > "$STAGE/DEBIAN/conffiles" <<EOF
/etc/agentoc/agentoc.env
EOF
if [ -f "$STAGE/etc/agentoc/connectivity.env" ]; then
  printf '/etc/agentoc/connectivity.env\n' >> "$STAGE/DEBIAN/conffiles"
fi
if [ -f "$STAGE/etc/agentoc/account-auth.env" ]; then
  printf '/etc/agentoc/account-auth.env\n' >> "$STAGE/DEBIAN/conffiles"
fi

chmod -R a+rX "$APP_DIR" "$STAGE/opt/agentoc/vendor"
find "$STAGE" -type d -exec chmod 0755 {} +
dpkg-deb --root-owner-group --build "$STAGE" "$OUTPUT" >/dev/null

DEB_CONTENTS="$WORK_DIR/deb-contents.txt"
dpkg-deb --fsys-tarfile "$OUTPUT" | tar -tf - > "$DEB_CONTENTS"
if grep -Eq '^\./opt/agentoc/app/bin/agentoc-p2p-host-(amd64|arm64)$' "$DEB_CONTENTS"; then
  echo "Built deb contains an architecture-specific P2P sidecar; only the canonical package path is allowed" >&2
  exit 1
fi
grep -Fx './opt/agentoc/app/bin/agentoc-p2p-host' "$DEB_CONTENTS" >/dev/null || {
  echo "Built deb is missing the canonical P2P host sidecar" >&2
  exit 1
}
while IFS= read -r package_name; do
  [ -n "$package_name" ] || continue
  expected_path="./opt/agentoc/app/node_modules/$package_name/package.json"
  if ! grep -Fx "$expected_path" "$DEB_CONTENTS" >/dev/null; then
    echo "Built deb is missing production dependency: $package_name" >&2
    exit 1
  fi
done < "$PROD_DIRECT_DEPENDENCY_LIST"

mv -f "$OUTPUT" "$FINAL_OUTPUT"
printf '%s\n' "$FINAL_OUTPUT"
