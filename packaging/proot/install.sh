#!/usr/bin/env bash
set -euo pipefail
SOURCE="$(cd "$(dirname "$0")" && pwd)"
PREFIX="${RAGENT_PROOT_HOME:-$HOME/.local/share/ragent-proot}"
STATE="${RAGENT_PROOT_STATE:-$HOME/.local/state/ragent-proot}"
umask 077
mkdir -p "$PREFIX/releases" "$HOME/.local/bin" "$STATE"
exec 9>"$STATE/manage.lock"
flock -x 9
UPGRADE=0
if [ -e "$PREFIX/current" ] || [ -L "$PREFIX/current" ]; then
  UPGRADE=1
  boot="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || true)"
  previous="$(cat "$STATE/last-start-boot-id" 2>/dev/null || true)"
  pattern='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  if [[ ! "$boot" =~ $pattern || ! "$previous" =~ $pattern || "$boot" = "$previous" ]]; then
    echo 'Upgrade refused: Android must be restarted after the last managed start, and Ragent must not be started since. Boot records must be readable.' >&2
    exit 1
  fi
fi
VERSION="$(cat "$SOURCE/RELEASE_ID")"
PUBLIC_VERSION="$(cat "$SOURCE/VERSION")"
# Accept a single trailing CR from an older archive; internal CRs still fail.
VERSION="${VERSION%$'\r'}"
PUBLIC_VERSION="${PUBLIC_VERSION%$'\r'}"
[[ "$PUBLIC_VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9.+_-]*$ ]] || { echo 'Invalid VERSION in package' >&2; exit 1; }
[[ "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9.+_-]*$ && "$VERSION" = "$PUBLIC_VERSION-"* ]] || { echo 'Invalid RELEASE_ID in package' >&2; exit 1; }
DEST="$PREFIX/releases/$VERSION"
[ ! -e "$DEST" ] || { echo 'Release already exists' >&2; exit 1; }
if [ "$UPGRADE" = 0 ]; then
  [ ! -e "$HOME/.local/bin/ragent" ] && [ ! -L "$HOME/.local/bin/ragent" ] || { echo 'The ragent command already exists; leaving it unchanged' >&2; exit 1; }
fi
STAGING="$(mktemp -d "$PREFIX/releases/.install.XXXXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
cp -a "$SOURCE/." "$STAGING/"
mv "$STAGING" "$DEST"
if [ "$UPGRADE" = 0 ]; then ln -s "$PREFIX/current/ragent" "$HOME/.local/bin/ragent"; fi
LINK="$PREFIX/.current-$$"
ln -s "releases/$VERSION" "$LINK"
if ! mv -Tf "$LINK" "$PREFIX/current"; then
  rm -f "$LINK"
  if [ "$UPGRADE" = 0 ]; then rm "$HOME/.local/bin/ragent"; fi
  echo 'Could not activate installation; old release retained' >&2; exit 1
fi
echo "Installed. Add $HOME/.local/bin to PATH, then run: ragent init"
