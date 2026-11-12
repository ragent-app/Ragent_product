import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderDebPayloadManifest } from '../scripts/render-deb-payload-manifest.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-deb-manifest-'));
try {
  await mkdir(join(root, 'DEBIAN'));
  await mkdir(join(root, 'opt', 'ragent'), { recursive: true });
  await writeFile(join(root, 'DEBIAN', 'control'), 'not payload');
  await writeFile(join(root, 'opt', 'ragent', 'data file'), 'payload');
  if (process.platform !== 'win32') {
    await symlink('data file', join(root, 'opt', 'ragent', 'link'));
    assert.equal(renderDebPayloadManifest(root), '/opt/ragent/data file\n/opt/ragent/link\n');
    await writeFile(join(root, 'opt', 'ragent', 'bad\nname'), 'invalid');
    assert.throws(() => renderDebPayloadManifest(root), /line breaks/);
  } else {
    assert.equal(renderDebPayloadManifest(root), '/opt/ragent/data file\n');
  }
  console.log('PASS Debian payload manifest lists files and links, never directories or control files');
} finally { await rm(root, { recursive: true, force: true }); }
