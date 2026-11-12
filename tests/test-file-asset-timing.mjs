import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttachmentTiming } from '../chat/file-asset-timing.mjs';

const asset = `fasset_${'a'.repeat(24)}`;

test('attachment timings are opt-in and cannot alter upload results', async () => {
  const disabled = createAttachmentTiming({ enabled: false, clock: () => { throw new Error('clock used'); },
    sink: () => { throw new Error('sink used'); } });
  assert.equal(await disabled.measure(asset, 'relay_receive', () => 42), 42);
  await assert.rejects(disabled.measure(asset, 'relay_receive', () => { throw new Error('upload failed'); }), /upload failed/);
  const enabled = createAttachmentTiming({ enabled: true, clock: () => 10, key: Buffer.alloc(32), sink: () => { throw Error('sink failed'); } });
  assert.equal(await enabled.measure(asset, 'relay_receive', () => 42), 42);
  const brokenClock = createAttachmentTiming({ enabled: true, clock: () => { throw Error('clock failed'); }, sink: () => {} });
  assert.equal(await brokenClock.measure(asset, 'relay_receive', () => 42), 42);
});

test('timings contain only bounded anonymous metadata and distinguish failure', async () => {
  let now = 100;
  const lines = [];
  const timing = createAttachmentTiming({ enabled: true, clock: () => now, key: Buffer.alloc(32, 7), sink: line => lines.push(line) });
  await timing.measure(asset, 'relay_receive', () => { now += 12.345; }, { bytes: 4096 });
  await assert.rejects(timing.measure(asset, 'quota_complete', () => { now += 4; throw new Error('secret'); }), /secret/);
  timing.end(asset, 'untrusted-stage', 0, { bytes: -1 });
  assert.equal(lines.length, 2);
  const records = lines.map(line => JSON.parse(line.replace('[attachment-timing] ', '')));
  assert.deepEqual(Object.keys(records[0]).sort(), ['bytes', 'correlation', 'elapsedMs', 'outcome', 'stage']);
  assert.equal(records[0].elapsedMs, 12.35);
  assert.equal(records[0].bytes, 4096);
  assert.equal(records[1].outcome, 'error');
  assert.equal(records[0].correlation, records[1].correlation);
  assert.match(records[0].correlation, /^[a-f0-9]{16}$/);
  assert.ok(lines.every(line => !line.includes(asset) && !line.includes('secret')));
});
