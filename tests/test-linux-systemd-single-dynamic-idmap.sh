#!/usr/bin/env bash
# Same-unit feasibility test, not a production launcher. Requires root,
# python3-dbus, systemd, gcc and idmapped mount support.
set -euo pipefail
test "$(id -u)" = 0
owner=${AGENTOC_TEST_OWNER_USER:-pinggu}
owner_uid=$(id -u "$owner") owner_gid=$(id -g "$owner")
root=$(mktemp -d /srv/agentoc-idmap-single-XXXXXXXX)
case "$root" in /srv/agentoc-idmap-single-*) ;; *) echo 'unexpected fixture path' >&2; exit 1;; esac
suffix=${root##*-}
user="agentoc-map-${suffix}-a" other="agentoc-map-${suffix}-b"
unit="agentoc-idmap-single-${suffix}.service" other_unit="agentoc-idmap-single-${suffix}-other.service"
reuse_unit="agentoc-idmap-single-${suffix}-reuse.service" runtime="agentoc-idmap-single-${suffix}"
postkill_unit="agentoc-idmap-single-${suffix}-postkill.service"
started=0 started_other=0 started_reuse=0 started_postkill=0
cleanup() {
  if test "$started" = 1 && ! systemctl stop "$unit" >/dev/null 2>&1; then
    echo "Retaining $root because $unit did not stop" >&2; return
  fi
  if test "$started_reuse" = 1 && ! systemctl stop "$reuse_unit" >/dev/null 2>&1; then
    echo "Retaining $root because $reuse_unit did not stop" >&2; return
  fi
  if test "$started_reuse" = 1; then systemctl reset-failed "$reuse_unit" >/dev/null 2>&1 || true; fi
  if test "$started_other" = 1; then systemctl stop "$other_unit" >/dev/null 2>&1 || true; fi
  if test "$started_postkill" = 1; then systemctl stop "$postkill_unit" >/dev/null 2>&1 || true; fi
  rm -rf -- "$root"
}
trap cleanup EXIT
for target in "$unit" "$other_unit" "$reuse_unit" "$postkill_unit"; do
  test "$(systemctl show --property=LoadState --value "$target")" = not-found || { echo 'fixture unit exists' >&2; exit 1; }
done
if getent passwd "$user" >/dev/null || getent passwd "$other" >/dev/null || test -e "/run/$runtime" || test -L "/run/$runtime"; then
  echo 'fixture identity or runtime already exists' >&2; exit 1
fi
chmod 0711 "$root"
mkdir "$root/source" "$root/mapped"
chown "$owner_uid:$owner_gid" "$root/source"
chmod 0700 "$root/source"
printf original > "$root/source/secret"
chown "$owner_uid:$owner_gid" "$root/source/secret"
chmod 0600 "$root/source/secret"
before=$(getfacl -cp "$root/source/secret")
script_dir=$(cd "$(dirname "$0")" && pwd)
gcc -std=c11 -Wall -Wextra -Werror -O2 "$script_dir/fixtures/linux-idmapped-workspace.c" -o "$root/helper"
cat > "$root/task.sh" <<'TASK'
set -eu
case "$(cat "$1/secret")" in original|updated) ;; *) exit 1;; esac
printf updated > "$1/secret"
printf created > "$1/new"
/usr/bin/sleep 120 &
printf '%s\n' "$!" > "$2/child-pid"
printf ready > "$2/ready"
exec /usr/bin/sleep 120
TASK
cat > "$root/bootstrap.sh" <<'BOOT'
set -eu
user=$1 root=$2 owner_uid=$3 owner_gid=$4 runtime=$5
uid=$(id -u "$user") gid=$(id -g "$user")
test "$uid" -gt 0 && test "$gid" -gt 0
test "$uid" != "$owner_uid" && test "$uid" != "$(cat /proc/sys/kernel/overflowuid)"
test "$gid" != "$(cat /proc/sys/kernel/overflowgid)"
test ! -e "/run/$runtime/ready" && test ! -e "/run/$runtime/child-pid"
printf '%s %s\n' "$uid" "$gid" > "$root/identity"
exec "$root/helper" "$root/source" "$root/mapped" "$owner_uid" "$uid" "$owner_gid" "$gid" \
  /usr/bin/setpriv --reuid "$uid" --regid "$gid" --clear-groups --no-new-privs \
  /bin/sh "$root/task.sh" "$root/mapped" "/run/$runtime"
