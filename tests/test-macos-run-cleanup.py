#!/usr/bin/env python3
"""Exercise the experimental same-user cleanup primitive on native macOS."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time

if sys.platform != "darwin" or len(sys.argv) != 2:
    raise SystemExit("usage on macOS: test-macos-run-cleanup.py COMPILED_HELPER")

helper = pathlib.Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix="ragent-cleanup-") as directory:
    fixture = pathlib.Path(directory) / "pids.json"
    # One tagged process, an untagged child of that process, another tagged
    # process and an argv-only lookalike. None is a child of the test runner.
    code = r'''
import json, os, subprocess, sys, time
tagged_code = """import os, subprocess, sys, time
p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)'],env={'PATH':os.defpath})
print(p.pid,flush=True)
time.sleep(120)
"""
env = dict(os.environ)
env.pop('AGENTOC_RUN_ID',None)
tagged_env = dict(env, AGENTOC_RUN_ID='run-cancel-a')
tagged = subprocess.Popen([sys.executable,'-c',tagged_code],env=tagged_env,stdout=subprocess.PIPE,text=True)
grandchild = int(tagged.stdout.readline())
other = subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)'],env=dict(env,AGENTOC_RUN_ID='run-cancel-b'))
spoof = subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)','AGENTOC_RUN_ID=run-cancel-a'],env=env)
with open(sys.argv[1],'w') as f: json.dump([tagged.pid,grandchild,other.pid,spoof.pid],f)
time.sleep(120)
'''
    env = dict(os.environ)
    env.pop("AGENTOC_RUN_ID", None)
    parent = subprocess.Popen([sys.executable, "-c", code, str(fixture)], env=env)
    pids = []
    try:
        for _ in range(100):
            try:
                pids = json.loads(fixture.read_text())
                break
            except (FileNotFoundError, json.JSONDecodeError):
                time.sleep(0.1)
        assert len(pids) == 4, "fixture did not start"
        # A same-user process beneath the app-server is not a direct child of
        # this helper's caller and must not become a cleanup root.
        identity = subprocess.run([str(helper), "--identity", str(parent.pid)], capture_output=True, text=True, check=True).stdout.split()
        assert len(identity) == 2 and all(value.isdigit() for value in identity)
        denied_identity = subprocess.run([str(helper), "--identity", str(pids[0])], check=False)
        assert denied_identity.returncode == 65
        rejected = subprocess.run([str(helper), str(pids[0]), "run-cancel-a", *identity], check=False)
        assert rejected.returncode == 65, f"unrelated root returned {rejected.returncode}"
        assert parent.poll() is None, "shared parent was stopped by rejected cleanup"
        os.kill(pids[0], 0)
        stale = [str(int(identity[0]) + 1), identity[1]]
        rejected = subprocess.run([str(helper), str(parent.pid), "run-cancel-a", *stale], check=False)
        assert rejected.returncode == 65, f"stale root identity returned {rejected.returncode}"
        os.kill(pids[0], 0)
        # A different direct child of the same caller is still not the
        # process for which the saved start-time identity was captured.
        sibling = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        try:
            rejected = subprocess.run([str(helper), str(sibling.pid), "run-cancel-a", *identity], check=False)
            assert rejected.returncode == 65, f"different child returned {rejected.returncode}"
            assert sibling.poll() is None
        finally:
            sibling.kill()
            sibling.wait()
        result = subprocess.run([str(helper), str(parent.pid), "run-cancel-a", *identity], check=False)
        assert result.returncode == 0, f"cleanup returned {result.returncode}"
        def alive(pid):
            output = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "state="], capture_output=True, text=True).stdout.strip()
            return bool(output) and not output.startswith("Z")
        for _ in range(30):
            if not alive(pids[0]) and not alive(pids[1]):
                break
            time.sleep(0.1)
        assert not alive(pids[0]) and not alive(pids[1]), "target descendants survived"
        assert alive(pids[2]) and alive(pids[3]), "another run or argv lookalike was stopped"
        assert parent.poll() is None, "shared parent was stopped"
        print("Native cleanup isolated the tagged run and preserved other processes")
    finally:
        for pid in pids:
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass
        parent.kill()
        parent.wait()
