#!/bin/bash
# Export a Linux-only source tarball of the current HEAD for packaging hosts
# (local amd64 builds and remote arm64 builds alike). Everything outside Linux
# scope — Android sources/design captures, Windows test fixtures, emulator
# shots/APKs, local scratch trees — is excluded so the tarball carries only
# what the Linux deb build reads.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_COMMIT="$(git -C "$ROOT" rev-parse --verify HEAD)"
[[ "$SOURCE_COMMIT" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ ]] || {
  echo 'A full committed source identity is required.' >&2; exit 1;
}
HEAD_HASH="${SOURCE_COMMIT:0:8}"
OUTPUT_DIR="${AGENTOC_SRC_TAR_OUTPUT_DIR:-/tmp}"
OUTPUT="${AGENTOC_SRC_TAR:-$OUTPUT_DIR/agentoc-src-main-$HEAD_HASH.tar}"
[ ! -e "$OUTPUT" ] || { echo 'Source archive already exists; refusing to overwrite it.' >&2; exit 1; }

git -C "$ROOT" archive --format=tar \
  --output="$OUTPUT" \
  "$SOURCE_COMMIT" \
  -- . \
    ':(exclude)android' \
    ':(exclude)design' \
    ':(exclude)work' \
    ':(exclude)release' \
    ':(exclude)releases' \
    ':(exclude)cache' \
    ':(exclude)artifacts' \
    ':(exclude)notes' \
    ':(exclude)./-' \
    ':(exclude)*\Users\*' \
    ':(exclude)*.apk' \
    ':(exclude,top)emu-*.png' \
    ':(exclude,top)emulator-*.png'

# Stamp the exported commit into the tarball: packaging hosts extract plain
# archives (no .git), and build-deb.sh uses this marker to keep the commit in
# the generated package version.
META_DIR="$(mktemp -d)"
printf '%s\n' "$SOURCE_COMMIT" > "$META_DIR/.agentoc-source-commit"
tar --append --file="$OUTPUT" --directory="$META_DIR" .agentoc-source-commit
rm -rf "$META_DIR"

# Do not mix live working-tree files into an archive attributed to a commit.
[ "$(git -C "$ROOT" rev-parse --verify HEAD)" = "$SOURCE_COMMIT" ] || {
  echo 'Source commit changed during archiving; discard this archive.' >&2; exit 1;
}

printf '%s\n' "$OUTPUT"
du -h "$OUTPUT" | cut -f1
sha256sum "$OUTPUT" | cut -c1-16
