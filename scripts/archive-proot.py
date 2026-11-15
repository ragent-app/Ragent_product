#!/usr/bin/env python3
"""Stream a PRoot release archive with portable executable permissions."""
import json
import hashlib
import os
import pathlib
import shutil
import sys
import tarfile

root = pathlib.Path(sys.argv[1]).resolve()
output = pathlib.Path(sys.argv[2]).resolve()
manifest = json.loads((root / 'app' / 'proot-source-manifest.json').read_text(encoding='utf-8'))
executable_sources = {item['path'] for item in manifest['files'] if item['mode'] == 0o755}

# Linux shebangs and release identifiers must not depend on the build host's
# text-mode newline handling. Fail before writing any archive if they do.
for rel in ('VERSION', 'RELEASE_ID', 'ragent', 'install.sh', 'termux-ragent', 'runtime/npm',
            'runtime/corepack', 'runtime/codex', 'runtime/claude',
            'runtime/ragent-codex-app-server'):
    data = (root / rel).read_bytes()
    if b'\r' in data or not data.endswith(b'\n'):
        raise SystemExit(f'{rel} must use LF line endings')
    if rel not in ('VERSION', 'RELEASE_ID') and not data.startswith(b'#!'):
        raise SystemExit(f'{rel} is missing its shebang')

content_bytes = (root / 'release-content-manifest.json').read_bytes()
content = json.loads(content_bytes)
identity = hashlib.sha256(content_bytes).hexdigest()
if (root / 'RELEASE_ID').read_bytes() != f"{content['publicVersion']}-{identity[:16]}\n".encode('ascii'):
    raise SystemExit('Release identity does not match content manifest')
expected = {entry['path']: entry for entry in content['files']}
seen = set()
for directory, dirs, names in os.walk(root, followlinks=False):
    for name in list(dirs):
        if (pathlib.Path(directory) / name).is_symlink():
            dirs.remove(name)
            names.append(name)
    for name in names:
        path = pathlib.Path(directory) / name
        rel = path.relative_to(root).as_posix()
        if rel in ('RELEASE_ID', 'release-content-manifest.json'):
            continue
        entry = expected.get(rel)
        if not entry:
            raise SystemExit(f'Unrecorded payload file: {rel}')
        seen.add(rel)
        if path.is_symlink():
            if entry.get('link') != os.readlink(path):
                raise SystemExit(f'Payload link changed: {rel}')
            continue
        digest = hashlib.sha256()
        with path.open('rb') as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != entry.get('sha256') or path.stat().st_size != entry.get('size'):
            raise SystemExit(f'Payload changed after identity generation: {rel}')
if seen != expected.keys():
    raise SystemExit('Payload file missing after identity generation')

def archive_mode(info):
    rel = pathlib.PurePosixPath(info.name).relative_to(root.name).as_posix()
    if info.isdir():
        info.mode = 0o755
    elif info.isfile():
        executable = (rel in {'ragent', 'install.sh', 'termux-ragent', 'app/bin/ragent-p2p-host', 'runtime/node', 'runtime/npm', 'runtime/corepack',
                              'runtime/codex', 'runtime/claude', 'runtime/ragent-codex-app-server',
                              'vendor/claude/claude'}
                      or rel.startswith('app/') and rel[4:] in executable_sources
                      or rel.startswith('app/node_modules/.bin/')
                      or rel.startswith('vendor/codex/node_modules/@openai/codex-linux-arm64/vendor/')
                         and ('/bin/' in rel or '/codex-path/' in rel or rel.endswith('/bwrap')))
        info.mode = 0o755 if executable else 0o644
    info.uid = info.gid = 0
    info.uname = info.gname = ''
    return info

if output.exists():
    raise SystemExit('Archive already exists; refusing to overwrite')
class GuardedWriter:
    def __init__(self, file):
        self.file = file

    def write(self, data):
        limit = int(os.environ.get('RAGENT_PROOT_MAX_ARCHIVE_BYTES', str(400 * 1024 * 1024)))
        reserve = int(os.environ.get('RAGENT_PROOT_MIN_FREE_BYTES', str(550 * 1024 * 1024)))
        if self.file.tell() + len(data) > limit or shutil.disk_usage(output.parent).free - len(data) < reserve:
            raise OSError('Archive size limit or disk reserve reached; partial file retained')
        return self.file.write(data)

    def flush(self):
        self.file.flush()

with output.open('xb') as file:
    with tarfile.open(fileobj=GuardedWriter(file), mode='w|gz', compresslevel=6, dereference=False) as archive:
        archive.add(root, arcname=root.name, recursive=True, filter=archive_mode)
