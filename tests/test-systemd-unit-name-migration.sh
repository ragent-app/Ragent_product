#!/bin/bash
# Uses only random disposable user units; never touches a real service.
set -Eeuo pipefail
script=${1:?migration script path required}
scratch=$(mktemp -d /tmp/ragent-migration-test.XXXXXXXX)
export XDG_STATE_HOME="$scratch/state"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir" "$scratch/bin"
token=$(basename "$scratch" | tr -cd 'a-z0-9')
old="agentoc-qa-$token.service"; new="ragent-qa-$token.service"
cleanup() {
  systemctl --user disable "$new" "$old" >/dev/null 2>&1 || true
  systemctl --user stop "$new" "$old" >/dev/null 2>&1 || true
  rm -f -- "$unit_dir/$old" "$unit_dir/$new" "$unit_dir/$old.d/qa.conf" "$unit_dir/default.target.wants/$old" "$unit_dir/default.target.wants/$new"
  rmdir "$unit_dir/$old.d" 2>/dev/null || true
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  rm -rf -- "$scratch"
}
trap cleanup EXIT
[[ ! -e "$unit_dir/$old" && ! -e "$unit_dir/$new" ]] || exit 1
printf '[Service]\nExecStart=/usr/bin/sleep infinity\n[Install]\nWantedBy=default.target\n' > "$unit_dir/$old"
mkdir "$unit_dir/$old.d"
printf '[Service]\nEnvironment=RAGENT_TEST_DROPIN=preserved\n' > "$unit_dir/$old.d/qa.conf"
systemctl --user daemon-reload
systemctl --user enable --now "$old" >/dev/null
pid=$(systemctl --user show "$old" -p MainPID --value)
printf 'foreign unit\n' > "$unit_dir/$new"
if bash "$script" --user "$old" "$new"; then echo 'conflicting unit unexpectedly accepted' >&2; exit 1; fi
[[ $(cat "$unit_dir/$new") == 'foreign unit' ]]
[[ $(systemctl --user show "$old" -p MainPID --value) == "$pid" ]]
rm -- "$unit_dir/$new"
cat > "$scratch/bin/curl" <<'EOF'
#!/bin/sh
if [ -e "$RAGENT_QA_CURL_MARKER" ]; then exit 22; fi
: > "$RAGENT_QA_CURL_MARKER"
EOF
chmod 0755 "$scratch/bin/curl"
export RAGENT_QA_CURL_MARKER="$scratch/curl-marker"
if PATH="$scratch/bin:$PATH" bash "$script" --user "$old" "$new" https://example.invalid/health; then
  echo 'failure injection unexpectedly succeeded' >&2; exit 1
fi
[[ -f "$unit_dir/$old" && ! -L "$unit_dir/$old" && ! -e "$unit_dir/$new" ]]
[[ $(systemctl --user is-active "$old") == active ]]
pid=$(systemctl --user show "$old" -p MainPID --value)
[[ $pid =~ ^[1-9][0-9]*$ ]]
[[ $(systemctl --user is-enabled "$old") == enabled ]]
bash "$script" --user "$old" "$new"
[[ $(systemctl --user show "$new" -p Id --value) == "$new" ]]
[[ $(systemctl --user show "$new" -p MainPID --value) == "$pid" ]]
[[ $(systemctl --user show "$old" -p MainPID --value) == "$pid" ]]
[[ $(systemctl --user show "$new" -p Environment --value) == *RAGENT_TEST_DROPIN=preserved* ]]
systemctl --user restart "$new"
[[ $(systemctl --user show "$new" -p MainPID --value) == $(systemctl --user show "$old" -p MainPID --value) ]]
echo 'PASS live migration preserves the process; injected rollback restores the original service and drop-ins'
