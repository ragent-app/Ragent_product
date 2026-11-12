#!/bin/bash
# Migrate one enabled timer and its inactive oneshot service as a pair.
set -Eeuo pipefail
usage() { echo 'Usage: migrate-systemd-timer-pair.sh [--user] <agentoc-base> <ragent-base>' >&2; exit 2; }
mode=system
if [[ ${1:-} == --user ]]; then mode=user; shift; fi
[[ $# == 2 ]] || usage
old=$1; new=$2
[[ $old =~ ^agentoc-[a-z0-9][a-z0-9-]*$ && $new == "ragent-${old#agentoc-}" ]] || usage
ctl=(systemctl)
if [[ $mode == user ]]; then
  ctl+=(--user); unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  backup_parent="${XDG_STATE_HOME:-$HOME/.local/state}/ragent-unit-migration"; lock_root=${XDG_RUNTIME_DIR:-/tmp}
else
  [[ $(id -u) == 0 ]] || { echo 'root is required' >&2; exit 1; }
  unit_dir=/etc/systemd/system; backup_parent=/var/backups/ragent-unit-migration; lock_root=/run/lock
fi
mkdir -p -m 0700 "$backup_parent"
exec 9>"$lock_root/ragent-systemd-unit-migration.lock"
flock -n 9 || { echo 'another migration is running' >&2; exit 1; }
for ext in service timer; do
  old_file="$unit_dir/$old.$ext"; new_file="$unit_dir/$new.$ext"
  [[ -f $old_file && ! -L $old_file ]] || { echo "old $ext must be a regular unit file" >&2; exit 1; }
  [[ ! -e $new_file && ! -L $new_file && ! -e "$new_file.d" && ! -L "$new_file.d" ]] || { echo "new $ext or drop-in already exists" >&2; exit 1; }
  [[ $("${ctl[@]}" show "$old.$ext" -p FragmentPath --value) == "$old_file" ]] || { echo "unexpected $ext fragment" >&2; exit 1; }
done
"${ctl[@]}" is-active --quiet "$old.timer" || { echo 'old timer is not active' >&2; exit 1; }
[[ $("${ctl[@]}" is-enabled "$old.timer") == enabled ]] || { echo 'old timer is not enabled' >&2; exit 1; }
[[ $("${ctl[@]}" show "$old.service" -p Type --value) == oneshot ]] || { echo 'service is not oneshot' >&2; exit 1; }
timer_dropins=$("${ctl[@]}" show "$old.timer" -p DropInPaths --value)
service_dropins=$("${ctl[@]}" show "$old.service" -p DropInPaths --value)
backup=$(mktemp -d "$backup_parent/$old.XXXXXXXX")
for ext in service timer; do cp -p -- "$unit_dir/$old.$ext" "$backup/$old.$ext"; cp -p -- "$unit_dir/$old.$ext" "$backup/$new.$ext"; done
# Require the explicit trigger so changing the timer target is unambiguous.
[[ $(grep -Fxc "Unit=$old.service" "$backup/$new.timer") == 1 ]] || { echo 'timer must have exactly one expected explicit Unit' >&2; exit 1; }
sed -i "s/^Unit=$old\\.service$/Unit=$new.service/" "$backup/$new.timer"
printf '\n[Install]\nAlias=%s.service\n' "$old" >> "$backup/$new.service"
printf '\n[Install]\nAlias=%s.timer\n' "$old" >> "$backup/$new.timer"
if [[ $mode == user ]]; then systemd-analyze --user verify "$backup/$new.service" "$backup/$new.timer" >/dev/null; else systemd-analyze verify "$backup/$new.service" "$backup/$new.timer" >/dev/null; fi
for ext in service timer; do cmp -s -- "$unit_dir/$old.$ext" "$backup/$old.$ext" || { echo 'unit changed during preparation' >&2; exit 1; }; done
stopped=0; switched=0; created_service=0; created_timer=0; link=""
rollback() {
  status=$?; trap - EXIT HUP INT TERM
  if [[ $status != 0 && $stopped == 1 ]]; then
    if [[ -n $link && -L $link ]]; then rm -f -- "$link"; fi
    echo 'Migration failed; restoring the original timer and service units' >&2
    "${ctl[@]}" stop "$new.timer" "$old.timer" >/dev/null 2>&1 || true
    if [[ $switched == 1 ]]; then "${ctl[@]}" disable "$new.timer" >/dev/null 2>&1 || true; fi
    for ext in service timer; do
      cp -p -- "$backup/$old.$ext" "$unit_dir/$old.$ext.restore"
      mv -Tf -- "$unit_dir/$old.$ext.restore" "$unit_dir/$old.$ext"
    done
    if [[ $created_service == 1 ]]; then rm -f -- "$unit_dir/$new.service"; fi
    if [[ $created_timer == 1 ]]; then rm -f -- "$unit_dir/$new.timer"; fi
    if ! "${ctl[@]}" daemon-reload || ! "${ctl[@]}" enable --now "$old.timer" >/dev/null 2>&1 || ! "${ctl[@]}" is-active --quiet "$old.timer"; then
      echo 'CRITICAL: original timer did not restart; manual recovery required' >&2
    fi
  fi
  exit "$status"
}
trap rollback EXIT
trap 'exit 1' HUP INT TERM
stopped=1
"${ctl[@]}" stop "$old.timer"
service_state=$("${ctl[@]}" show "$old.service" -p ActiveState --value)
if [[ $service_state != inactive && $service_state != failed ]]; then echo "oneshot is $service_state; retry later" >&2; exit 1; fi
for ext in service timer; do
  cp -p -- "$backup/$new.$ext" "$unit_dir/$new.$ext"
  if [[ $ext == service ]]; then created_service=1; else created_timer=1; fi
  link="$unit_dir/.ragent-migration-$old.$ext-$$"
  [[ ! -e $link && ! -L $link ]] || { echo 'temporary alias exists' >&2; exit 1; }
  ln -s -- "$new.$ext" "$link"
  mv -Tf -- "$link" "$unit_dir/$old.$ext"
done
switched=1
"${ctl[@]}" daemon-reload
[[ $("${ctl[@]}" show "$new.timer" -p Id --value) == "$new.timer" ]]
[[ $("${ctl[@]}" show "$new.service" -p Id --value) == "$new.service" ]]
[[ $("${ctl[@]}" show "$new.timer" -p DropInPaths --value) == "$timer_dropins" ]]
[[ $("${ctl[@]}" show "$new.service" -p DropInPaths --value) == "$service_dropins" ]]
[[ $("${ctl[@]}" show "$new.timer" -p Triggers --value) == "$new.service" ]]
"${ctl[@]}" enable --now "$new.timer" >/dev/null
"${ctl[@]}" is-active --quiet "$new.timer"
trap - EXIT HUP INT TERM
printf 'Migrated %s timer and service to %s; backup: %s\n' "$old" "$new" "$backup"
