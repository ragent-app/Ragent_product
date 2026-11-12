#!/bin/sh
# Isolated user units only; never touch an installed Ragent unit or service.
set -eu
dir="$HOME/.config/systemd/user"
mkdir -p "$dir"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/ragent-unit-qa.XXXXXXXX")"
token="$(basename "$scratch" | tr -cd 'A-Za-z0-9')"
old="agentoc-qa-$token.service"
new="ragent-qa-$token.service"
for p in "$dir/$old" "$dir/$new" "$dir/$old.d"; do
  if [ -e "$p" ] || [ -L "$p" ]; then rmdir "$scratch"; echo 'QA unit path already exists' >&2; exit 1; fi
done
cleanup() {
  systemctl --user disable "$new" >/dev/null 2>&1 || true
  systemctl --user stop "$new" "$old" >/dev/null 2>&1 || true
  rm -f -- "$dir/$old" "$dir/$new" "$dir/$old.d/99-qa.conf" \
    "$dir/default.target.wants/$old" "$dir/default.target.wants/$new"
  rmdir "$dir/$old.d" >/dev/null 2>&1 || true
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  rmdir "$scratch" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
printf '[Service]\nExecStart=/usr/bin/sleep infinity\n[Install]\nWantedBy=default.target\n' > "$dir/$old"
mkdir "$dir/$old.d"
printf '[Service]\nEnvironment=RAGENT_QA_DROPIN=retained\n' > "$dir/$old.d/99-qa.conf"
systemctl --user daemon-reload
systemctl --user enable "$old" >/dev/null
systemctl --user start "$old"
before="$(systemctl --user show "$old" -p MainPID --value)"
printf '[Service]\nExecStart=/usr/bin/sleep infinity\n[Install]\nWantedBy=default.target\nAlias=%s\n' "$old" > "$dir/$new"
rm "$dir/$old"
ln -s "$new" "$dir/$old"
systemctl --user daemon-reload
after="$(systemctl --user show "$new" -p MainPID --value)"
[ "$before" = "$after" ] && [ "$after" != 0 ]
case "$(systemctl --user show "$new" -p Environment --value)" in *RAGENT_QA_DROPIN=retained*) ;; *) exit 1 ;; esac
systemctl --user enable "$new" >/dev/null
systemctl --user restart "$new"
old_pid="$(systemctl --user show "$old" -p MainPID --value)"
new_pid="$(systemctl --user show "$new" -p MainPID --value)"
[ "$old_pid" = "$new_pid" ] && [ "$new_pid" != 0 ]
printf '%s\n' 'PASS systemd alias migration retains process and drop-ins and restarts one service'