BOOT
chmod 0644 "$root/task.sh" "$root/bootstrap.sh"
systemd-run --quiet --collect --unit="$other_unit" --property=DynamicUser=yes --property="User=$other" /usr/bin/sleep 120
started_other=1
/usr/bin/python3 "$script_dir/fixtures/linux-start-dynamic-unit.py" "$unit" "$user" "$root" "$runtime" \
  /bin/sh "$root/bootstrap.sh" "$user" "$root" "$owner_uid" "$owner_gid" "$runtime"
started=1
for i in $(seq 1 120); do test -f "/run/$runtime/ready" && break; sleep 0.05; done
test -f "/run/$runtime/ready" || { systemctl status "$unit" --no-pager >&2 || true; exit 1; }
read -r uid gid < "$root/identity"
pid=$(systemctl show "$unit" -p MainPID --value)
child_pid=$(cat "/run/$runtime/child-pid")
other_pid=$(systemctl show "$other_unit" -p MainPID --value)
other_uid=$(awk '/^Uid:/ {print $2}' "/proc/$other_pid/status")
other_gid=$(awk '/^Gid:/ {print $2}' "/proc/$other_pid/status")
test "$uid" != "$other_uid"
test "$(awk '/^Uid:/ {print $2}' "/proc/$pid/status")" = "$uid"
test "$(awk '/^NoNewPrivs:/ {print $2}' "/proc/$pid/status")" = 1
for cap in CapInh CapPrm CapEff CapAmb; do
  value=$(awk -v key="$cap:" '$1 == key {print $2}' "/proc/$pid/status")
  case "$value" in ''|*[!0]*) echo "unexpected $cap: $value" >&2; exit 1;; esac
done
grep -Fq "/system.slice/$unit" "/proc/$pid/cgroup"
test "$(cat "$root/source/secret")" = updated
test "$(stat -c %u "$root/source/new")" = "$owner_uid"
if setpriv --reuid "$other_uid" --regid "$other_gid" --clear-groups -- cat "/proc/$pid/root$root/mapped/secret" >/dev/null 2>&1; then
  echo 'other dynamic UID read the task mount' >&2; exit 1
fi
if test -e "$root/mapped/secret"; then echo 'mount leaked to host namespace' >&2; exit 1; fi
systemctl stop "$unit"
started=0
test ! -d "/proc/$pid"
if test -r "/proc/$child_pid/status" && ! grep -q '^State:[[:space:]]*Z' "/proc/$child_pid/status"; then
  echo 'task child survived unit stop' >&2; exit 1
fi
test ! -e "/run/$runtime" && test ! -L "/run/$runtime"
test "$(getfacl -cp "$root/source/secret")" = "$before"
/usr/bin/python3 "$script_dir/fixtures/linux-start-dynamic-unit.py" "$reuse_unit" "$user" "$root" "$runtime" \
  /bin/sh "$root/bootstrap.sh" "$user" "$root" "$owner_uid" "$owner_gid" "$runtime"
started_reuse=1
for i in $(seq 1 120); do test -f "/run/$runtime/ready" && break; sleep 0.05; done
test -f "/run/$runtime/ready" || { systemctl status "$reuse_unit" --no-pager >&2 || true; exit 1; }
reuse_pid=$(systemctl show "$reuse_unit" -p MainPID --value)
reuse_child=$(cat "/run/$runtime/child-pid")
reuse_uid=$(awk '/^Uid:/ {print $2}' "/proc/$reuse_pid/status")
systemctl kill --kill-who=main --signal=SIGKILL "$reuse_unit"
for i in $(seq 1 100); do
  if test ! -e "/run/$runtime" && test ! -L "/run/$runtime"; then break; fi
  sleep 0.05
done
test ! -e "/run/$runtime" && test ! -L "/run/$runtime"
for target in "$reuse_pid" "$reuse_child"; do
  if test -r "/proc/$target/status" && ! grep -q '^State:[[:space:]]*Z' "/proc/$target/status"; then
    echo 'task process survived main-process crash' >&2; exit 1
  fi
done
systemctl reset-failed "$reuse_unit"
started_reuse=0
systemd-run --quiet --collect --unit="$postkill_unit" --property=DynamicUser=yes --property="User=$user" \
  --property="RuntimeDirectory=$runtime" --property=RuntimeDirectoryMode=0700 /usr/bin/sleep 120
started_postkill=1
test ! -e "/run/$runtime/ready" && test ! -e "/run/$runtime/child-pid"
if test "$reuse_uid" = "$uid"; then echo 'dynamic_uid_reused=yes prior_task=gone prior_runtime=gone';
else echo 'dynamic_uid_reused=no prior_task=gone prior_runtime=gone'; fi
echo 'same unit held dynamic UID through idmapped task; stop and crash cleaned unit processes and runtime'
