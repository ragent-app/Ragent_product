#!/bin/sh
# Destructive only within a new /srv fixture and its uniquely named transient
# systemd units. Requires root and a running systemd; never touches product data.
set -eu
if [ "$(id -u)" -ne 0 ]; then echo 'root required' >&2; exit 1; fi
dir=$(mktemp -d /srv/agentoc-dynamic-qa-XXXXXXXX)
suffix=${dir##*-}
a="agentoc-qa-dynamic-${suffix}-a.service"
b="agentoc-qa-dynamic-${suffix}-b.service"
c="agentoc-qa-dynamic-${suffix}-c.service"
created_a=0
created_b=0
created_c=0
cleanup() {
  if [ "$created_a" = 1 ]; then systemctl stop "$a" >/dev/null 2>&1 || true; fi
  if [ "$created_b" = 1 ]; then systemctl stop "$b" >/dev/null 2>&1 || true; fi
  if [ "$created_c" = 1 ]; then systemctl stop "$c" >/dev/null 2>&1 || true; fi
  case "$dir" in /srv/agentoc-dynamic-qa-*) rm -rf -- "$dir" ;; *) echo 'unexpected fixture path' >&2 ;; esac
}
trap cleanup EXIT
chmod 0711 "$dir"
if getent passwd "agentoc-qa-${suffix}-a" >/dev/null || getent passwd "agentoc-qa-${suffix}-b" >/dev/null; then
  echo 'fixture account name already exists' >&2; exit 1
fi
systemd-run --quiet --collect --unit="$a" --property=DynamicUser=yes --property="User=agentoc-qa-${suffix}-a" /usr/bin/sleep 120
created_a=1
systemd-run --quiet --collect --unit="$b" --property=DynamicUser=yes --property="User=agentoc-qa-${suffix}-b" /usr/bin/sleep 120
created_b=1
pid_a=$(systemctl show "$a" -p MainPID --value)
pid_b=$(systemctl show "$b" -p MainPID --value)
uid_a=$(awk '/^Uid:/ {print $2}' "/proc/$pid_a/status")
uid_b=$(awk '/^Uid:/ {print $2}' "/proc/$pid_b/status")
gid_a=$(awk '/^Gid:/ {print $2}' "/proc/$pid_a/status")
gid_b=$(awk '/^Gid:/ {print $2}' "/proc/$pid_b/status")
test "$uid_a" -gt 0 && test "$uid_b" -gt 0 && test "$uid_a" != "$uid_b"
printf a > "$dir/a"
printf b > "$dir/b"
chown "$uid_a:$gid_a" "$dir/a"
chown "$uid_b:$gid_b" "$dir/b"
chmod 0600 "$dir/a" "$dir/b"
test "$(setpriv --reuid="$uid_a" --regid="$gid_a" --clear-groups cat "$dir/a")" = a
test "$(setpriv --reuid="$uid_b" --regid="$gid_b" --clear-groups cat "$dir/b")" = b
if setpriv --reuid="$uid_a" --regid="$gid_a" --clear-groups cat "$dir/b" >/dev/null 2>&1; then echo cross_file_read_allowed; exit 1; fi
if setpriv --reuid="$uid_a" --regid="$gid_a" --clear-groups cat "/proc/$pid_b/environ" >/dev/null 2>&1; then echo cross_process_environ_allowed; exit 1; fi
if setpriv --reuid="$uid_a" --regid="$gid_a" --clear-groups kill -0 "$pid_b" >/dev/null 2>&1; then echo cross_process_signal_allowed; exit 1; fi
printf 'UID_A=%s GID_A=%s UID_B=%s GID_B=%s\n' "$uid_a" "$gid_a" "$uid_b" "$gid_b"
printf 'own_file=ok cross_file=denied cross_proc_environ=denied cross_signal=denied\n'
systemctl stop "$a"
created_a=0
systemd-run --quiet --collect --unit="$c" --property=DynamicUser=yes --property="User=agentoc-qa-${suffix}-a" /usr/bin/sleep 120
created_c=1
pid_c=$(systemctl show "$c" -p MainPID --value)
uid_c=$(awk '/^Uid:/ {print $2}' "/proc/$pid_c/status")
gid_c=$(awk '/^Gid:/ {print $2}' "/proc/$pid_c/status")
if setpriv --reuid="$uid_c" --regid="$gid_c" --clear-groups cat "$dir/a" >/dev/null 2>&1; then
  printf 'recreated_uid=%s stale_file=readable\n' "$uid_c"
else
  printf 'recreated_uid=%s stale_file=denied\n' "$uid_c"
fi
