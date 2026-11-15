#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# A source archive's commit marker alone does not prove its contents. For
# archive builds, require the committed Git objects and stage a fresh,
# allowlisted source tree; this does not create a Git worktree.
PACKAGE_FORMAT="${RAGENT_LINUX_PACKAGE_FORMAT:-deb}"
case "$PACKAGE_FORMAT" in deb|rpm) ;; *) echo "Unsupported Linux package format" >&2; exit 1 ;; esac
SOURCE_GIT_DIR="${RAGENT_SOURCE_GIT_DIR:-}"
FROZEN_WORK_DIR=''
DEV_ARCHIVE="${RAGENT_DEV_SNAPSHOT_ARCHIVE:-}"
DEV_SHA="${RAGENT_DEV_SNAPSHOT_SHA256:-}"
DEV_MODE=0
if [ -n "$DEV_ARCHIVE" ] || [ -n "$DEV_SHA" ]; then
  [ -n "$DEV_ARCHIVE" ] && [[ "$DEV_SHA" =~ ^[a-f0-9]{64}$ ]] && [ -z "$SOURCE_GIT_DIR" ] || {
    echo 'Development builds require an archive and its full SHA256, without a frozen Git source.' >&2; exit 1;
  }
  [ -z "${RAGENT_PACKAGE_VERSION:-}${RAGENT_PACKAGE_BUILD_VERSION:-}" ] || {
    echo 'Development snapshot versions cannot be overridden.' >&2; exit 1;
  }
  [ -n "${RAGENT_DEB_OUTPUT_DIR:-}" ] || { echo 'Development builds require an explicit output directory.' >&2; exit 1; }
  command -v python3 >/dev/null || { echo 'Development snapshot builds require python3.' >&2; exit 1; }
  DEV_ARCHIVE="$(cd "$(dirname "$DEV_ARCHIVE")" && pwd -P)/$(basename "$DEV_ARCHIVE")"
  FROZEN_WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ragent-dev-source.XXXXXX")"
  trap 'rm -rf "$FROZEN_WORK_DIR"' EXIT
  cp -- "$DEV_ARCHIVE" "$FROZEN_WORK_DIR/snapshot.tar"
  DEV_ARCHIVE="$FROZEN_WORK_DIR/snapshot.tar"
  [ "$(sha256sum "$DEV_ARCHIVE" | awk '{print $1}')" = "$DEV_SHA" ] || { echo 'Development snapshot SHA256 mismatch.' >&2; exit 1; }
  mkdir -m 0700 "$FROZEN_WORK_DIR/source"
  python3 - "$DEV_ARCHIVE" "$FROZEN_WORK_DIR/source" <<'PYDEV'
import os, pathlib, re, shutil, sys, tarfile
root = pathlib.Path(sys.argv[2])
seen = set()
with tarfile.open(sys.argv[1], 'r:*') as archive:
    for member in archive:
        name = member.name
        if not member.isfile() or not re.fullmatch(r'[A-Za-z0-9_@+.,/-]+', name) or any(p in ('', '.', '..') for p in name.split('/')) or name in seen:
            raise SystemExit('Invalid or duplicate development snapshot entry: ' + repr(name))
        seen.add(name)
        target = root.joinpath(*name.split('/'))
        target.parent.mkdir(parents=True, exist_ok=True)
        with archive.extractfile(member) as source, target.open('xb') as destination:
            shutil.copyfileobj(source, destination)
        os.chmod(target, member.mode & 0o755)
PYDEV
  cmp -s "$ROOT/scripts/build-deb.sh" "$FROZEN_WORK_DIR/source/scripts/build-deb.sh" || {
    echo 'Development snapshot build script differs from the executing script.' >&2; exit 1;
  }
  ROOT="$FROZEN_WORK_DIR/source"
  DEV_MODE=1
fi
if [ "$DEV_MODE" = 1 ]; then
  :
