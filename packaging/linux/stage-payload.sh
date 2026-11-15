# Shared Linux payload staging. Sourced by the native package builders.
PACK_JSON_FILE="$WORK_DIR/npm-pack-result.json"
(cd "$ROOT" && npm pack --json --pack-destination "$WORK_DIR" > "$PACK_JSON_FILE")
PACK_FILE="$(node -e 'const value=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(value[0].filename)' "$PACK_JSON_FILE")"
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
printf '%s\n' "$VERSION" > "$APP_DIR/.ragent-package-version"
printf '%s\n' "${BUILD_VERSION%%+*}" > "$APP_DIR/.ragent-package-build"
if [ "$DEV_MODE" = 1 ]; then
  rm -f "$APP_DIR/.ragent-source-commit"
  printf '%s\n' "$DEV_SHA" > "$APP_DIR/.ragent-development-snapshot-sha256"
else
  printf '%s\n' "$SOURCE_COMMIT" > "$APP_DIR/.ragent-source-commit"
fi

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
if [ "$ARCH" != "$HOST_ARCH" ]; then
  echo 'The desktop manager requires a native-architecture Linux build host.' >&2
  exit 1
fi
DESKTOP_BUILD="$WORK_DIR/desktop-build"
DESKTOP_ROOT="$STAGE/opt/ragent/Desktop"
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
for name in main.cjs preload.cjs update-check.cjs auto-update.cjs update-linux.sh update-macos.sh update-windows.ps1 wait.html; do
  install -m 0644 "$ROOT/desktop/$name" "$DESKTOP_APP/$name"
done
chmod 0755 "$DESKTOP_APP/update-linux.sh"
install -m 0644 "$ROOT/static/desktop/ragent-android-logo.png" "$DESKTOP_APP/assets/ragent-android-logo.png"
install -m 0644 "$ROOT/static/icon-512.png" "$DESKTOP_APP/assets/ragent-icon.png"
DESKTOP_VERSION="$(node -p "require('$ROOT/desktop/package.json').version")"
printf '{"name":"ragent-desktop-manager","version":"%s","private":true,"main":"main.cjs"}\n' "$DESKTOP_VERSION" > "$DESKTOP_APP/package.json"
# Chromium's setuid helper is installed root-owned by dpkg; the renderer still
# uses Electron's sandbox and must not fall back to --no-sandbox.
# Electron resources must be readable by the desktop user even when the
# package builder has a restrictive umask. Preserve executable bits.
chmod -R a+rX "$DESKTOP_ROOT"
find "$DESKTOP_ROOT" -type d -exec chmod 0755 {} +
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
cp "$WORK_DIR/$NODE_DIST/bin/node" "$STAGE/opt/ragent/runtime/node"
chmod 0755 "$STAGE/opt/ragent/runtime/node" "$APP_DIR/cli.js"
bash "$ROOT/scripts/stage-posix-node-toolchain.sh" "$WORK_DIR/$NODE_DIST" "$STAGE/opt/ragent/runtime"

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
mkdir -p "$STAGE/opt/ragent/vendor/codex"
tar -xzf "$CODEX_MAIN_CACHE_PATH" -C "$STAGE/opt/ragent/vendor/codex" --strip-components=1

# The current Codex package publishes platform executables as package aliases
# of the same release (`@openai/codex@<version>-linux-<arch>`). Keep the
# optional-dependency directory name expected by bin/codex.js while verifying
# the registry's sha512 SRI for the exact native artifact.
CODEX_NATIVE_VERSION="$CODEX_VERSION-$CODEX_NATIVE_TARGET"
CODEX_NATIVE_TARBALL="codex-${CODEX_NATIVE_VERSION}.tgz"
CODEX_NATIVE_CACHE_PATH="$NODE_CACHE_DIR/$CODEX_NATIVE_TARBALL"
download_npm_package "@openai/codex@$CODEX_NATIVE_VERSION" "$CODEX_NATIVE_CACHE_PATH" "Codex native engine $CODEX_NATIVE_VERSION"
mkdir -p "$STAGE/opt/ragent/vendor/codex/node_modules/$CODEX_NATIVE_PACKAGE"
tar -xzf "$CODEX_NATIVE_CACHE_PATH" \
  -C "$STAGE/opt/ragent/vendor/codex/node_modules/$CODEX_NATIVE_PACKAGE" \
  --strip-components=1
