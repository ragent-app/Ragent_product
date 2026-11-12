#!/usr/bin/env python3
"""Exercise the standalone Linux file adapter in an isolated root fixture."""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

if os.geteuid() != 0 or len(sys.argv) not in (2, 3):
    raise SystemExit('requires root, the preflight executable path and optional binding module')
binary = os.path.abspath(sys.argv[1])
root = pathlib.Path(tempfile.mkdtemp(prefix='ragent-target-preflight-', dir='/var/lib'))
os.chmod(root, 0o700)

def run(path, ok, reason=None):
    result = subprocess.run([binary, str(path)], capture_output=True, text=True, timeout=10)
    assert (result.returncode == 0) == ok, (path, result.returncode, result.stderr)
    if reason:
        assert result.stderr.strip() == reason, (path, result.stderr)
    return json.loads(result.stdout) if ok else None

def remove(path, snapshot, ok, reason=None):
    fields = ('mountId', 'parentDevice', 'parentInode', 'device', 'inode', 'size',
              'ctimeSeconds', 'ctimeNanoseconds', 'mtimeSeconds', 'mtimeNanoseconds')
    result = subprocess.run([binary, '--remove', str(path), *[str(snapshot[k]) for k in fields]],
                            capture_output=True, text=True, timeout=10)
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
    assert evidence['inode'] == str(stat.st_ino) and evidence['device'] == str(stat.st_dev)
    assert evidence['parentInode'] == str(root.stat().st_ino)
    assert evidence['size'] == str(len(b'unchanged')) and target.read_bytes() == b'unchanged'
    if len(sys.argv) == 3:
        script = '''import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
const { createLinuxTargetBinding, hashLinuxTargetBinding } = await import(pathToFileURL(process.argv[1]));
const facts = JSON.parse(readFileSync(0, 'utf8'));
const bound = createLinuxTargetBinding(process.argv[2], facts);
process.stdout.write(JSON.stringify({ inode: bound.inode, hash: hashLinuxTargetBinding(process.argv[2], facts) }));'''
        checked = subprocess.run(['node', '--input-type=module', '-e', script, os.path.abspath(sys.argv[2]), str(target)],
                                 input=json.dumps(evidence), capture_output=True, text=True, timeout=10, check=True)
        bound = json.loads(checked.stdout)
        assert bound['inode'] == evidence['inode'] and len(bound['hash']) == 64
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
    snapshot = run(target, True)
    bad_snapshot = dict(snapshot, inode=str(int(snapshot['inode']) + 1))
    remove(target, bad_snapshot, False, 'SNAPSHOT_MISMATCH')
    assert target.read_bytes() == b'unchanged'
    hardlink = root / 'late-hardlink'
    os.link(target, hardlink)
    remove(target, snapshot, False, 'UNTRUSTED_TARGET')
    hardlink.unlink()
    snapshot = run(target, True)
    os.chmod(root, 0o777)
    remove(target, snapshot, False, 'UNTRUSTED_DIRECTORY')
    os.chmod(root, 0o700)
    snapshot = run(target, True)
    target.write_bytes(b'changed since approval')
    remove(target, snapshot, False, 'SNAPSHOT_MISMATCH')
    assert target.read_bytes() == b'changed since approval'
    snapshot = run(target, True)
    target.rename(root / 'old-target')
    target.write_bytes(b'replacement')
    os.chmod(target, 0o600)
    remove(target, snapshot, False, 'SNAPSHOT_MISMATCH')
    assert target.read_bytes() == b'replacement'
    fresh_snapshot = run(target, True)
    assert remove(target, fresh_snapshot, True) == {'removed': True}
    assert not target.exists() and (root / 'old-target').read_bytes() == b'changed since approval'
    print('linux target adapter: isolated inspection and deletion checks passed')
finally:
    os.chmod(root, 0o700)
    shutil.rmtree(root)