elif [ -n "$SOURCE_GIT_DIR" ]; then
  SOURCE_GIT_DIR="$(cd "$SOURCE_GIT_DIR" && pwd -P)"
  export GIT_NO_REPLACE_OBJECTS=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
  [ ! -e "$SOURCE_GIT_DIR/objects/info/alternates" ] &&
    [ ! -e "$SOURCE_GIT_DIR/objects/info/http-alternates" ] || {
      echo 'Frozen source Git directory must not use alternate object stores.' >&2; exit 1;
    }
  [ "$(git -C "$SOURCE_GIT_DIR" rev-parse --is-bare-repository)" = true ] || {
    echo 'Frozen source Git directory must be bare.' >&2; exit 1;
  }
  SOURCE_COMMIT="${RAGENT_SOURCE_COMMIT:-}"
  [[ "$SOURCE_COMMIT" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ ]] &&
    [ "$(git -C "$SOURCE_GIT_DIR" rev-parse --verify HEAD)" = "$SOURCE_COMMIT" ] || {
      echo 'Frozen source requires the expected full commit ID at bare HEAD.' >&2; exit 1;
    }
  FROZEN_WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ragent-deb-source.XXXXXX")"
  trap 'rm -rf "$FROZEN_WORK_DIR"' EXIT
  for input in scripts/build-deb.sh scripts/build-rpm.sh packaging/linux/stage-payload.sh scripts/stage-runtime-payload.mjs scripts/verify-runtime-payload.mjs; do
    git -C "$SOURCE_GIT_DIR" show "$SOURCE_COMMIT:$input" > "$FROZEN_WORK_DIR/bootstrap-input" || exit 1
    cmp -s "$ROOT/$input" "$FROZEN_WORK_DIR/bootstrap-input" || {
      echo "Frozen source bootstrap differs from the specified commit: $input" >&2; exit 1;
    }
  done
  node "$ROOT/scripts/stage-runtime-payload.mjs" --source "$SOURCE_GIT_DIR" \
    --destination "$FROZEN_WORK_DIR/source" --profile desktop --source-mode git-objects
  ROOT="$FROZEN_WORK_DIR/source"
  [ "$(cat "$ROOT/.ragent-source-commit")" = "$SOURCE_COMMIT" ] || {
    echo 'Frozen source staging returned a different commit.' >&2; exit 1;
  }
  FROZEN_MANIFEST_SHA="$(sha256sum "$ROOT/runtime-payload-manifest.json" | awk '{print $1}')"
elif [ ! -e "$ROOT/.git" ]; then
  echo 'A source archive requires RAGENT_SOURCE_GIT_DIR and RAGENT_SOURCE_COMMIT.' >&2
  exit 1
fi

# DS-01 parity preflight (off by default; enable with RAGENT_PARITY_GATE=1).
# Compares the source tree against itself: fails on uncommitted changes to
# shipped artifacts or drift from the recorded package manifest. Never touches
# the installed root or any running service.
if [ "${RAGENT_PARITY_GATE:-0}" = "1" ]; then
  node "$ROOT/scripts/verify-source-parity.mjs" \
    --source "$ROOT" --install "$ROOT" --live-url none >/dev/null || {
    echo "Parity preflight failed (dirty source or package-manifest drift); refusing to package." >&2
    exit 1
  }
fi

if [ "$PACKAGE_FORMAT" = rpm ]; then
  [ "$(uname -m)" = x86_64 ] || { echo 'RPM candidate requires a native x86_64 build host.' >&2; exit 1; }
  HOST_ARCH=amd64
else
  HOST_ARCH="$(dpkg --print-architecture)"