cat > "$STAGE/opt/ragent/runtime/codex" <<'EOF'
#!/bin/sh
exec /opt/ragent/runtime/node /opt/ragent/vendor/codex/bin/codex.js "$@"
EOF
cat > "$STAGE/opt/ragent/runtime/ragent-codex-app-server" <<'EOF'
#!/bin/sh
exec /opt/ragent/runtime/node /opt/ragent/vendor/codex/bin/codex.js "$@"
EOF
chmod 0755 "$STAGE/opt/ragent/runtime/codex" "$STAGE/opt/ragent/runtime/ragent-codex-app-server"

# Prefer the official current Claude Code native package. An explicit local
# binary remains an escape hatch for offline rebuilds, but never silently
# falls back to a stale version under ~/.local/share/claude.
CLAUDE_BINARY_SOURCE="${RAGENT_CLAUDE_BINARY_SOURCE:-}"
CLAUDE_LICENSE_SOURCE="${RAGENT_CLAUDE_LICENSE_SOURCE:-}"
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
  CLAUDE_LICENSE_SOURCE="$CLAUDE_EXTRACT_DIR/LICENSE.md"
else
  # An offline override must be attributable and accompanied by its license.
  CLAUDE_EXPECTED_SHA="${RAGENT_CLAUDE_BINARY_SHA256:-}"
  [[ "$CLAUDE_EXPECTED_SHA" =~ ^[a-f0-9]{64}$ ]] || { echo 'Offline Claude binary requires RAGENT_CLAUDE_BINARY_SHA256.' >&2; exit 1; }
  [ -f "$CLAUDE_BINARY_SOURCE" ] || { echo 'Offline Claude binary is missing.' >&2; exit 1; }
  [ "$(sha256sum "$CLAUDE_BINARY_SOURCE" | awk '{print $1}')" = "$CLAUDE_EXPECTED_SHA" ] || { echo 'Offline Claude binary checksum mismatch.' >&2; exit 1; }
fi

[ -s "$CLAUDE_LICENSE_SOURCE" ] || { echo 'Claude Code license is missing.' >&2; exit 1; }
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
install -m 0755 "$CLAUDE_BINARY_SOURCE" "$STAGE/opt/ragent/vendor/claude"
mkdir -p "$STAGE/opt/ragent/vendor/licenses/claude-code"
install -m 0644 "$CLAUDE_LICENSE_SOURCE" "$STAGE/opt/ragent/vendor/licenses/claude-code/LICENSE.md"
CLAUDE_BINARY_SHA="$(sha256sum "$STAGE/opt/ragent/vendor/claude" | awk '{print $1}')"
cat > "$STAGE/opt/ragent/runtime/claude" <<'EOF'
#!/bin/sh
exec /opt/ragent/vendor/claude "$@"
EOF
chmod 0755 "$STAGE/opt/ragent/runtime/claude"
printf 'codex=%s\nclaude=%s\nclaude_sha256=%s\n' "$CODEX_VERSION" "$CLAUDE_VERSION" "$CLAUDE_BINARY_SHA" > "$STAGE/opt/ragent/runtime/provider-versions"

P2P_BUILD_BINARY="$WORK_DIR/ragent-p2p-host-$ARCH"
command -v go >/dev/null 2>&1 || {
  echo "Go toolchain is required to build the P2P host sidecar from source" >&2
  exit 1
}
if [ "$DEV_MODE" = 1 ]; then
  (cd "$ROOT/p2p" && GOOS=linux GOARCH="$P2P_GOARCH" CGO_ENABLED=0 go build -buildvcs=false -trimpath -o "$P2P_BUILD_BINARY" ./cmd/ragent-p2p-host)
else
  (cd "$ROOT/p2p" && GOOS=linux GOARCH="$P2P_GOARCH" CGO_ENABLED=0 go build -trimpath -o "$P2P_BUILD_BINARY" ./cmd/ragent-p2p-host)
fi
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
rm -f "$APP_DIR/bin/ragent-p2p-host-amd64" "$APP_DIR/bin/ragent-p2p-host-arm64"
rm -f "$APP_DIR/bin/ragent-p2p-host-darwin-arm64" "$APP_DIR/bin/ragent-p2p-host-darwin-x64"
rm -f "$APP_DIR/bin/ragent-p2p-host" "$APP_DIR/bin/ragent-p2p-host.exe"
install -m 0755 "$P2P_HOST_BINARY" "$APP_DIR/bin/ragent-p2p-host"
QRCODE_TARBALL="qrcode-terminal-${QRCODE_TERMINAL_VERSION}.tgz"
QRCODE_CACHE_PATH="$NODE_CACHE_DIR/$QRCODE_TARBALL"
if [ ! -f "$QRCODE_CACHE_PATH" ]; then
  curl -fsSL --retry 3 --connect-timeout 15 \
    "https://registry.npmjs.org/qrcode-terminal/-/$QRCODE_TARBALL" \
    -o "$QRCODE_CACHE_PATH"
