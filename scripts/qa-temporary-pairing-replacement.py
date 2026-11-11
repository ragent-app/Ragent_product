#!/usr/bin/env python3
"""Camera-free live pairing and Sharesheet checks against installed AgentoC.

Use SSH for macOS or --windows-local for the installed Windows service. SSH
requires paramiko and a trusted host key. Live tests require an explicit adb
serial and matching installed test APK. Tickets stay out of repository/stdout.
"""

import argparse
from collections import deque
import getpass
import json
import ntpath
import os
import shlex
import subprocess
import sys
import threading
import time

CLI = "/Applications/AgentoC.app/Contents/Resources/agentoc-cli"
API = "/api/device-pairing/temporary/invitations"
TEST = (
    "com.andysagent.agentoc.TemporaryPairingLiveTicketTest"
    "#replacesSameInstanceClaimOnlyAfterPendingOperationIsCleared"
)
SHARE_TEST = (
    "com.andysagent.agentoc.TemporaryPairingLiveTicketTest"
    "#claimsTicketConnectsRunsNoOpAndReadsExactResult"
)
RUNNER = "com.agentoncloud.android.test/androidx.test.runner.AndroidJUnitRunner"
STAGED = (
    "/data/local/tmp/agentoc-temporary-pairing-ticket.json",
    "/data/local/tmp/agentoc-temporary-pairing-replacement-ticket.json",
)
ADB = "adb"


def windows_owner_json(method, path, body=None, *, node_path, cli_path, config_dir):
    """Use the installed service's supported CLI, retaining its named-pipe ACL."""
    env = os.environ.copy()
    env.update({
        "AGENTOC_WINDOWS_SERVICE_MODE": "1",
        "AGENTOC_CONFIG_DIR": config_dir,
        "AGENTOC_INSTANCE_ROOT": ntpath.dirname(config_dir),
        "CHAT_BIND_HOST": "127.0.0.1",
        "CHAT_PORT": "7690",
        "AGENTOC_CHAT_BASE_URL": "http://127.0.0.1:7690",
    })
    for key in ("AGENTOC_RUN_SPOOL_DIR", "AGENTOC_PROVIDER_HOMES_DIR", "AGENTOC_MEMORY_DIR",
                "AGENTOC_WORK_ROOT_DIR", "AGENTOC_PLATFORM_SKILLS_DIR", "AGENTOC_INSTANCE_KEY_FILE"):
        env[key] = ""
    argv = [node_path, cli_path, "api", method, path]
    payload = None
    if body is not None:
        argv += ["--body", "-"]
        payload = json.dumps(body, separators=(",", ":")).encode()
    result = subprocess.run(argv, input=payload, capture_output=True, timeout=45, env=env)
    if result.returncode:
        if b"EPERM" in result.stderr or b"EACCES" in result.stderr:
            raise RuntimeError("Windows Owner CLI access denied. Run this driver from an authorized administrator terminal.")
        raise RuntimeError(f"Windows Owner API {method} failed (exit {result.returncode}; stderr {len(result.stderr)} bytes)")
    try:
        return json.loads(result.stdout)
    except ValueError as exc:
        raise RuntimeError("Windows Owner API returned invalid JSON") from exc


def remote_json(ssh, method, path, body=None):
    argv = [CLI, "api", method, path]
    if body is not None:
        argv += ["--body", json.dumps(body, separators=(",", ":"))]
    _stdin, stdout, stderr = ssh.exec_command(shlex.join(argv), timeout=45)
    raw = stdout.read()
    error = stderr.read()
    status = stdout.channel.recv_exit_status()
    if status:
        # CLI errors may include sensitive server details. Do not echo them.
        raise RuntimeError(f"Mac Owner API {method} failed (exit {status}; stderr {len(error)} bytes)")
    try:
        return json.loads(raw)
    except ValueError as exc:
        raise RuntimeError("Mac Owner API returned invalid JSON") from exc


def adb(serial, *args, input_bytes=None, timeout=45):
    result = subprocess.run(
        [ADB, "-s", serial, *args], input=input_bytes, capture_output=True, timeout=timeout
    )
    if result.returncode:
        raise RuntimeError(f"adb command failed (exit {result.returncode})")
    return result.stdout


