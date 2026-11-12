#!/bin/bash
# Isolated random user timer and oneshot service; never touches product units.
set -Eeuo pipefail
script=${1:?migration script path required}
scratch=$(mktemp -d /tmp/ragent-timer-test.XXXXXXXX)
export XDG_STATE_HOME="$scratch/state"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir" "$scratch/bin"
token=$(basename "$scratch" | tr -cd 'a-z0-9')
old="agentoc-qa-$token"; new="ragent-qa-$token"
cleanup() {
  systemctl --user disable "$new.timer" "$old.timer" >/dev/null 2>&1 || true
  systemctl --user stop "$new.timer" "$old.timer" "$new.service" "$old.service" >/dev/null 2>&1 || true
  rm -f -- "$unit_dir/$old.timer" "$unit_dir/$new.timer" "$unit_dir/$old.service" "$unit_dir/$new.service" "$unit_dir/timers.target.wants/$old.timer" "$unit_dir/timers.target.wants/$new.timer" "$unit_dir/$old.service.d/qa.conf"
  rmdir "$unit_dir/$old.service.d" 2>/dev/null || true
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user reset-failed "$new.service" "$old.service" "$new.timer" "$old.timer" >/dev/null 2>&1 || true
  rm -rf -- "$scratch"
}
trap cleanup EXIT
for ext in timer service; do [[ ! -e "$unit_dir/$old.$ext" && ! -e "$unit_dir/$new.$ext" ]] || exit 1; done
printf '[Service]\nType=oneshot\nExecStart=/usr/bin/true\n' > "$unit_dir/$old.service"
mkdir "$unit_dir/$old.service.d"
printf '[Service]\nEnvironment=RAGENT_TIMER_TEST=preserved\n' > "$unit_dir/$old.service.d/qa.conf"
printf '[Timer]\nOnBootSec=1h\nOnUnitActiveSec=2min\nUnit=%s.service\n[Install]\nWantedBy=timers.target\n' "$old" > "$unit_dir/$old.timer"
systemctl --user daemon-reload
systemctl --user enable --now "$old.timer" >/dev/null
# A timer tick already running must not be killed by migration.
printf '[Service]\nExecStart=\nExecStart=/usr/bin/sleep 30\nEnvironment=RAGENT_TIMER_TEST=preserved\n' > "$unit_dir/$old.service.d/qa.conf"
systemctl --user daemon-reload
systemctl --user start --no-block "$old.service"
for _ in {1..30}; do
  running_pid=$(systemctl --user show "$old.service" -p MainPID --value)
  [[ $running_pid =~ ^[1-9][0-9]*$ ]] && break
  sleep 0.1
done
[[ $running_pid =~ ^[1-9][0-9]*$ ]]
if bash "$script" --user "$old" "$new"; then echo 'running oneshot unexpectedly accepted' >&2; exit 1; fi
[[ $(systemctl --user show "$old.service" -p MainPID --value) == "$running_pid" ]]
[[ $(systemctl --user is-active "$old.timer") == active ]]
systemctl --user stop "$old.service"
printf '[Service]\nEnvironment=RAGENT_TIMER_TEST=preserved\n' > "$unit_dir/$old.service.d/qa.conf"
systemctl --user daemon-reload
# Fail after the new timer has been enabled, then permit rollback commands.
cat > "$scratch/bin/systemctl" <<'EOF'
#!/bin/bash
if [[ "$*" == *'enable --now ragent-qa-'* && ! -e $RAGENT_QA_SYSTEMCTL_MARKER ]]; then
  : > "$RAGENT_QA_SYSTEMCTL_MARKER"
  /usr/bin/systemctl "$@" || exit $?
  exit 1
fi
exec /usr/bin/systemctl "$@"
EOF
chmod 0755 "$scratch/bin/systemctl"
export RAGENT_QA_SYSTEMCTL_MARKER="$scratch/systemctl-marker"
if PATH="$scratch/bin:$PATH" bash "$script" --user "$old" "$new"; then echo 'injected failure unexpectedly succeeded' >&2; exit 1; fi
for ext in timer service; do [[ -f "$unit_dir/$old.$ext" && ! -L "$unit_dir/$old.$ext" && ! -e "$unit_dir/$new.$ext" ]]; done
[[ $(systemctl --user is-active "$old.timer") == active ]]
[[ $(systemctl --user is-enabled "$old.timer") == enabled ]]
bash "$script" --user "$old" "$new"
[[ $(systemctl --user show "$new.timer" -p Id --value) == "$new.timer" ]]
[[ $(systemctl --user show "$new.service" -p Id --value) == "$new.service" ]]
[[ $(systemctl --user show "$new.timer" -p Triggers --value) == "$new.service" ]]
[[ $(systemctl --user show "$new.service" -p Environment --value) == *RAGENT_TIMER_TEST=preserved* ]]
[[ $(systemctl --user is-active "$new.timer") == active ]]
[[ $(systemctl --user is-enabled "$new.timer") == enabled ]]
echo 'PASS timer pair migration preserves scheduling and drop-ins; injected failure restores original units'
