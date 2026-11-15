#!/usr/bin/env bash
set -euo pipefail
# Run on a native Ubuntu 24.04 ARM64 builder. Output and npm cache are explicit
# so a small local disk is never filled by an implicit temporary directory.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${RAGENT_PROOT_OUTPUT_DIR:?Set RAGENT_PROOT_OUTPUT_DIR}"
: "${RAGENT_PROOT_CACHE_DIR:?Set RAGENT_PROOT_CACHE_DIR}"
if [ "${RAGENT_PROOT_CROSS_ASSEMBLY:-0}" != 1 ]; then
  [ "$(uname -m)" = aarch64 ] || { echo 'Native ARM64 builder required; explicit cross assembly is available for unvalidated candidates' >&2; exit 1; }
  . /etc/os-release
  [ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] || { echo 'Ubuntu 24.04 builder required' >&2; exit 1; }
fi
VERSION="${RAGENT_PROOT_VERSION:-$(node -p "require('$ROOT/package.json').version")}"
[[ "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9.+_-]*$ ]] || exit 1
NODE_VERSION=v24.12.0
NODE_DIST="node-${NODE_VERSION}-linux-arm64"
mkdir -p "$RAGENT_PROOT_OUTPUT_DIR" "$RAGENT_PROOT_CACHE_DIR"
WORK="$(mktemp -d "$RAGENT_PROOT_OUTPUT_DIR/.proot-build.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export TMPDIR="$WORK" TMP="$WORK" TEMP="$WORK" npm_config_cache="$RAGENT_PROOT_CACHE_DIR/npm"
if [ "${RAGENT_PROOT_CROSS_ASSEMBLY:-0}" = 1 ] && command -v cygpath >/dev/null; then
  npm_config_cache="$(cygpath -w "$npm_config_cache")"
  TMP="$(cygpath -w "$WORK")"; TEMP="$TMP"
  export npm_config_cache TMP TEMP
fi
NAME="Ragent-${VERSION}-android-proot-ubuntu24.04-arm64"
STAGE="$WORK/$NAME"
mkdir -p "$STAGE/app" "$STAGE/runtime"
# A pre-frozen snapshot enables an offline ARM builder without copying a Git
# checkout. Its manifest must come from stage-proot-snapshot.mjs.
if [ -n "${RAGENT_PROOT_SNAPSHOT:-}" ]; then
  [ -f "$RAGENT_PROOT_SNAPSHOT/proot-source-manifest.json" ] || { echo 'Snapshot manifest missing' >&2; exit 1; }
  node -e 'const fs=require("fs"),path=require("path"),crypto=require("crypto"),root=process.argv[1],dest=process.argv[2],manifest=fs.readFileSync(path.join(root,"proot-source-manifest.json")),m=JSON.parse(manifest); for(const f of m.files){if(!/^[A-Za-z0-9_.@+/-]+$/.test(f.path)||f.path.split("/").some(x=>!x||x==="."||x==="..")||![420,493].includes(f.mode))throw Error("Invalid snapshot entry");let p=path.join(root,f.path),b=fs.readFileSync(p),target=path.join(dest,f.path);if(crypto.createHash("sha256").update(b).digest("hex")!==f.sha256)throw Error("Snapshot hash mismatch: "+f.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,b,{flag:"wx",mode:f.mode})}fs.writeFileSync(path.join(dest,"proot-source-manifest.json"),manifest);fs.writeFileSync(path.join(dest,".ragent-source-commit"),m.sourceRevision+"\n")' "$RAGENT_PROOT_SNAPSHOT" "$STAGE/app"
else
  node "$ROOT/scripts/stage-proot-snapshot.mjs" "$ROOT" "$STAGE/app" "${RAGENT_PROOT_SOURCE_MODE:-checkout}"
fi
# Build the same self-contained host used by the Debian package, from the
# frozen payload rather than a separate, possibly different working tree.
# Keep every mutable Go cache below the explicitly supplied package cache.
[ -f "$STAGE/app/p2p/go.mod" ] && [ -f "$STAGE/app/p2p/go.sum" ] || { echo 'Snapshot is missing P2P module inputs' >&2; exit 1; }
[ -s "$STAGE/app/third_party_licenses/go/README.md" ] || { echo 'P2P dependency license inventory is missing' >&2; exit 1; }
mkdir -p "$STAGE/app/bin"
P2P_ARTIFACT="${RAGENT_PROOT_P2P_ARTIFACT:-$WORK/p2p-build/ragent-p2p-host}"
if [ -z "${RAGENT_PROOT_P2P_ARTIFACT:-}" ]; then
  command -v go >/dev/null 2>&1 || { echo 'Go 1.26 or newer is required for the ARM64 P2P host' >&2; exit 1; }
  bash "$ROOT/scripts/build-proot-p2p-host.sh" build "$STAGE/app/p2p" "$P2P_ARTIFACT" "$RAGENT_PROOT_CACHE_DIR"
fi
[ "$(bash "$ROOT/scripts/build-proot-p2p-host.sh" fingerprint "$STAGE/app/p2p")" = "$(cat "$P2P_ARTIFACT.source-sha256")" ] || { echo 'P2P host was built from different source' >&2; exit 1; }
[ "$(sha256sum "$P2P_ARTIFACT" | cut -d' ' -f1)" = "$(cat "$P2P_ARTIFACT.sha256")" ] || { echo 'P2P host checksum mismatch' >&2; exit 1; }
install -m 0755 "$P2P_ARTIFACT" "$STAGE/app/bin/ragent-p2p-host"
install -m 0644 "$P2P_ARTIFACT.go-version" "$STAGE/app/.ragent-p2p-host-go-version"
HOST_BINARY="$STAGE/app/bin/ragent-p2p-host"
[ "$(od -An -tx1 -N6 "$HOST_BINARY" | tr -d ' \n')" = 7f454c460201 ] && \
  [ "$(od -An -tx1 -j18 -N2 "$HOST_BINARY" | tr -d ' \n')" = b700 ] || { echo 'P2P host is not a Linux ARM64 ELF' >&2; exit 1; }
chmod 0755 "$HOST_BINARY"
NPM_NETWORK=()
if [ "${RAGENT_PROOT_OFFLINE:-0}" = 1 ]; then NPM_NETWORK=(--offline); fi
(cd "$STAGE/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --os=linux --cpu=arm64 --libc=glibc "${NPM_NETWORK[@]}")
# Any executable native dependency must be Linux ARM64, never a Windows PE.
node -e 'const fs=require("fs"),path=require("path"); function walk(d){for(const x of fs.readdirSync(d,{withFileTypes:true})){let p=path.join(d,x.name);if(x.isDirectory())walk(p);else if(x.isFile()){let fd=fs.openSync(p,"r"),b=Buffer.alloc(20),n=fs.readSync(fd,b,0,20,0);fs.closeSync(fd);if(/\.(exe|dll)$/i.test(p)||(n>=2&&b[0]===77&&b[1]===90))throw Error("Windows executable in dependencies: "+p);if(n>=20&&b[0]===127&&b.toString("ascii",1,4)==="ELF"&&(b[5]!==1||b.readUInt16LE(18)!==183))throw Error("Non-ARM64 ELF in dependencies: "+p);if(/\.node$/i.test(p)&&!(n>=20&&b[0]===127&&b.toString("ascii",1,4)==="ELF"))throw Error("Non-ELF native addon: "+p)}}}walk(process.argv[1])' "$STAGE/app/node_modules"
rm "$STAGE/app/package-lock.json"
printf '%s\n' "$VERSION" > "$STAGE/app/.ragent-package-version"
TARBALL="$NODE_DIST.tar.xz"
BASE="https://nodejs.org/dist/$NODE_VERSION"
[ -f "$RAGENT_PROOT_CACHE_DIR/$TARBALL" ] || { [ "${RAGENT_PROOT_OFFLINE:-0}" != 1 ] || { echo 'Offline Node archive missing' >&2; exit 1; }; curl -fsSL --retry 3 "$BASE/$TARBALL" -o "$RAGENT_PROOT_CACHE_DIR/$TARBALL"; }
if [ "${RAGENT_PROOT_OFFLINE:-0}" = 1 ]; then
  cp "$RAGENT_PROOT_CACHE_DIR/SHASUMS256.txt" "$WORK/SHASUMS256.txt"
else
  curl -fsSL --retry 3 "$BASE/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
fi
EXPECTED="$(awk -v n="$TARBALL" '$2 == n {print $1}' "$WORK/SHASUMS256.txt")"
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$(sha256sum "$RAGENT_PROOT_CACHE_DIR/$TARBALL" | cut -d' ' -f1)" ] || { echo 'Node checksum mismatch' >&2; exit 1; }
tar -xJf "$RAGENT_PROOT_CACHE_DIR/$TARBALL" -C "$WORK"
install -m 0755 "$WORK/$NODE_DIST/bin/node" "$STAGE/runtime/node"
if [ "${RAGENT_PROOT_CROSS_ASSEMBLY:-0}" = 1 ]; then
  mkdir -p "$STAGE/runtime/node_modules"
  cp -a "$WORK/$NODE_DIST/lib/node_modules/npm" "$WORK/$NODE_DIST/lib/node_modules/corepack" "$STAGE/runtime/node_modules/"
  for tool in npm corepack; do
    case "$tool" in npm) entry=node_modules/npm/bin/npm-cli.js ;; corepack) entry=node_modules/corepack/dist/corepack.js ;; esac
    printf '#!/bin/sh\nruntime=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nPATH="$runtime:$PATH"; export PATH\nexec "$runtime/node" "$runtime/%s" "$@"\n' "$entry" > "$STAGE/runtime/$tool"
    chmod 0755 "$STAGE/runtime/$tool"
  done
else
  bash "$ROOT/scripts/stage-posix-node-toolchain.sh" "$WORK/$NODE_DIST" "$STAGE/runtime"
fi
# Fixed upstream versions match the existing adapter contract and deb package.
HARNESS_CACHE="${RAGENT_PROOT_HARNESS_CACHE_DIR:-$RAGENT_PROOT_CACHE_DIR}"
for pair in \
  'codex-0.167.2.tgz ee6f22155fd7514cd22c03f1bc281d854a89cc5d6c72d5b3e3b01043f4206c2f' \
  'codex-0.167.2-linux-arm64.tgz cf2827197edee6a430485b68979fb2b8f27cf97e30f71a6334fe02b0e6e73e11' \
  'claude-code-linux-arm64-2.1.310.tgz b94afea57c67e8001b6da656dc83cca070ac2f716c02cdd3b5987f7583b0c185'; do
  set -- $pair
  [ "$(sha256sum "$HARNESS_CACHE/$1" | cut -d' ' -f1)" = "$2" ] || { echo "Harness archive checksum mismatch: $1" >&2; exit 1; }
done
mkdir -p "$STAGE/vendor/codex/node_modules/@openai/codex-linux-arm64" "$STAGE/vendor/claude"
tar -xzf "$HARNESS_CACHE/codex-0.167.2.tgz" -C "$STAGE/vendor/codex" --strip-components=1
tar -xzf "$HARNESS_CACHE/codex-0.167.2-linux-arm64.tgz" -C "$STAGE/vendor/codex/node_modules/@openai/codex-linux-arm64" --strip-components=1
tar -xzf "$HARNESS_CACHE/claude-code-linux-arm64-2.1.310.tgz" -C "$STAGE/vendor/claude" --strip-components=1
for bin in "$STAGE/vendor/claude/claude" "$STAGE/vendor/codex/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex"; do
  [ "$(od -An -tx1 -j18 -N2 "$bin" | tr -d ' \n')" = b700 ] || { echo "Wrong harness architecture: $bin" >&2; exit 1; }
done
cat > "$STAGE/runtime/codex" <<'EOF'
#!/bin/sh
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$root/runtime/node" "$root/vendor/codex/bin/codex.js" "$@"
EOF
cat > "$STAGE/runtime/claude" <<'EOF'
#!/bin/sh
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$root/vendor/claude/claude" "$@"
EOF
cp "$STAGE/runtime/codex" "$STAGE/runtime/ragent-codex-app-server"
chmod 0755 "$STAGE/runtime/codex" "$STAGE/runtime/ragent-codex-app-server" "$STAGE/runtime/claude"
printf 'codex=0.167.2\nclaude=2.1.310\n' > "$STAGE/runtime/provider-versions"
install -m 0755 "$ROOT/packaging/proot/ragent" "$STAGE/ragent"
install -m 0755 "$ROOT/packaging/proot/install.sh" "$STAGE/install.sh"
install -m 0755 "$ROOT/packaging/proot/termux-ragent" "$STAGE/termux-ragent"
install -m 0644 "$ROOT/docs/android-proot.md" "$STAGE/README.md"
printf '%s\n' "$VERSION" > "$STAGE/VERSION"
if [ -n "${RAGENT_PROOT_PYTHON:-}" ]; then
  PYTHON="$RAGENT_PROOT_PYTHON"
elif [ "${RAGENT_PROOT_CROSS_ASSEMBLY:-0}" = 1 ] && command -v cygpath >/dev/null; then
  PYTHON=python
elif command -v python3 >/dev/null 2>&1; then PYTHON=python3; else PYTHON=python; fi
"$PYTHON" --version >/dev/null 2>&1 || { echo 'A working Python interpreter is required; set RAGENT_PROOT_PYTHON' >&2; exit 1; }
"$PYTHON" "$ROOT/scripts/write-proot-identity.py" "$STAGE"
"$PYTHON" "$ROOT/scripts/archive-proot.py" "$STAGE" "$RAGENT_PROOT_OUTPUT_DIR/$NAME.tar.gz"
(cd "$RAGENT_PROOT_OUTPUT_DIR" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
printf '%s\n' "$RAGENT_PROOT_OUTPUT_DIR/$NAME.tar.gz"
