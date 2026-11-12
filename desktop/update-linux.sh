#!/bin/bash
set -u
package=$1
digest=$7
[ "$(id -u)" = 0 ] || exit 1
case "$digest" in *[!0-9a-f]*|'') exit 1 ;; esac
[ "${#digest}" = 64 ] || exit 1
secure=$(mktemp -d /var/tmp/ragent-update.XXXXXXXX) || exit 1
trap 'rm -f "$secure/package.deb"; rmdir "$secure"' EXIT
install -m 0600 "$package" "$secure/package.deb" || exit 1
[ "$(sha256sum "$secure/package.deb" | cut -d ' ' -f1)" = "$digest" ] || exit 1
while :; do
  /usr/bin/ragent restart-check --check-only --json >/dev/null 2>&1
  code=$?
  [ "$code" = 0 ] && break
  if [ "$code" != 3 ]; then exit 1; fi
  echo RAGENT_WAITING
  sleep 5
done
echo RAGENT_INSTALLING
if ! DEBIAN_FRONTEND=noninteractive /usr/bin/dpkg --force-confold -i "$secure/package.deb"; then exit 1; fi
for n in $(seq 1 60); do
  if systemctl is-active --quiet ragent; then exit 0; fi
  sleep 1
done
exit 1
