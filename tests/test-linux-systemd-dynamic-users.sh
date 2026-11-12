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
runtime="agentoc-qa-${suffix}-runtime"
state="agentoc-qa-${suffix}-state"
created_a=0
created_b=0
created_c=0
created_state=0
cleanup() {
  if [ "$created_a" = 1 ]; then systemctl stop "$a" >/dev/null 2>&1 || true; fi
  if [ "$created_b" = 1 ]; then systemctl stop "$b" >/dev/null 2>&1 || true; fi
  if [ "$created_c" = 1 ]; then systemctl stop "$c" >/dev/null 2>&1 || true; fi
  # These paths were created solely by the uniquely named test units below.
  if [ "$created_state" = 1 ]; then
    rm -rf -- "/var/lib/private/$state"
    rm -f -- "/var/lib/$state"
  fi
  case "$dir" in /srv/agentoc-dynamic-qa-*) rm -rf -- "$dir" ;; *) echo 'unexpected fixture path' >&2 ;; esac
}
trap cleanup EXIT
chmod 0711 "$dir"
if getent passwd "agentoc-qa-${suffix}-a" >/dev/null || getent passwd "agentoc-qa-${suffix}-b" >/dev/null; then
  echo 'fixture account name already exists' >&2; exit 1
fi
if [ -e "/run/$runtime" ] || [ -L "/run/$runtime" ] || [ -e "/var/lib/$state" ] || [ -L "/var/lib/$state" ] ||
   [ -e "/run/private/$runtime" ] || [ -e "/var/lib/private/$state" ]; then
  echo 'fixture directory already exists' >&2; exit 1
fi
printf fixture-secret > "$dir/credential"
chmod 0600 "$dir/credential"
cat > "$dir/run.sh" <<'EOF'
set -eu
test "$(cat "$CREDENTIALS_DIRECTORY/seed")" = fixture-secret
if [ -e "$STATE_DIRECTORY/old-state" ]; then : > "$RUNTIME_DIRECTORY/old-state-visible"; fi
printf runtime > "$RUNTIME_DIRECTORY/old-runtime"
printf state > "$STATE_DIRECTORY/old-state"
: > "$RUNTIME_DIRECTORY/ready"
exec /usr/bin/sleep 120
EOF
chmod 0644 "$dir/run.sh"
systemd-run --quiet --collect --unit="$a" --property=DynamicUser=yes --property="User=agentoc-qa-${suffix}-a" \
  --property="RuntimeDirectory=$runtime" --property="StateDirectory=$state" \
  --property="LoadCredential=seed:$dir/credential" /bin/sh "$dir/run.sh"
created_a=1
created_state=1
systemd-run --quiet --collect --unit="$b" --property=DynamicUser=yes --property="User=agentoc-qa-${suffix}-b" /usr/bin/sleep 120
created_b=1
pid_a=$(systemctl show "$a" -p MainPID --value)
pid_b=$(systemctl show "$b" -p MainPID --value)
uid_a=$(awk '/^Uid:/ {print $2}' "/proc/$pid_a/status")
uid_b=$(awk '/^Uid:/ {print $2}' "/proc/$pid_b/status")
gid_a=$(awk '/^Gid:/ {print $2}' "/proc/$pid_a/status")
gid_b=$(awk '/^Gid:/ {print $2}' "/proc/$pid_b/status")
for i in $(seq 1 100); do [ -e "/run/$runtime/ready" ] && break; sleep 0.02; done
test -e "/run/$runtime/ready"
test -e "/var/lib/$state/old-state"
if setpriv --reuid="$uid_a" --regid="$gid_a" --clear-groups cat "$dir/credential" >/dev/null 2>&1; then echo credential_source_readable; exit 1; fi
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
if [ -e "/run/$runtime" ] || [ -L "/run/$runtime" ] || [ -e "/run/private/$runtime" ]; then echo runtime_not_cleaned; exit 1; fi
test -e "/var/lib/$state/old-state"
systemd-run --quiet --collect --unit="$c" --property=DynamicUser=yes --property="User=agentoc-qa-${suffix}-a" \
  --property="RuntimeDirectory=$runtime" --property="StateDirectory=$state" \
  --property="LoadCredential=seed:$dir/credential" /bin/sh "$dir/run.sh"
created_c=1
for i in $(seq 1 100); do [ -e "/run/$runtime/ready" ] && break; sleep 0.02; done
test -e "/run/$runtime/ready"
test -e "/run/$runtime/old-state-visible"
pid_c=$(systemctl show "$c" -p MainPID --value)
uid_c=$(awk '/^Uid:/ {print $2}' "/proc/$pid_c/status")
gid_c=$(awk '/^Gid:/ {print $2}' "/proc/$pid_c/status")
if setpriv --reuid="$uid_c" --regid="$gid_c" --clear-groups cat "$dir/a" >/dev/null 2>&1; then
  printf 'recreated_uid=%s stale_file=readable\n' "$uid_c"
else
  printf 'recreated_uid=%s stale_file=denied\n' "$uid_c"
fi
systemctl kill --kill-who=main --signal=SIGKILL "$c"
for i in $(seq 1 100); do
  [ ! -e "/run/$runtime" ] && [ ! -L "/run/$runtime" ] && break
  sleep 0.05
done
if [ -e "/run/$runtime" ] || [ -L "/run/$runtime" ] || [ -e "/run/private/$runtime" ]; then echo crash_runtime_not_cleaned; exit 1; fi
test -e "/var/lib/$state/old-state"
printf 'runtime_removed=yes crash_runtime_removed=yes state_reused=yes credential_source=protected\n'