fi
ARCH="${RAGENT_PACKAGE_ARCH:-$HOST_ARCH}"
PACKAGE_NAME="${RAGENT_DEB_PACKAGE_NAME:-ragent}"
case "$PACKAGE_NAME" in ragent) ;; *) echo 'Invalid Debian package name.' >&2; exit 1 ;; esac
OUTPUT_DIR="${RAGENT_DEB_OUTPUT_DIR:-/srv/ragent-promoted-data/workspace/releases}"
if [ "$PACKAGE_FORMAT" = rpm ]; then OUTPUT_DIR="${RAGENT_RPM_OUTPUT_DIR:-$OUTPUT_DIR}"; fi
SIGNALING_URL="${RAGENT_PACKAGE_SIGNALING_URL:-}"
PACKAGE_PUBLIC_BASE_URL="${RAGENT_PACKAGE_PUBLIC_BASE_URL:-https://app.agentoncloud.com}"
PACKAGE_ACCOUNTS_URL="${RAGENT_PACKAGE_ACCOUNTS_URL:-https://ragent.agentoncloud.com/accounts}"
PACKAGE_ACCOUNTS_JWKS_URL="${RAGENT_PACKAGE_ACCOUNTS_JWKS_URL:-https://ragent.agentoncloud.com/accounts/.well-known/jwks.json}"
PACKAGE_ACCOUNTS_ISSUER="${RAGENT_PACKAGE_ACCOUNTS_ISSUER:-https://ragent.agentoncloud.com}"
PACKAGE_TURN_BROKER_URL="${RAGENT_PACKAGE_TURN_BROKER_URL:-https://ragent.agentoncloud.com/turn}"
PACKAGE_GOOGLE_NATIVE_SERVER_CLIENT_IDS="${RAGENT_PACKAGE_GOOGLE_NATIVE_SERVER_CLIENT_IDS:-}"

# Auto-version: resolve a version strictly higher than the highest version this
# host already knows about (installed package + previously built debs in
# OUTPUT_DIR, or an explicit RAGENT_ONLINE_VERSION seed). RAGENT_PACKAGE_VERSION
# keeps its old meaning as a manual override.
resolve_package_version() {
  local pkg_version best candidate name package
  pkg_version="$(node -p "require('$ROOT/package.json').version")"
  best="${RAGENT_ONLINE_VERSION:-}"

  if command -v dpkg-query >/dev/null 2>&1; then
    for package in ragent; do
      candidate="$(dpkg-query -W -f='${Version}' "$package" 2>/dev/null || true)"
      if [ -n "$candidate" ]; then
        if [ -z "$best" ] || dpkg --compare-versions "$candidate" gt "$best"; then
          best="$candidate"
        fi
      fi
    done
  fi

  for name in "$OUTPUT_DIR"/ragent_*_"$ARCH".deb; do
    [ -e "$name" ] || continue
    candidate="$(basename "$name")"
    candidate="${candidate#ragent_}"
    candidate="${candidate%_${ARCH}.deb}"
    if [ -z "$best" ] || dpkg --compare-versions "$candidate" gt "$best"; then
      best="$candidate"
    fi
  done

  local source_commit
  source_commit="$(git -C "$ROOT" rev-parse --short=8 HEAD 2>/dev/null || true)"
  if [ -z "$source_commit" ] && [ -f "$ROOT/.ragent-source-commit" ]; then
    source_commit="$(cut -c1-8 "$ROOT/.ragent-source-commit")"
  fi

  if [ -n "$best" ]; then
    local upstream major minor patch
    upstream="${best%%+*}"
    IFS='.' read -r major minor patch <<< "$upstream"
    if ! [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ && "$patch" =~ ^[0-9]+$ ]]; then
      echo "Cannot parse online version '$best'; set RAGENT_PACKAGE_VERSION explicitly" >&2
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

