#!/usr/bin/env bash
# Integration feasibility test. Temporary units and mounts belong only to this
# fixture; the helper is not an installed or production privilege boundary.
set -euo pipefail
test "$(id -u)" = 0
owner=${AGENTOC_TEST_OWNER_USER:-pinggu}
owner_uid=$(id -u "$owner") owner_gid=$(id -g "$owner")
root=$(mktemp -d /srv/agentoc-systemd-idmap-XXXXXXXX)
case "$root" in /srv/agentoc-systemd-idmap-*) ;; *) echo 'unexpected fixture path' >&2; exit 1;; esac
suffix=${root##*-}
user_a="agentoc-map-${suffix}-a" user_b="agentoc-map-${suffix}-b"
unit_a="agentoc-map-${suffix}-a.service" unit_b="agentoc-map-${suffix}-b.service"
unit_run="agentoc-map-${suffix}-task.service"
unit_reuse="agentoc-map-${suffix}-reuse.service"
started_a=0 started_b=0 started_run=0 started_reuse=0
cleanup() {
  if test "$started_run" = 1 && ! systemctl stop "$unit_run" >/dev/null 2>&1; then
    echo "Retaining fixture $root and UID units because $unit_run did not stop" >&2
    return
  fi
  if test "$started_reuse" = 1; then systemctl stop "$unit_reuse" >/dev/null 2>&1 || true; fi
  if test "$started_a" = 1; then systemctl stop "$unit_a" >/dev/null 2>&1 || true; fi
  if test "$started_b" = 1; then systemctl stop "$unit_b" >/dev/null 2>&1 || true; fi
  rm -rf -- "$root"
}
trap cleanup EXIT
for unit in "$unit_a" "$unit_b" "$unit_run" "$unit_reuse"; do
  test "$(systemctl show --property=LoadState --value "$unit")" = not-found || { echo 'fixture unit exists' >&2; exit 1; }
done
if getent passwd "$user_a" >/dev/null || getent passwd "$user_b" >/dev/null; then
  echo 'fixture user exists' >&2; exit 1
fi
chmod 0711 "$root"
mkdir "$root/source" "$root/mapped" "$root/scratch"
chown "$owner_uid:$owner_gid" "$root/source"
chmod 0700 "$root/source"
printf original > "$root/source/secret"
chown "$owner_uid:$owner_gid" "$root/source/secret"
chmod 0600 "$root/source/secret"
before=$(getfacl -cp "$root/source/secret")
script_dir=$(cd "$(dirname "$0")" && pwd)
gcc -std=c11 -Wall -Wextra -Werror -O2 "$script_dir/fixtures/linux-idmapped-workspace.c" -o "$root/helper"
systemd-run --quiet --collect --unit="$unit_a" --property=DynamicUser=yes --property="User=$user_a" /usr/bin/sleep 120
started_a=1
systemd-run --quiet --collect --unit="$unit_b" --property=DynamicUser=yes --property="User=$user_b" /usr/bin/sleep 120
started_b=1
pid_a=$(systemctl show "$unit_a" -p MainPID --value)
pid_b=$(systemctl show "$unit_b" -p MainPID --value)
uid_a=$(awk '/^Uid:/ {print $2}' "/proc/$pid_a/status")
uid_b=$(awk '/^Uid:/ {print $2}' "/proc/$pid_b/status")
gid_a=$(awk '/^Gid:/ {print $2}' "/proc/$pid_a/status")
gid_b=$(awk '/^Gid:/ {print $2}' "/proc/$pid_b/status")
test "$uid_a" -gt 0 && test "$uid_b" -gt 0 && test "$uid_a" != "$uid_b"
test "$uid_a" != "$owner_uid" && test "$uid_a" != "$(cat /proc/sys/kernel/overflowuid)"
test "$gid_a" != "$(cat /proc/sys/kernel/overflowgid)"
chown "$uid_a:$gid_a" "$root/scratch"
chmod 0700 "$root/scratch"
cat > "$root/task.sh" <<'TASK'
set -eu
mapped=$1 scratch=$2
test "$(cat "$mapped/secret")" = original
printf updated > "$mapped/secret"
printf created > "$mapped/new"
printf ready > "$scratch/ready"
exec /usr/bin/sleep 120
TASK
chmod 0644 "$root/task.sh"
systemd-run --quiet --collect --unit="$unit_run" --service-type=exec --property=NoNewPrivileges=yes \
  "$root/helper" "$root/source" "$root/mapped" "$owner_uid" "$uid_a" "$owner_gid" "$gid_a" \
  /usr/bin/setpriv --reuid "$uid_a" --regid "$gid_a" --clear-groups --no-new-privs \
  /bin/sh "$root/task.sh" "$root/mapped" "$root/scratch"
started_run=1
for i in $(seq 1 100); do test -f "$root/scratch/ready" && break; sleep 0.05; done
test -f "$root/scratch/ready" || { systemctl status "$unit_run" --no-pager >&2 || true; exit 1; }
task_pid=$(systemctl show "$unit_run" -p MainPID --value)
test "$(awk '/^Uid:/ {print $2}' "/proc/$task_pid/status")" = "$uid_a"
test "$(awk '/^NoNewPrivs:/ {print $2}' "/proc/$task_pid/status")" = 1
for cap in CapInh CapPrm CapEff CapAmb; do
  value=$(awk -v key="$cap:" '$1 == key {print $2}' "/proc/$task_pid/status")
  case "$value" in ''|*[!0]*) echo "unexpected $cap: $value" >&2; exit 1;; esac
done
grep -Fq "/system.slice/$unit_run" "/proc/$task_pid/cgroup"
test "$(cat "$root/source/secret")" = updated
test "$(stat -c %u "$root/source/new")" = "$owner_uid"
if setpriv --reuid "$uid_b" --regid "$gid_b" --clear-groups -- \
  cat "/proc/$task_pid/root$root/mapped/secret" >/dev/null 2>&1; then
  echo 'another dynamic UID read the task mount via /proc' >&2; exit 1
fi
if test -e "$root/mapped/secret"; then echo 'mount leaked to host namespace' >&2; exit 1; fi
# Deliberately release the dynamic UID while its separately launched task is
# still alive, then observe whether a new unit can inherit that numeric ID.
# This demonstrates why a production launcher must bind identity lifetime to
# the task and prevent reuse until all processes and credentials are gone.
systemctl stop "$unit_a"
started_a=0
systemd-run --quiet --collect --unit="$unit_reuse" --property=DynamicUser=yes --property="User=$user_a" /usr/bin/sleep 120
started_reuse=1
reuse_pid=$(systemctl show "$unit_reuse" -p MainPID --value)
reuse_uid=$(awk '/^Uid:/ {print $2}' "/proc/$reuse_pid/status")
reuse_gid=$(awk '/^Gid:/ {print $2}' "/proc/$reuse_pid/status")
if test "$reuse_uid" = "$uid_a"; then
  if setpriv --reuid "$reuse_uid" --regid "$reuse_gid" --clear-groups -- \
    cat "/proc/$task_pid/root$root/mapped/secret" >/dev/null 2>&1; then
    echo 'released_uid_reused=yes same_uid_proc_access=allowed'
  else
    echo 'released_uid_reused=yes same_uid_proc_access=denied'
  fi
else
  echo 'released_uid_reused=no'
fi
systemctl stop "$unit_run"
started_run=0
test ! -d "/proc/$task_pid"
test "$(getfacl -cp "$root/source/secret")" = "$before"
echo 'dynamic UID task used a private idmapped mount; cross-UID /proc access was denied'
echo 'unit stop removed the task process; original owner and ACL were preserved'