def observe_android_test(serial):
    """Keep only controlled milestones and process/crash facts while logcat rotates."""
    recent = deque(maxlen=60)
    # Without -T, logcat replays historical crashes and can falsely attribute
    # an old ClassNotFoundException to this invitation's test run.
    since = adb(serial, "shell", "date", "+%m-%dT%H:%M:%S.000").decode().strip().replace("T", " ")
    commands = (
        (["-v", "brief", "-s", "TemporaryPairingLiveQA:I", "AndroidRuntime:E", "*:S"],
         lambda line: "TemporaryPairingLiveQA" in line or "FATAL EXCEPTION" in line or
         "Process:" in line or "Exception:" in line),
        (["-b", "events", "-v", "brief", "-s", "am_proc_died:I", "am_kill:I", "*:S"],
         lambda line: "com.agentoncloud.android" in line),
    )
    processes = []
    threads = []
    for options, keep in commands:
        process = subprocess.Popen([ADB, "-s", serial, "logcat", "-T", since, *options],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        processes.append(process)

        def read_lines(pipe=process.stdout, predicate=keep):
            for raw in pipe:
                line = raw.decode(errors="replace").strip()
                if predicate(line):
                    recent.append(line[:300])

        thread = threading.Thread(target=read_lines, daemon=True)
        thread.start()
        threads.append(thread)
    return recent, processes, threads


def main(argv=None):
    global ADB
    parser = argparse.ArgumentParser(description=__doc__)
    destination = parser.add_mutually_exclusive_group(required=True)
    destination.add_argument("--host", help="macOS SSH host")
    destination.add_argument("--windows-local", action="store_true", help="Use installed Windows service Owner CLI")
    parser.add_argument("--user", help="macOS SSH user")
    payload = ntpath.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "AgentoC", "payload")
    parser.add_argument("--windows-node", default=ntpath.join(payload, "node.exe"))
    parser.add_argument("--windows-cli", default=ntpath.join(payload, "cli.js"))
    parser.add_argument("--windows-config", default=ntpath.join(
        os.environ.get("ProgramData", r"C:\ProgramData"), "AgentoC", "instances", "owner", "config"))
    parser.add_argument("--serial")
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--mode", choices=("replacement", "share", "files"), default="replacement")
    parser.add_argument("--file-bytes", type=int,
                        help="Use a synthetic CSV of this exact size in files mode (256 KiB–5 MiB)")
    parser.add_argument("--check-active", action="store_true", help="Read PC health and invitation status only")
    args = parser.parse_args(argv)
    if args.host and not args.user:
        parser.error("--user is required with --host")
    if args.file_bytes is not None and (
        args.mode != "files" or not 256 * 1024 < args.file_bytes <= 5 * 1024 * 1024
    ):
        parser.error("--file-bytes requires --mode files and a value from 262145 through 5242880")
    if not args.check_active and not args.serial:
        parser.error("--serial is required for the live test")
    ADB = args.adb
    ssh = None
    if args.windows_local:
        pc_label = "Windows"
        def owner_json(method, path, body=None):
            return windows_owner_json(method, path, body, node_path=args.windows_node,
                                      cli_path=args.windows_cli, config_dir=args.windows_config)
    else:
        import paramiko
        pc_label = "Mac"
        password = getpass.getpass("Mac SSH password: ")
        ssh = paramiko.SSHClient()
        ssh.load_system_host_keys()
        ssh.set_missing_host_key_policy(paramiko.RejectPolicy())
        ssh.connect(args.host, username=args.user, password=password, timeout=15, auth_timeout=15)
        password = None
        def owner_json(method, path, body=None):
            return remote_json(ssh, method, path, body)
    invitation_ids = []
    staging_started = False
    try:
        ready = owner_json("GET", "/healthz")
        if ready.get("status") != "ready":
            raise RuntimeError(f"{pc_label} Agent is not ready")
        # Verify an Owner-only route before any Android staging or new invite.
        rows = owner_json("GET", API).get("invitations", [])
        if args.check_active:
            print(f"{pc_label} invitation count: {len(rows)}")
            for row in rows[-2:]:
                print(f"Latest invitation: {row.get('status', 'unknown')}; "
                      f"claimed: {row.get('grant') is not None}; "
                      f"completion confirmed: {row.get('delivery', {}).get('completionConfirmed')}; "
                      f"remote revocation confirmed: {row.get('delivery', {}).get('revocationConfirmed')}")
            return
        # A failed Owner preflight must not delete another test's staged ticket.
        staging_started = True
        adb(args.serial, "shell", "rm", "-f", *STAGED)
        for path in (STAGED if args.mode == "replacement" else STAGED[:1]):
            response = owner_json(
                "POST", API, {"claimTtlMs": 120000, "accessTtlMs": 600000}
            )
            invitation = response["invitation"]
            invitation_ids.append(invitation["envelope"]["invitation"]["invitationId"])
            ticket = {
                "version": 1,
                "envelope": invitation["envelope"],
                "token": invitation["token"],
            }
            adb(args.serial, "shell", "sh", "-c", f"cat > {path}",
                input_bytes=json.dumps(ticket, separators=(",", ":")).encode())
        print(f"Short-lived tickets staged; running camera-free {args.mode} test.", flush=True)
        test_args = (
            ["-e", "liveTemporaryPairingReplacement", "true", "-e", "class", TEST]
            if args.mode == "replacement" else
            ["-e", "liveTemporaryPairingTicket", "true",
             "-e", "liveTemporaryPairingShareRoute", "true",
             "-e", "liveTemporaryPairingSystemChooser", "true",
             "-e", "class", SHARE_TEST] +
            (["-e", "liveTemporaryPairingFiles", "true"] if args.mode == "files" else []) +
            (["-e", "liveTemporaryPairingFileBytes", str(args.file_bytes)]
             if args.file_bytes is not None else [])
        )
        recent, monitors, monitor_threads = observe_android_test(args.serial)
        try:
            output = adb(
                args.serial, "shell", "am", "instrument", "-w", *test_args, RUNNER,
                timeout=360,
            ).decode(errors="replace")
            print(output, flush=True)
            if "OK (1 test)" not in output:
                raise RuntimeError(f"Android {args.mode} test did not pass")
        except Exception:
            print("Android test milestones and process events:", file=sys.stderr)
            for line in recent:
                print(line, file=sys.stderr)
            raise
        finally:
            for monitor in monitors:
                monitor.terminate()
            for monitor in monitors:
                try:
                    monitor.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    monitor.kill()
            for thread in monitor_threads:
                thread.join(timeout=1)
    finally:
        cleanup_failed = False
        if staging_started:
            try:
                adb(args.serial, "shell", "rm", "-f", *STAGED)
            except Exception:
                print("Warning: could not confirm emulator staging cleanup", file=sys.stderr)
                cleanup_failed = True
        for invitation_id in invitation_ids:
            try:
                revoked = owner_json("POST", f"{API}/{invitation_id}/revoke")
                state = revoked.get("invitation", {}).get("status", "unknown")
                print(f"{pc_label} invitation cleanup: {state}")
                if state != "REVOKED":
                    cleanup_failed = True
            except Exception:
                print(f"Warning: could not confirm {pc_label} invitation revocation", file=sys.stderr)
                cleanup_failed = True
        if invitation_ids and not cleanup_failed:
            for _attempt in range(10):
                try:
                    rows = owner_json("GET", API).get("invitations", [])
                    by_id = {row.get("invitationId"): row for row in rows}
                    if all(by_id.get(identity, {}).get("status") == "REVOKED" and
                           by_id[identity].get("delivery", {}).get("revocationConfirmed")
                           for identity in invitation_ids):
                        print(f"{pc_label} broker revocation confirmed for all test tickets.")
                        break
                except Exception:
                    pass
                time.sleep(2)
            else:
                print(f"Warning: {pc_label} broker revocation was not confirmed", file=sys.stderr)
                cleanup_failed = True
        if ssh is not None:
            ssh.close()
        if cleanup_failed and sys.exc_info()[0] is None:
            raise RuntimeError("Temporary invitation cleanup is unconfirmed")


if __name__ == "__main__":
    main()
