import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createReleaseBuildinfo } from '../scripts/create-release-buildinfo.mjs';

const require = createRequire(import.meta.url);
const { releaseBuildInfo } = require('../desktop/update-check.cjs');
const dir = await mkdtemp(join(tmpdir(), 'ragent-buildinfo-'));
const version = '1.2.3', commit = 'a'.repeat(40), data = Buffer.from('candidate artifact\n');
try {
  for (const name of ['ragent_1.2.3_amd64.deb', 'ragent_1.2.3-darwin-arm64.dmg',
    'Ragent-1.2.3-ubuntu24.04-x86_64.deb', 'Ragent-1.2.3-macos13plus-arm64.dmg']) {
    const artifact = join(dir, name);
    await writeFile(artifact, data);
    const result = await createReleaseBuildinfo(artifact, version, commit);
    const expected = createHash('sha256').update(data).digest('hex');
    assert.equal(result.digest, expected);
    const body = await readFile(result.output, 'utf8');
    assert.deepEqual(releaseBuildInfo({ body }, { name, digest: `sha256:${expected}` }, { allowLegacy: false }),
      { build: [1, 2, 3, 0], commit });
    assert.equal(releaseBuildInfo({ body }, { name, digest: `sha256:${'b'.repeat(64)}` }, { allowLegacy: false }), null);
    await assert.rejects(createReleaseBuildinfo(artifact, version, commit), { code: 'EEXIST' });
    assert.equal(await readFile(result.output, 'utf8'), body);
    await assert.rejects(createReleaseBuildinfo(artifact, '1.2.4', commit));
    await assert.rejects(createReleaseBuildinfo(artifact, version, 'bad'));
  }
  console.log('Release build markers match finished artifacts and desktop update parsing');
} finally { await rm(dir, { recursive: true, force: true }); }
