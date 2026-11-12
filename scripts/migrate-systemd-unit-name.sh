#!/bin/bash
# Rename an enabled live systemd service without restarting it. Existing unit
# content and drop-ins stay authoritative; the old name remains an alias.
set -Eeuo pipefail
usage() { echo 'Usage: migrate-systemd-unit-name.sh [--user] <agentoc-*.service> <ragent-*.service> [health-url]' >&2; exit 2; }
mode=system
if [[ ${1:-} == --user ]]; then mode=user; shift; fi
[[ $# -ge 2 && $# -le 3 ]] || usage
old=$1; new=$2; health_url=${3:-}
[[ $old =~ ^agentoc-[a-z0-9][a-z0-9-]*\.service$ && $new == "ragent-${old#agentoc-}" ]] || usage
ctl=(systemctl)
if [[ $mode == user ]]; then
  ctl+=(--user)
  unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  backup_parent="${XDG_STATE_HOME:-$HOME/.local/state}/ragent-unit-migration"
  lock_root=${XDG_RUNTIME_DIR:-/tmp}
else
  [[ $(id -u) == 0 ]] || { echo 'root is required for system unit migration' >&2; exit 1; }
  unit_dir=/etc/systemd/system
  backup_parent=/var/backups/ragent-unit-migration
  lock_root=/run/lock
fi
mkdir -p -m 0700 "$backup_parent"
exec 9>"$lock_root/ragent-systemd-unit-migration.lock"
flock -n 9 || { echo 'another migration is running' >&2; exit 1; }
old_file="$unit_dir/$old"; new_file="$unit_dir/$new"
[[ -f $old_file && ! -L $old_file ]] || { echo 'old unit must be an existing regular file' >&2; exit 1; }
[[ ! -e $new_file && ! -L $new_file && ! -e "$new_file.d" && ! -L "$new_file.d" ]] || { echo 'new unit or drop-in already exists' >&2; exit 1; }
[[ $("${ctl[@]}" show "$old" -p FragmentPath --value) == "$old_file" ]] || { echo 'loaded unit does not match the expected file' >&2; exit 1; }
"${ctl[@]}" is-active --quiet "$old" || { echo 'old unit is not active' >&2; exit 1; }
[[ $("${ctl[@]}" is-enabled "$old") == enabled ]] || { echo 'old unit is not enabled' >&2; exit 1; }
pid=$("${ctl[@]}" show "$old" -p MainPID --value)
[[ $pid =~ ^[1-9][0-9]*$ ]] || { echo 'old unit has no main process' >&2; exit 1; }
dropins=$("${ctl[@]}" show "$old" -p DropInPaths --value)
if [[ -n $health_url ]]; then
  [[ $health_url == http://127.0.0.1:* || $health_url == https://* ]] || { echo 'health URL must be loopback HTTP or HTTPS' >&2; exit 1; }
  curl --fail --silent --show-error --max-time 10 "$health_url" >/dev/null
fi
backup=$(mktemp -d "$backup_parent/${old%.service}.XXXXXXXX")
cp -p -- "$old_file" "$backup/$old"
cp -p -- "$old_file" "$backup/$new"
printf '\n[Install]\nAlias=%s\n' "$old" >> "$backup/$new"
if [[ $mode == user ]]; then systemd-analyze --user verify "$backup/$new" >/dev/null; else systemd-analyze verify "$backup/$new" >/dev/null; fi
cmp -s -- "$old_file" "$backup/$old" || { echo 'old unit changed during preparation' >&2; exit 1; }
[[ $("${ctl[@]}" show "$old" -p MainPID --value) == "$pid" ]] || { echo 'old service restarted during preparation' >&2; exit 1; }
switched=0
created=0
link=""
rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  if [[ $status != 0 && $switched == 0 ]]; then
    [[ -z $link ]] || rm -f -- "$link"
    if [[ $created == 1 ]]; then rm -f -- "$new_file"; fi
  fi
  if [[ $status != 0 && $switched == 1 ]]; then
    echo 'Migration failed; restarting the original unit from its backup' >&2
    # Once daemon-reload adopted the new Id, replacing files alone strands the
    # live process under a not-found unit. Stop both names before restoring.
    "${ctl[@]}" stop "$new" "$old" >/dev/null 2>&1 || true
    "${ctl[@]}" disable "$new" >/dev/null 2>&1 || true
    cp -p -- "$backup/$old" "$old_file.restore"
    mv -Tf -- "$old_file.restore" "$old_file"
    rm -f -- "$new_file"
    if ! "${ctl[@]}" daemon-reload || ! "${ctl[@]}" enable --now "$old" >/dev/null 2>&1 || ! "${ctl[@]}" is-active --quiet "$old"; then
      echo 'CRITICAL: original service did not restart; manual recovery required' >&2
    fi
  fi
  exit "$status"
}
trap rollback EXIT
trap 'exit 1' HUP INT TERM
cp -p -- "$backup/$new" "$new_file"
created=1
link="$unit_dir/.ragent-migration-$old-$$"
[[ ! -e $link && ! -L $link ]] || { echo 'temporary alias exists' >&2; exit 1; }
ln -s -- "$new" "$link"
mv -Tf -- "$link" "$old_file"
switched=1
"${ctl[@]}" daemon-reload
[[ $("${ctl[@]}" show "$new" -p Id --value) == "$new" ]]
[[ $("${ctl[@]}" show "$new" -p MainPID --value) == "$pid" ]]
[[ $("${ctl[@]}" show "$new" -p DropInPaths --value) == "$dropins" ]]
"${ctl[@]}" is-active --quiet "$new"
"${ctl[@]}" enable "$new" >/dev/null
if [[ -n $health_url ]]; then curl --fail --silent --show-error --max-time 10 "$health_url" >/dev/null; fi
[[ $("${ctl[@]}" show "$new" -p MainPID --value) == "$pid" ]]
trap - EXIT HUP INT TERM
printf 'Migrated %s to %s without restarting PID %s; backup: %s\n' "$old" "$new" "$pid" "$backup"
