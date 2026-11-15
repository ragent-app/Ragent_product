import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { recordSelectionUsage } from '../lib/provider-runtime/run-provider-prepare.mjs';

const exec = promisify(execFile);

test('concurrent processes preserve selections for different harnesses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ragent-selection-usage-'));
  try {
    const moduleUrl = pathToFileURL(join(process.cwd(), 'lib/provider-runtime/run-provider-prepare.mjs')).href;
    const child = `
      import { recordSelectionUsage } from ${JSON.stringify(moduleUrl)};
      import { writeFile } from 'node:fs/promises';
      const [root, agent, provider] = process.argv.slice(1);
      await recordSelectionUsage(root, agent, provider, {
        writeFileImpl: async (...args) => {
          await new Promise(resolve => setTimeout(resolve, 80));
          return writeFile(...args);
        },
      });
    `;
    const values = [['codex', 'codex-account'], ['claude', 'claude-account'], ['agy', 'agy-account']];
    await Promise.all(values.map(([agent, provider]) => exec(process.execPath,
      ['--input-type=module', '-e', child, root, agent, provider], { timeout: 10_000 })));
    const path = join(root, 'native-provider-runtime', 'selection-usage.json');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    for (const [agent, provider] of values) assert.equal(saved.usage[agent]?.providerId, provider);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readers see the previous complete selection while an update is staged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ragent-selection-atomic-'));
  try {
    await recordSelectionUsage(root, 'codex', 'previous');
    const path = join(root, 'native-provider-runtime', 'selection-usage.json');
    let staged;
    const reached = new Promise(resolve => { staged = resolve; });
    let resume;
    const gate = new Promise(resolve => { resume = resolve; });
    const update = recordSelectionUsage(root, 'codex', 'next', {
      writeFileImpl: async (...args) => {
        await writeFile(...args);
        staged();
        await gate;
      },
    });
    await reached;
    assert.equal(JSON.parse(await readFile(path, 'utf8')).usage.codex.providerId, 'previous');
    resume();
    await update;
    assert.equal(JSON.parse(await readFile(path, 'utf8')).usage.codex.providerId, 'next');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
