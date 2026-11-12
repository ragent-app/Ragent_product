#!/bin/bash
set -u
package=$1
app=$2
parent=$4
result=$5
port=${6:-7690}
digest=$7
case "$port" in ''|*[!0-9]*) exit 1 ;; esac
case "$digest" in *[!0-9a-f]*|'') exit 1 ;; esac
[ "${#digest}" = 64 ] || exit 1
[ "$(/usr/bin/shasum -a 256 "$package" | /usr/bin/awk '{print $1}')" = "$digest" ] || exit 1
dir=$(dirname "$package")
mount="$dir/mount"
backup="${app}.ragent-update-backup-$$"
failed="${app}.ragent-update-failed-$$"
cli="$app/Contents/Resources/ragent"
stop="$app/Contents/Resources/ragent-stop"
status() { printf '{"status":"%s","digest":"%s"}\n' "$1" "$digest" > "$result"; }
fail() { status failed; "$cli" restart-check --end --json >/dev/null 2>&1 || true; /usr/bin/open "$app" >/dev/null 2>&1 || true; exit 1; }
mkdir -p "$mount" || fail
/usr/bin/hdiutil attach -readonly -nobrowse -mountpoint "$mount" "$package" >/dev/null || fail
trap '/usr/bin/hdiutil detach "$mount" >/dev/null 2>&1 || true' EXIT
[ -d "$mount/Ragent.app" ] || fail
[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$mount/Ragent.app/Contents/Info.plist")" = cloud.agenton.ragent ] || fail
while :; do
  "$cli" restart-check --json >/dev/null 2>&1
  code=$?
  [ "$code" = 0 ] && break
  if [ "$code" != 3 ]; then fail; fi
  echo RAGENT_WAITING
  sleep 5
done
echo RAGENT_READY
exec > "$dir/install.log" 2>&1
for n in $(seq 1 90); do kill -0 "$parent" 2>/dev/null || break; sleep 1; done
if kill -0 "$parent" 2>/dev/null; then fail; fi
"$stop" || fail
# A single installed bundle can host multiple instances. Never replace it
# while another instance is still running from the same bundle.
server_command="$app/Contents/Resources/runtime/node $app/Contents/Resources/app/chat-server.mjs"
if /bin/ps -ax -o command= | /usr/bin/grep -Fx "$server_command" >/dev/null; then fail; fi
printf -v qapp '%q' "$app"
printf -v qbackup '%q' "$backup"
printf -v qnew '%q' "$mount/Ragent.app"
printf -v qfailed '%q' "$failed"
command="test ! -e $qbackup && test ! -e $qfailed && mv $qapp $qbackup && ( /usr/bin/ditto $qnew $qapp || { if test -e $qapp; then mv $qapp $qfailed; fi; mv $qbackup $qapp; exit 1; } )"
run_command() {
  if [ -w "$(dirname "$app")" ]; then /bin/bash -c "$1"; else
    /usr/bin/osascript -e 'on run argv' -e 'do shell script (item 1 of argv) with administrator privileges' -e 'end run' "$1"
  fi
}
if ! run_command "$command"; then
  if [ -e "$backup" ] && [ ! -e "$app" ]; then run_command "mv $qbackup $qapp" || true; fi
  fail
fi
"$app/Contents/Resources/ragent" restart-check --end --json >/dev/null 2>&1 || true
/usr/bin/open "$app" || true
for n in $(seq 1 60); do
  if /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
    if /usr/bin/hdiutil detach "$mount" >/dev/null 2>&1; then trap - EXIT; status installed; exit 0; fi
    status failed; exit 1
  fi
  sleep 1
done
# Restore the old application only after verifying that no new task is active.
if "$app/Contents/Resources/ragent" restart-check --json >/dev/null 2>&1 && "$app/Contents/Resources/ragent-stop"; then
  if run_command "mv $qapp $qfailed && mv $qbackup $qapp"; then
    "$cli" restart-check --end --json >/dev/null 2>&1 || true
    /usr/bin/open "$app" >/dev/null 2>&1 || true
  fi
fi
status failed
exit 1