fi
QRCODE_ACTUAL_SHA="$(sha256sum "$QRCODE_CACHE_PATH" | awk '{ print $1 }')"
[ "$QRCODE_TERMINAL_SHA256" = "$QRCODE_ACTUAL_SHA" ] || { echo "qrcode-terminal checksum mismatch" >&2; exit 1; }
mkdir -p "$STAGE/opt/ragent/vendor/qrcode-terminal"
tar -xzf "$QRCODE_CACHE_PATH" -C "$STAGE/opt/ragent/vendor/qrcode-terminal" --strip-components=1
cat > "$STAGE/opt/ragent/runtime/qrcode-terminal" <<'EOF'
#!/bin/sh
exec /opt/ragent/runtime/node /opt/ragent/vendor/qrcode-terminal/bin/qrcode-terminal.js "$@"
EOF
chmod 0755 "$STAGE/opt/ragent/runtime/qrcode-terminal"

install -m 0755 "$ROOT/packaging/deb/ragent-wrapper" "$STAGE/usr/bin/ragent"
install -m 0755 "$ROOT/packaging/deb/run-as-service-user" "$STAGE/usr/lib/ragent/run-as-service-user"
install -m 0755 "$ROOT/packaging/deb/repair-state-access" "$STAGE/usr/lib/ragent/repair-state-access"
install -m 0755 "$ROOT/packaging/deb/retire-legacy-cc-switch" "$STAGE/usr/lib/ragent/retire-legacy-cc-switch"
install -m 0755 "$ROOT/packaging/deb/notify-exec" "$STAGE/usr/lib/ragent/notify-exec"
install -m 0644 "$ROOT/packaging/deb/socket-paths.env" "$STAGE/usr/lib/ragent/socket-paths.env"
PRIVILEGED_CC="${RAGENT_PRIVILEGED_CC:-cc}"
"$PRIVILEGED_CC" -O2 -Wall -Wextra \
  "$ROOT/native/privileged-peercred.c" \
  -o "$STAGE/usr/lib/ragent/privileged-peercred"
chmod 0755 "$STAGE/usr/lib/ragent/privileged-peercred"
PRIVILEGED_PEERCRED_ELF_MACHINE="$(od -An -tx1 -j18 -N2 "$STAGE/usr/lib/ragent/privileged-peercred" | tr -d ' \n')"
[ "$PRIVILEGED_PEERCRED_ELF_MACHINE" = "$EXPECTED_ELF_MACHINE" ] || {
  echo "Refusing to package privileged peercred helper for the wrong architecture: expected $EXPECTED_ELF_MACHINE, got $PRIVILEGED_PEERCRED_ELF_MACHINE" >&2
  exit 1
}
install -m 0644 "$ROOT/packaging/deb/ragent.service" "$STAGE/lib/systemd/system/ragent.service"
install -m 0644 "$ROOT/packaging/deb/ragent-runner-lifecycle.service" "$STAGE/lib/systemd/system/ragent-runner-lifecycle.service"
install -m 0644 "$ROOT/packaging/deb/ragent-runner-supervisor.service" "$STAGE/lib/systemd/system/ragent-runner-supervisor.service"
# P2-C: systemd socket-activation units for the runner services.
install -m 0644 "$ROOT/packaging/deb/ragent-runner-lifecycle.socket" "$STAGE/lib/systemd/system/ragent-runner-lifecycle.socket"
install -m 0644 "$ROOT/packaging/deb/ragent-runner-supervisor.socket" "$STAGE/lib/systemd/system/ragent-runner-supervisor.socket"
# Installed for later integration, but deliberately not enabled by postinst.
install -m 0644 "$ROOT/packaging/deb/ragent-peer-result.socket" "$STAGE/lib/systemd/system/ragent-peer-result.socket"
install -m 0644 "$ROOT/packaging/deb/ragent-peer-result.service" "$STAGE/lib/systemd/system/ragent-peer-result.service"
install -m 0644 "$ROOT/packaging/deb/ragent-privileged-executor.service" "$STAGE/lib/systemd/system/ragent-privileged-executor.service"
install -m 0644 "$ROOT/packaging/deb/ragent-storage-gc.service" "$STAGE/lib/systemd/system/ragent-storage-gc.service"
install -m 0644 "$ROOT/packaging/deb/ragent-storage-gc.timer" "$STAGE/lib/systemd/system/ragent-storage-gc.timer"
install -m 0640 "$ROOT/packaging/deb/ragent.env" "$STAGE/etc/ragent/ragent.env"
install -m 0644 "$ROOT/packaging/deb/ragent.desktop" "$STAGE/usr/share/applications/ragent.desktop"
install -m 0644 "$ROOT/static/icon-512.png" "$STAGE/usr/share/icons/hicolor/512x512/apps/ragent.png"