if [ "$DEV_MODE" = 1 ]; then
  base_version="$(node -p "require('$ROOT/package.json').version")"
  [[ "$base_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid development base version.' >&2; exit 1; }
  VERSION="${base_version}~dev.${DEV_SHA:0:16}"
elif [ "$PACKAGE_FORMAT" = rpm ] && [ -z "${RAGENT_PACKAGE_VERSION:-}" ]; then
  echo "RPM builds require RAGENT_PACKAGE_VERSION (public version)." >&2; exit 1
elif [ -n "${RAGENT_PACKAGE_VERSION:-}" ]; then
  VERSION="$RAGENT_PACKAGE_VERSION"
else
  VERSION="$(resolve_package_version)"
fi
BUILD_VERSION="${RAGENT_PACKAGE_BUILD_VERSION:-$VERSION}"
if [ -n "${RAGENT_PACKAGE_BUILD_VERSION:-}" ] && ! [[ "$BUILD_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo 'Internal build version must have three numeric components.' >&2; exit 1
fi
if [ "${RAGENT_PRINT_VERSION_ONLY:-0}" = "1" ]; then
  printf '%s\n' "$VERSION"
  exit 0
fi
NODE_VERSION="${RAGENT_NODE_VERSION:-v24.12.0}"
[[ "$NODE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ -s "$ROOT/third_party_licenses/node/${NODE_VERSION}-LICENSE.txt" ] || {
  echo 'Bundled Node version requires its matching third-party license notice.' >&2
  exit 1
}
NODE_CACHE_DIR="${RAGENT_NODE_CACHE_DIR:-/srv/ragent-promoted-data/workspace/cache/node}"
NPM_REGISTRY="${RAGENT_NPM_REGISTRY:-https://registry.npmjs.org}"
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
    P2P_HOST_BINARY="$ROOT/bin/ragent-p2p-host"
    EXPECTED_ELF_MACHINE=b700
    ;;
  amd64)
    NODE_ARCH=x64
    P2P_GOARCH=amd64
    CODEX_NATIVE_TARGET=linux-x64
    CODEX_NATIVE_PACKAGE='@openai/codex-linux-x64'
    CLAUDE_NATIVE_PACKAGE='@anthropic-ai/claude-code-linux-x64'
    P2P_HOST_BINARY="$ROOT/bin/ragent-p2p-host-amd64"
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
CODEX_VERSION="$(resolve_npm_version '@openai/codex' "${RAGENT_CODEX_VERSION:-$CODEX_ADAPTER_TARGET_VERSION}")"
CLAUDE_VERSION="$(resolve_npm_version '@anthropic-ai/claude-code' "${RAGENT_CLAUDE_VERSION:-$CLAUDE_ADAPTER_TARGET_VERSION}")"
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
  echo "Codex $CODEX_VERSION is outside the validated Ragent adapter range." >&2
  exit 1
fi
CLAUDE_ADAPTER_COMPATIBLE="$(node --input-type=module -e \
  'import(process.argv[1]).then((m) => process.stdout.write(m.isAdapterCompatible("claude", process.argv[2]) ? "yes" : "no"))' \
  "$ROOT/chat/harness-compatibility.mjs" "$CLAUDE_VERSION")"
if [ "$CLAUDE_ADAPTER_COMPATIBLE" != "yes" ]; then
  echo "Claude Code $CLAUDE_VERSION is outside the validated Ragent adapter range." >&2
  exit 1
fi
printf 'Bundling Codex %s and Claude Code %s from %s\n' "$CODEX_VERSION" "$CLAUDE_VERSION" "$NPM_REGISTRY"

# Do not attribute a package built from a dirty tree to a clean commit. A
# frozen runtime payload produced by stage-runtime-payload has no .git but
# carries the full source identity in its own manifest.
if [ "$DEV_MODE" = 1 ]; then
  SOURCE_COMMIT=''
elif [ -e "$ROOT/.git" ]; then
  SOURCE_STATUS="$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)" || {
    echo 'Unable to verify Debian source tree status.' >&2; exit 1;
  }
  [ -z "$SOURCE_STATUS" ] || {
    echo 'Debian packaging requires a clean committed source tree.' >&2; exit 1;
  }
  SOURCE_COMMIT="$(git -C "$ROOT" rev-parse --verify HEAD)"
else
  SOURCE_COMMIT="$(cat "$ROOT/.ragent-source-commit" 2>/dev/null || true)"
fi
if [ "$DEV_MODE" != 1 ]; then
  [[ "$SOURCE_COMMIT" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ ]] || {
    echo 'A full committed source identity is required for Debian packaging.' >&2; exit 1;
  }
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ragent-deb.XXXXXX")"
STAGE="$WORK_DIR/stage"
APP_DIR="$STAGE/opt/ragent/app"
OUTPUT_NAME="${PACKAGE_NAME}_${VERSION}_${ARCH}.deb"
OUTPUT="$WORK_DIR/$OUTPUT_NAME"
if [ "$PACKAGE_FORMAT" = rpm ]; then
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$BUILD_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "RPM versions must be numeric x.y.z." >&2; exit 1; }
  OUTPUT_NAME="Ragent-${VERSION}-rhel9-x86_64.rpm"
  OUTPUT="$WORK_DIR/$OUTPUT_NAME"
fi
FINAL_OUTPUT="$OUTPUT_DIR/$OUTPUT_NAME"

cleanup() {
  rm -rf "$WORK_DIR"
  if [ -n "$FROZEN_WORK_DIR" ]; then rm -rf "$FROZEN_WORK_DIR"; fi
}
trap cleanup EXIT

mkdir -p "$APP_DIR" "$STAGE/opt/ragent/runtime" "$STAGE/usr/bin" "$STAGE/usr/sbin" "$STAGE/usr/lib/ragent"
mkdir -p "$STAGE/opt/ragent/vendor"
mkdir -p "$STAGE/lib/systemd/system" "$STAGE/etc/ragent" "$STAGE/usr/share/applications"
mkdir -p "$STAGE/usr/share/icons/hicolor/512x512/apps" "$STAGE/DEBIAN" "$OUTPUT_DIR"
if [ ! -w "$OUTPUT_DIR" ]; then
  echo "Package output directory is not writable: $OUTPUT_DIR. Set RAGENT_DEB_OUTPUT_DIR or repair its ownership." >&2
  exit 1
fi
if [ ! -w "$NODE_CACHE_DIR" ]; then
  echo "Package cache is not writable: $NODE_CACHE_DIR. Set RAGENT_NODE_CACHE_DIR or repair its ownership." >&2
  exit 1
fi

# Both native package formats consume the same staged Linux payload.
. "$ROOT/packaging/linux/stage-payload.sh"

if [ "$PACKAGE_FORMAT" = deb ]; then
install -m 0755 "$ROOT/packaging/deb/postinst" "$STAGE/DEBIAN/postinst"
install -m 0755 "$ROOT/packaging/deb/preinst" "$STAGE/DEBIAN/preinst"
install -m 0755 "$ROOT/packaging/deb/prerm" "$STAGE/DEBIAN/prerm"
install -m 0755 "$ROOT/packaging/deb/postrm" "$STAGE/DEBIAN/postrm"
cat > "$STAGE/DEBIAN/control" <<EOF
Package: $PACKAGE_NAME
Version: $BUILD_VERSION
Section: net
Priority: optional
Architecture: $ARCH
Maintainer: Ninglo
Depends: adduser, ca-certificates, util-linux, acl, procps, openssl, python3, systemd, pkexec | policykit-1, libasound2t64 | libasound2, libatk-bridge2.0-0, libatk1.0-0, libatspi2.0-0, libc6 (>= 2.34), libcairo2, libcups2, libdbus-1-3, libdrm2, libexpat1, libgbm1, libglib2.0-0, libgtk-3-0, libnspr4, libnss3, libpango-1.0-0, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxkbcommon0, libxrandr2
Description: Ragent local AI workbench with TURN-first mobile pairing
 Ragent runs an AI automation control plane on the local machine and can
 pair through authenticated Cloudflare Realtime TURN and upgrade to LAN/P2P
 without requiring a public domain or routing application state through a
 second control plane.
EOF

if [ "$DEV_MODE" = 1 ]; then
  printf 'X-Ragent-Development-Snapshot-SHA256: %s\n' "$DEV_SHA" >> "$STAGE/DEBIAN/control"
fi

cat > "$STAGE/DEBIAN/conffiles" <<EOF
/etc/ragent/ragent.env
EOF
if [ -f "$STAGE/etc/ragent/connectivity.env" ]; then
  printf '/etc/ragent/connectivity.env\n' >> "$STAGE/DEBIAN/conffiles"
fi
if [ -f "$STAGE/etc/ragent/account-auth.env" ]; then
  printf '/etc/ragent/account-auth.env\n' >> "$STAGE/DEBIAN/conffiles"
fi

chmod -R a+rX "$APP_DIR" "$STAGE/opt/ragent/vendor"
find "$STAGE" -type d -exec chmod 0755 {} +
dpkg-deb --root-owner-group --build "$STAGE" "$OUTPUT" >/dev/null

DEB_CONTENTS="$WORK_DIR/deb-contents.txt"
dpkg-deb --fsys-tarfile "$OUTPUT" | tar -tf - > "$DEB_CONTENTS"
if grep -Eq '^\./opt/ragent/app/bin/ragent-p2p-host-(amd64|arm64)$' "$DEB_CONTENTS"; then
  echo "Built deb contains an architecture-specific P2P sidecar; only the canonical package path is allowed" >&2
  exit 1
fi
grep -Fx './opt/ragent/app/bin/ragent-p2p-host' "$DEB_CONTENTS" >/dev/null || {
  echo "Built deb is missing the canonical P2P host sidecar" >&2
  exit 1
}
while IFS= read -r package_name; do
  [ -n "$package_name" ] || continue
  expected_path="./opt/ragent/app/node_modules/$package_name/package.json"
  if ! grep -Fx "$expected_path" "$DEB_CONTENTS" >/dev/null; then
    echo "Built deb is missing production dependency: $package_name" >&2
    exit 1
  fi
done < "$PROD_DIRECT_DEPENDENCY_LIST"

else
  rm -rf "$STAGE/DEBIAN"
  mkdir -p "$STAGE/usr/lib/systemd/system"
  mv "$STAGE/lib/systemd/system/"* "$STAGE/usr/lib/systemd/system/"
  rmdir "$STAGE/lib/systemd/system" "$STAGE/lib/systemd" "$STAGE/lib"
  rm -f "$STAGE/usr/lib/ragent/retire-legacy-cc-switch"
  sed -i '/^ExecStartPre=\/usr\/lib\/ragent\/retire-legacy-cc-switch$/d' "$STAGE/usr/lib/systemd/system/ragent.service"
  chmod -R a+rX "$APP_DIR" "$STAGE/opt/ragent/vendor"
  find "$STAGE" -type d -exec chmod 0755 {} +
  install -d -m 0755 "$STAGE/usr/share/licenses/ragent"
  install -m 0644 "$ROOT/LICENSE" "$STAGE/usr/share/licenses/ragent/LICENSE"
  RPM_TOP="$WORK_DIR/rpmbuild"
  mkdir -p "$RPM_TOP"/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}
  cp "$ROOT/packaging/rpm/"* "$RPM_TOP/SOURCES/"
  rpmbuild -bb "$ROOT/packaging/rpm/ragent.spec"     --define "_topdir $RPM_TOP" --define "ragent_stage $STAGE"     --define "ragent_version $BUILD_VERSION"
  RPM_BUILT="$RPM_TOP/RPMS/x86_64/ragent-$BUILD_VERSION-1.x86_64.rpm"
  [ -f "$RPM_BUILT" ] || { echo 'RPM build did not produce the expected artifact.' >&2; exit 1; }
  mv "$RPM_BUILT" "$OUTPUT"
fi
if [ "$DEV_MODE" = 1 ]; then
  [ "$(sha256sum "$DEV_ARCHIVE" | awk '{print $1}')" = "$DEV_SHA" ] || { echo 'Development archive changed during packaging.' >&2; exit 1; }
  python3 - "$DEV_ARCHIVE" "$ROOT" <<'PYVERIFY'
import hashlib, pathlib, sys, tarfile
root = pathlib.Path(sys.argv[2])
expected = set()
with tarfile.open(sys.argv[1], 'r:*') as archive:
    for item in archive:
        path = root.joinpath(*item.name.split('/'))
        if path.is_symlink() or not path.is_file():
            raise SystemExit('Development source missing or unsafe: ' + item.name)
        with archive.extractfile(item) as original, path.open('rb') as current:
            while True:
                a, b = original.read(1024 * 1024), current.read(1024 * 1024)
                if a != b: raise SystemExit('Development source changed: ' + item.name)
                if not a: break
        if (path.stat().st_mode & 0o777) != (item.mode & 0o755):
            raise SystemExit('Development source mode changed: ' + item.name)
        expected.add(item.name)
for path in root.rglob('*'):
    if path.is_symlink() or (not path.is_file() and not path.is_dir()):
        raise SystemExit('Unsafe development source entry: ' + str(path))
    if path.is_file() and path.relative_to(root).as_posix() not in expected:
        raise SystemExit('Unexpected development source entry: ' + str(path))
PYVERIFY
elif [ -n "$SOURCE_GIT_DIR" ]; then
  [ "$(git -C "$SOURCE_GIT_DIR" rev-parse --verify HEAD)" = "$SOURCE_COMMIT" ] &&
    [ "$(cat "$ROOT/.ragent-source-commit")" = "$SOURCE_COMMIT" ] &&
    [ "$(sha256sum "$ROOT/runtime-payload-manifest.json" | awk '{print $1}')" = "$FROZEN_MANIFEST_SHA" ] || {
      echo 'Frozen source identity changed during Debian packaging.' >&2; exit 1;
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
    if (!prefix && ['.ragent-source-commit', 'runtime-payload-manifest.json'].includes(name)) continue;
    if (!expected.has(rel) || createHash('sha256').update(readFileSync(file)).digest('hex') !== expected.get(rel)) {
      throw new Error(`Frozen source changed: ${rel}`);
    }
    found.add(rel);
  }
}
walk(root);
if (found.size !== expected.size) throw new Error('Frozen source is incomplete');
NODE
elif [ -e "$ROOT/.git" ]; then
  FINAL_SOURCE_COMMIT="$(git -C "$ROOT" rev-parse --verify HEAD)" || {
    echo 'Unable to verify Debian source commit.' >&2; exit 1;
  }
  FINAL_SOURCE_STATUS="$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)" || {
    echo 'Unable to verify Debian source tree status.' >&2; exit 1;
  }
  [ "$FINAL_SOURCE_COMMIT" = "$SOURCE_COMMIT" ] && [ -z "$FINAL_SOURCE_STATUS" ] || {
      echo 'Source changed during packaging; refusing to publish the candidate.' >&2; exit 1;
    }
fi
[ ! -e "$FINAL_OUTPUT" ] || { echo 'Candidate output already exists; refusing to overwrite it.' >&2; exit 1; }
mv -n "$OUTPUT" "$FINAL_OUTPUT"
[ ! -e "$OUTPUT" ] || { echo 'Candidate output appeared during publishing; refusing to overwrite it.' >&2; exit 1; }
if [ "$DEV_MODE" != 1 ] && [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  node "$ROOT/scripts/create-release-buildinfo.mjs" "$FINAL_OUTPUT" "$VERSION" "$SOURCE_COMMIT" "$BUILD_VERSION"
fi
printf '%s\n' "$FINAL_OUTPUT"
