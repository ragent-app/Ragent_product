#!/usr/bin/env python3
"""Identify the complete staged release without hashing its own identity."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys

root = Path(sys.argv[1]).resolve()
version = (root / 'VERSION').read_text(encoding='ascii').strip()
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.+_-]*', version):
    raise SystemExit('Invalid public VERSION')
excluded = {'RELEASE_ID', 'release-content-manifest.json'}
files = []
for directory, dirs, names in os.walk(root, followlinks=False):
    dirs.sort()
    names.sort()
    for name in list(dirs):
        if (Path(directory) / name).is_symlink():
            dirs.remove(name)
            names.append(name)
    for name in sorted(names):
        path = Path(directory) / name
        relative = path.relative_to(root).as_posix()
        if relative in excluded:
            continue
        if path.is_symlink():
            target = os.readlink(path)
            if not (path.parent / target).resolve().is_relative_to(root):
                raise SystemExit(f'Escaping payload symlink: {relative}')
            files.append({'path': relative, 'link': target})
            continue
        digest = hashlib.sha256()
        with path.open('rb') as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b''):
                digest.update(chunk)
        files.append({'path': relative, 'size': path.stat().st_size, 'sha256': digest.hexdigest()})
files.sort(key=lambda item: item['path'])
content = (json.dumps({'schemaVersion': 1, 'publicVersion': version, 'files': files},
                      ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
(root / 'release-content-manifest.json').write_bytes(content)
identity = hashlib.sha256(content).hexdigest()
(root / 'RELEASE_ID').write_bytes(f'{version}-{identity[:16]}\n'.encode('ascii'))
print(identity)