if [ -n "$SIGNALING_URL" ]; then
  case "$SIGNALING_URL" in
    https://*) printf 'RAGENT_P2P_SIGNALING_URL=%s\n' "$SIGNALING_URL" > "$STAGE/etc/ragent/connectivity.env" ;;
    *) echo 'RAGENT_PACKAGE_SIGNALING_URL must use https://' >&2; exit 1 ;;
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
    *) echo 'RAGENT_PACKAGE_PUBLIC_BASE_URL must be an absolute https:// URL without shell metacharacters' >&2; exit 1 ;;
  esac
  case "$PACKAGE_PUBLIC_BASE_URL" in
    *[!A-Za-z0-9:/._-]*) echo 'RAGENT_PACKAGE_PUBLIC_BASE_URL contains unsupported characters' >&2; exit 1 ;;
  esac
fi
case "$PACKAGE_GOOGLE_NATIVE_SERVER_CLIENT_IDS" in
  *[!A-Za-z0-9.,_-]*) echo 'RAGENT_PACKAGE_GOOGLE_NATIVE_SERVER_CLIENT_IDS contains unsupported characters' >&2; exit 1 ;;
esac

ACCOUNT_AUTH_ENV="$STAGE/etc/ragent/account-auth.env"
{
  printf '%s\n' '# Generated at package build time; installation preserves this conffile.'
  printf 'RAGENT_PUBLIC_BASE_URL=%s\n' "$PACKAGE_PUBLIC_BASE_URL"
  printf 'RAGENT_ACCOUNTS_URL=%s\n' "$PACKAGE_ACCOUNTS_URL"
  printf 'RAGENT_ACCOUNTS_JWKS_URL=%s\n' "$PACKAGE_ACCOUNTS_JWKS_URL"
  printf 'RAGENT_ACCOUNTS_ISSUER=%s\n' "$PACKAGE_ACCOUNTS_ISSUER"
  printf 'RAGENT_TURN_BROKER_URL=%s\n' "$PACKAGE_TURN_BROKER_URL"
  printf 'RAGENT_GOOGLE_NATIVE_SERVER_CLIENT_IDS=%s\n' "$PACKAGE_GOOGLE_NATIVE_SERVER_CLIENT_IDS"
} > "$ACCOUNT_AUTH_ENV"
chmod 0640 "$ACCOUNT_AUTH_ENV"


# Refuse a package whose bundled ELF objects require a newer libc than the
# common supported baseline. This also catches helpers built on newer hosts.
command -v readelf >/dev/null || { echo 'readelf is required to verify the glibc baseline.' >&2; exit 1; }
node --input-type=module - "$STAGE" <<'NODE'
import { closeSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.argv[2];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = lstatSync(path);
    if (st.isDirectory()) { walk(path); continue; }
    if (!st.isFile()) continue;
    const fd = openSync(path, 'r');
    const magic = Buffer.alloc(4);
    try { if (readSync(fd, magic, 0, 4, 0) !== 4) continue; }
    finally { closeSync(fd); }
    if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) continue;
    const result = spawnSync('readelf', ['--version-info', path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`Cannot inspect ELF: ${path}`);
    for (const match of result.stdout.matchAll(/GLIBC_(\d+)\.(\d+)(?:\.(\d+))?/g)) {
      const major = Number(match[1]), minor = Number(match[2]);
      if (major > 2 || (major === 2 && minor > 34)) {
        throw new Error(`${path} requires GLIBC_${major}.${minor}, newer than 2.34`);
      }
    }
  }
}
walk(root);
NODE