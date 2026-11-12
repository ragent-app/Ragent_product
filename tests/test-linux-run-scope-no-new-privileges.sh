#!/usr/bin/env bash
# Isolated root/systemd integration fixture; never reuse or stop an existing unit.
set -euo pipefail
test "$(id -u)" = 0
runner=${AGENTOC_TEST_RUNNER_USER:-agentoc-runner}
uid=$(id -u "$runner")
gid=$(id -g "$runner")
unprotected=agentoc-runner-run_noprivcheck1-a2.service
protected=agentoc-runner-run_test12345678-a2.service
groupdrop=agentoc-runner-run_nnpdropcase-a2.service
withcap=agentoc-runner-run_nnpcapcheck-a2.service
for unit in "$unprotected" "$protected" "$groupdrop" "$withcap"; do
  test "$(systemctl show --property=LoadState --value "$unit")" = not-found || {
    printf 'Refusing existing systemd unit: %s\n' "$unit" >&2; exit 1;
  }
done
started_unprotected=0
started_protected=0
started_groupdrop=0
started_withcap=0
cleanup() {
  if test "$started_unprotected" = 1; then systemctl stop "$unprotected" || true; fi
  if test "$started_protected" = 1; then systemctl stop "$protected" || true; fi
  if test "$started_groupdrop" = 1; then systemctl stop "$groupdrop" || true; fi
  if test "$started_withcap" = 1; then systemctl stop "$withcap" || true; fi
}
trap cleanup EXIT
systemd-run --quiet --collect --unit="$unprotected" --slice=agentoc-runners.slice \
  --property="User=$runner" --property=NoNewPrivileges=no /usr/bin/sleep 120
started_unprotected=1
systemd-run --quiet --collect --unit="$protected" --slice=agentoc-runners.slice \
  --property="User=$runner" --property=NoNewPrivileges=yes /usr/bin/sleep 120
started_protected=1
systemd-run --quiet --collect --unit="$groupdrop" --slice=agentoc-runners.slice \
  --property=NoNewPrivileges=yes /usr/bin/setpriv --reuid "$uid" --regid "$gid" --clear-groups /usr/bin/sleep 120
started_groupdrop=1
systemd-run --quiet --collect --unit="$withcap" --slice=agentoc-runners.slice \
  --property="User=$runner" --property=NoNewPrivileges=yes \
  --property=AmbientCapabilities=CAP_NET_BIND_SERVICE /usr/bin/sleep 120
started_withcap=1
export AGENTOC_TEST_SYSTEMD_UID="$uid"
export AGENTOC_TEST_SYSTEMD_INVOCATION
AGENTOC_TEST_SYSTEMD_INVOCATION=$(systemctl show --property=InvocationID --value "$protected")
node --input-type=module -e '
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { captureLinuxRunUnitIdentity } from "./scripts/linux-run-unit-liveness.mjs";
const runnerUid = Number(process.env.AGENTOC_TEST_SYSTEMD_UID);
assert.equal(await captureLinuxRunUnitIdentity({runId:"run_noprivcheck1", launchAttempt:2, runnerUid}), null);
const pid = execFileSync("systemctl", ["show", "--property=MainPID", "--value", "agentoc-runner-run_nnpcapcheck-a2.service"], {encoding:"utf8"}).trim();
const status = await readFile(`/proc/${pid}/status`, "utf8");
assert.match(status, /^NoNewPrivs:\s*1$/m);
assert.match(status, /^CapEff:\s*0*[1-9a-f][0-9a-f]*$/m);
assert.equal(await captureLinuxRunUnitIdentity({runId:"run_nnpcapcheck", launchAttempt:2, runnerUid}), null);
let dropped = null;
for (let i=0; i<20 && !dropped; i++) {
  dropped = await captureLinuxRunUnitIdentity({runId:"run_nnpdropcase", launchAttempt:2, runnerUid});
  if (!dropped) await new Promise(resolve => setTimeout(resolve, 50));
}
assert.ok(dropped, "the root launcher must still drop to the runner with no-new-privileges enabled");
'
node --test tests/test-linux-run-unit-liveness.mjs tests/test-linux-run-context-store.mjs \
  tests/test-linux-run-scope-renewal-systemd.mjs tests/test-runner-lifecycle-broker.mjs
