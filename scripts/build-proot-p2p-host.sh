#!/usr/bin/env bash
set -euo pipefail
# The fingerprint covers the complete module, not just go.mod/go.sum. Both
# the standalone build and release assembler use this exact calculation.
fingerprint() {
  local source="$1"
  [ -f "$source/go.mod" ] && [ -f "$source/go.sum" ] || { echo 'P2P module inputs missing' >&2; return 1; }
  [ -z "$(find "$source" -type l -print -quit)" ] || { echo 'P2P module contains a symlink' >&2; return 1; }
  (cd "$source" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
}
case "${1:-}" in
  fingerprint)
    [ "$#" -eq 2 ] || exit 2
    fingerprint "$2"
    ;;
  build)
    [ "$#" -eq 4 ] || { echo 'Usage: build-proot-p2p-host.sh build MODULE OUTPUT CACHE' >&2; exit 2; }
    source_dir="$(cd "$2" && pwd -P)"
    mkdir -p "$(dirname "$3")" "$4/go-build" "$4/go-mod" "$4/go-path" "$4/tmp"
    output="$(cd "$(dirname "$3")" && pwd -P)/$(basename "$3")"
    cache="$(cd "$4" && pwd -P)"
    [ ! -e "$output" ] || { echo 'P2P host output already exists' >&2; exit 1; }
    before="$(fingerprint "$source_dir")"
    build_cache="$cache/go-build"; module_cache="$cache/go-mod"; go_path="$cache/go-path"; task_tmp="$cache/tmp"; go_output="$output"
    if command -v cygpath >/dev/null 2>&1; then
      build_cache="$(cygpath -w "$build_cache")"; module_cache="$(cygpath -w "$module_cache")"; go_path="$(cygpath -w "$go_path")"
      task_tmp="$(cygpath -w "$task_tmp")"; go_output="$(cygpath -w "$go_output")"
    fi
    (
      cd "$source_dir"
      export GOCACHE="$build_cache" GOMODCACHE="$module_cache" GOPATH="$go_path" GOENV=off GOFLAGS= GOTELEMETRY=off GOWORK=off GOTOOLCHAIN=local GOOS=linux GOARCH=arm64 CGO_ENABLED=0
      export TMP="$task_tmp" TEMP="$task_tmp" TMPDIR="$task_tmp"
      if [ "${RAGENT_PROOT_OFFLINE:-0}" = 1 ]; then export GOPROXY=off; fi
      go version > "$output.go-version"
      go build -mod=readonly -buildvcs=false -trimpath -o "$go_output" ./cmd/agentoc-p2p-host
    )
    [ "$(fingerprint "$source_dir")" = "$before" ] || { echo 'P2P source changed during build' >&2; exit 1; }
    [ "$(od -An -tx1 -N6 "$output" | tr -d ' \n')" = 7f454c460201 ] && \
      [ "$(od -An -tx1 -j18 -N2 "$output" | tr -d ' \n')" = b700 ] || { echo 'P2P host is not a Linux ARM64 ELF' >&2; exit 1; }
    chmod 0755 "$output"
    printf '%s\n' "$before" > "$output.source-sha256"
    sha256sum "$output" | cut -d' ' -f1 > "$output.sha256"
    ;;
  *) echo 'Usage: build-proot-p2p-host.sh fingerprint MODULE | build MODULE OUTPUT CACHE' >&2; exit 2 ;;
esac
