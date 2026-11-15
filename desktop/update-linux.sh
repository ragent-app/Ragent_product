#!/bin/bash
set -u
package=$1
digest=$7
[ "$(id -u)" = 0 ] || exit 1
os_field() {
  sed -n "s/^$1=\"\{0,1\}\([^\" ]*\)\"\{0,1\}$/\1/p" /etc/os-release
}
os_id=$(os_field ID)
os_version=$(os_field VERSION_ID)
machine=$(uname -m)
case "$os_id:$os_version" in
  ubuntu:22.04|ubuntu:24.04|ubuntu:26.04|debian:12|debian:13) target=deb ;;
  rhel:9|rhel:9.*)
    printf '%s\n' "$os_version" | /usr/bin/grep -Eq '^9(\.[0-9]+)?$' || exit 1
    target=rpm ;;
  *) exit 1 ;;
esac
case "$target:$machine:${package##*.}" in
  deb:x86_64:deb) format=deb; package_arch=amd64 ;;
  deb:aarch64:deb) format=deb; package_arch=arm64 ;;
  rpm:x86_64:rpm) format=rpm; package_arch=x86_64 ;;
  *) exit 1 ;;
esac
case "$digest" in *[!0-9a-f]*|'') exit 1 ;; esac
[ "${#digest}" = 64 ] || exit 1
secure=$(mktemp -d /var/tmp/ragent-update.XXXXXXXX) || exit 1
trap 'rm -f "$secure/package.$format"; rmdir "$secure"' EXIT
install -m 0600 "$package" "$secure/package.$format" || exit 1
[ "$(sha256sum "$secure/package.$format" | cut -d ' ' -f1)" = "$digest" ] || exit 1
if [ "$format" = deb ]; then
  [ "$(/usr/bin/dpkg-deb -f "$secure/package.deb" Package)" = ragent ] || exit 1
  [ "$(/usr/bin/dpkg-deb -f "$secure/package.deb" Architecture)" = "$package_arch" ] || exit 1
else
  [ "$(/usr/bin/rpm -qp --qf '%{NAME} %{ARCH}' "$secure/package.rpm")" = "ragent $package_arch" ] || exit 1
fi
while :; do
  /usr/bin/ragent restart-check --check-only --json >/dev/null 2>&1
  code=$?
  [ "$code" = 0 ] && break
  if [ "$code" != 3 ]; then exit 1; fi
  echo RAGENT_WAITING
  sleep 5
done
echo RAGENT_INSTALLING
if [ "$format" = deb ]; then
  DEBIAN_FRONTEND=noninteractive /usr/bin/dpkg --force-confold -i "$secure/package.deb" || exit 1
else
  /usr/bin/dnf -y install "$secure/package.rpm" || exit 1
fi
for n in $(seq 1 60); do
  if systemctl is-active --quiet ragent; then exit 0; fi
  sleep 1
done
exit 1
