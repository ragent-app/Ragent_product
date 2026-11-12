#!/usr/bin/env bash
# Feasibility test only. Requires root, systemd host tools, gcc and idmapped
# mount support. All mounts live in a new private mount namespace.
set -euo pipefail
if [[ ${1:-} == --inside ]]; then
  shift
  src=$1 mapped=$2 outside=$3 owner_uid=$4 runner_uid=$5 runner_gid=$6 other_uid=$7
  test "$(stat -c %u "$src/secret")" = "$owner_uid"
  test "$(stat -c %u "$mapped/secret")" = "$runner_uid"
  if setpriv --reuid "$runner_uid" --regid "$runner_gid" --clear-groups -- test -r "$outside/hardlink"; then
    echo 'runner could read the original hard link' >&2; exit 1
  fi
  if setpriv --reuid "$other_uid" --regid "$other_uid" --clear-groups -- test -r "$mapped/secret"; then
    echo 'another task identity could read the mapped file' >&2; exit 1
  fi
  for path in "$mapped/root-secret" "$mapped/external-link"; do
    if setpriv --reuid "$runner_uid" --regid "$runner_gid" --clear-groups -- test -r "$path"; then
      echo 'runner read a file outside its mapped owner identity' >&2; exit 1
    fi
  done
  setpriv --reuid "$runner_uid" --regid "$runner_gid" --clear-groups -- sh -c \
    'test "$(cat "$1/secret")" = original && printf changed > "$1/secret" && printf created > "$1/new"' sh "$mapped"
  test "$(cat "$src/secret")" = changed
  test "$(stat -c %u "$src/new")" = "$owner_uid"
  python3 - "$mapped/secret" "$outside/crosslink" <<'PY'
import errno, os, sys
try:
    os.link(sys.argv[1], sys.argv[2])
except OSError as error:
    if error.errno != errno.EXDEV:
        raise
else:
    raise AssertionError('hard link unexpectedly crossed mount boundaries')
PY
  echo 'idmapped mount granted only the selected UID and preserved on-disk ownership'
  exit 0
fi

test "$(id -u)" = 0
owner=${AGENTOC_TEST_OWNER_USER:-pinggu}
runner=${AGENTOC_TEST_RUNNER_USER:-agentoc-runner}
owner_uid=$(id -u "$owner") owner_gid=$(id -g "$owner")
runner_uid=$(id -u "$runner") runner_gid=$(id -g "$runner")
other_uid=222222
test "$owner_uid" != "$runner_uid"
test "$other_uid" != "$owner_uid" && test "$other_uid" != "$runner_uid"
test "$runner_uid" != "$(cat /proc/sys/kernel/overflowuid)"
test "$runner_gid" != "$(cat /proc/sys/kernel/overflowgid)"
if getent passwd "$other_uid" >/dev/null || getent group "$other_uid" >/dev/null; then
  echo 'fixture UID/GID is already allocated' >&2; exit 1
fi
root=$(mktemp -d /srv/agentoc-idmap-test-XXXXXXXX)
case "$root" in /srv/agentoc-idmap-test-*) ;; *) echo 'unexpected fixture path' >&2; exit 1;; esac
trap 'rm -rf -- "$root"' EXIT
chmod 0711 "$root"
mkdir "$root/source" "$root/mapped" "$root/outside"
chown "$owner_uid:$owner_gid" "$root/source"
chmod 0700 "$root/source"
printf original > "$root/source/secret"
chown "$owner_uid:$owner_gid" "$root/source/secret"
chmod 0600 "$root/source/secret"
ln "$root/source/secret" "$root/outside/hardlink"
printf root-only > "$root/source/root-secret"
chmod 0600 "$root/source/root-secret"
ln -s "$root/outside/hardlink" "$root/source/external-link"
before=$(getfacl -cp "$root/source/secret")
script_dir=$(cd "$(dirname "$0")" && pwd)
gcc -std=c11 -Wall -Wextra -Werror -O2 "$script_dir/fixtures/linux-idmapped-workspace.c" -o "$root/helper"
"$root/helper" "$root/source" "$root/mapped" "$owner_uid" "$runner_uid" "$owner_gid" "$runner_gid" \
  /bin/bash "$script_dir/$(basename "$0")" --inside "$root/source" "$root/mapped" "$root/outside" \
  "$owner_uid" "$runner_uid" "$runner_gid" "$other_uid"
test "$(getfacl -cp "$root/source/secret")" = "$before"
if mountpoint -q "$root/mapped"; then echo 'mount leaked into the host namespace' >&2; exit 1; fi
echo 'original ACL remained unchanged and host namespace has no fixture mount'
