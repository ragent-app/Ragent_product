"""Kill only the verified QA parent PID, then test real cold recovery on an explicit device."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import time

APP = "com.agentoncloud.android"
RUNNER = APP + ".test/androidx.test.runner.AndroidJUnitRunner"
WORKER = APP + ":document_export"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adb", required=True)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--evidence", required=True)
    args = parser.parse_args()
    evidence = Path(args.evidence).resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    prefix = [args.adb, "-s", args.serial]

    def adb(*arguments, check=True, timeout=10):
        result = subprocess.run(prefix + list(arguments), capture_output=True, timeout=timeout)
        if check and result.returncode:
            raise RuntimeError(result.stderr.decode("utf-8", errors="replace"))
        return result.stdout.decode("utf-8", errors="replace").strip()

    def pids(name):
        return {int(value) for value in adb("shell", "pidof", name, check=False).split() if value.isdigit()}

    assert adb("get-state") == "device"
    # The fixture writes this marker only after its provider confirms blocked-open.
    adb("shell", "run-as", APP, "rm", "-f", "files/qa-document-worker-window.json")
    seed_log = evidence / "parent-death-seed.log"
    with seed_log.open("wb") as output:
        seed = subprocess.Popen(prefix + ["shell", "am", "instrument", "-w", "-r", "-e", "class",
            "com.andysagent.ragent.ResultShareProviderTest#blockedProviderDeadlineRecordsInterruptionAndKeepsOriginal",
            "-e", "documentWorkerDeathWindow", "true", RUNNER], stdout=output, stderr=subprocess.STDOUT)
        marker = None
        until = time.monotonic() + 45
        while time.monotonic() < until and seed.poll() is None:
            text = adb("exec-out", "run-as", APP, "cat", "files/qa-document-worker-window.json", check=False)
            try:
                candidate = json.loads(text)
                if candidate["parentPid"] in pids(APP) and candidate["workerPid"] in pids(WORKER):
                    marker = candidate
                    break
            except (ValueError, KeyError, TypeError):
                pass
            time.sleep(0.15)
        if marker is None:
            # Preserve and observe this same invocation; never launch another to hide a failed window.
            seed.wait(timeout=30)
            raise RuntimeError("No live parent/worker copy window was established; inspect seed log")
        ticket = marker["ticketId"]
        assert re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", ticket)
        metadata = json.loads(adb("exec-out", "run-as", APP, "cat", f"no_backup/ragent-document-saves/{ticket}.json"))
        assert metadata["state"] == "COPYING" and metadata["ticketId"] == ticket
        assert metadata["operationId"] == marker["operationId"] and metadata["sha256"] == marker["sha256"]
        assert marker["parentPid"] != marker["workerPid"]
        (evidence / "parent-death-before.json").write_text(json.dumps({"marker": marker, "journal": metadata}, indent=2), encoding="utf-8")
        # run-as remains this app's UID. No force-stop: that would also kill the worker and hide Binder death behavior.
        adb("shell", "run-as", APP, "kill", "-9", str(marker["parentPid"]))
        until = time.monotonic() + 10
        while time.monotonic() < until and (marker["parentPid"] in pids(APP) or marker["workerPid"] in pids(WORKER)):
            time.sleep(0.1)
        assert marker["parentPid"] not in pids(APP), "Parent kill not confirmed"
        assert marker["workerPid"] not in pids(WORKER), "Worker survived the parent"
        seed.wait(timeout=10)
    recovery = subprocess.run(prefix + ["shell", "am", "instrument", "-w", "-r", "-e", "class",
        "com.andysagent.ragent.DocumentWorkerParentDeathTest", "-e", "documentWorkerDeathWindow", "true", RUNNER],
        capture_output=True, timeout=60)
    recovery_log = recovery.stdout.decode("utf-8", errors="replace") + recovery.stderr.decode("utf-8", errors="replace")
    (evidence / "parent-death-recovery.log").write_text(recovery_log, encoding="utf-8")
    assert recovery.returncode == 0 and "OK (1 test)" in recovery_log, recovery_log[-4000:]
    assert not pids(WORKER), "Cold recovery started another document worker"
    result = {"serial": args.serial, "api": adb("shell", "getprop", "ro.build.version.sdk"),
        "old_parent_pid": marker["parentPid"], "worker_pid": marker["workerPid"],
        "parent_exit_verified": True, "worker_exit_verified": True, "cold_recovery_ok": True,
        "source_sha256": marker["sha256"], "source_bytes": marker["sizeBytes"],
        "seed_exit_code": seed.returncode, "recovery_exit_code": recovery.returncode}
    (evidence / "parent-death-verification.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
