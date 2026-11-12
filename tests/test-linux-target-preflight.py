#!/usr/bin/env python3
"""Exercise the read-only Linux target preflight in an isolated root fixture."""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

if os.geteuid() != 0 or len(sys.argv) != 2:
    raise SystemExit('requires root and the preflight executable path')
binary = os.path.abspath(sys.argv[1])
root = pathlib.Path(tempfile.mkdtemp(prefix='ragent-target-preflight-', dir='/var/lib'))
os.chmod(root, 0o700)

def run(path, ok, reason=None):
    result = subprocess.run([binary, str(path)], capture_output=True, text=True, timeout=10)
    assert (result.returncode == 0) == ok, (path, result.returncode, result.stderr)
    if reason:
        assert result.stderr.strip() == reason, (path, result.stderr)
    return json.loads(result.stdout) if ok else None

try:
    target = root / 'target'
    target.write_bytes(b'unchanged')
    os.chmod(target, 0o600)
    evidence = run(target, True)
    stat = target.stat()
    assert evidence['inode'] == stat.st_ino and evidence['device'] == stat.st_dev
    assert evidence['parentInode'] == root.stat().st_ino
    assert evidence['size'] == len(b'unchanged') and target.read_bytes() == b'unchanged'
    run('relative/path', False, 'INVALID_PATH')
    run(str(root) + '/../etc/passwd', False, 'INVALID_PATH')
    run(root, False, 'UNTRUSTED_TARGET')
    link = root / 'link'
    link.symlink_to(target)
    run(link, False, 'UNTRUSTED_TARGET')
    hardlink = root / 'hardlink'
    os.link(target, hardlink)
    run(target, False, 'UNTRUSTED_TARGET')
    hardlink.unlink()
    os.chmod(target, 0o666)
    run(target, False, 'UNTRUSTED_TARGET')
    os.chmod(target, 0o600)
    os.chmod(root, 0o777)
    run(target, False, 'UNTRUSTED_DIRECTORY')
    os.chmod(root, 0o700)
    alias = root / 'dirlink'
    alias.symlink_to(root, target_is_directory=True)
    run(alias / 'target', False, 'UNTRUSTED_DIRECTORY')
    if shutil.which('setfacl'):
        subprocess.run(['setfacl', '-m', 'u:65534:r', str(target)], check=True)
        run(target, False, 'TARGET_CHANGED_OR_UNTRUSTED')
        subprocess.run(['setfacl', '-b', str(target)], check=True)
        subprocess.run(['setfacl', '-m', 'd:u:65534:r', str(root)], check=True)
        run(target, False, 'UNTRUSTED_DIRECTORY')
        subprocess.run(['setfacl', '-k', str(root)], check=True)
    assert target.read_bytes() == b'unchanged'
    print('linux target preflight: isolated read-only checks passed')
finally:
    os.chmod(root, 0o700)
    shutil.rmtree(root)
