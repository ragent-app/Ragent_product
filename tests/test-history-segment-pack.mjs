#!/usr/bin/env node
// DS-12: golden-file tests for the segmented history index prototype
// (chat/history-segment-pack.mjs, design docs/ragent-history-segmented-index-design.md).
//
// Pins the segment v1 byte format, then covers: parse-equal roundtrip
// (pretty-printed source in, compact events out), sha256/count/contiguity
// verification, power-loss (trailer dropped) and tamper detection, read-only
// source guarantee + per-session rollback, multi-segment boundaries, seq
// sorting, and refusal to pack an unparseable event file.
import assert from 'assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const {
  packSession,
  unpackSession,
  verifySegment,
  verifySession,
  SEGMENT_FORMAT,
} = await import('../chat/history-segment-pack.mjs');

function fixtureEvents() {
  return [
    { id: 'e1', type: 'message', role: 'user', content: 'hello' },
    { id: 'e2', type: 'status', content: 'running' },
    { id: 'e3', type: 'message', role: 'assistant', content: 'hi', bodyRef: 'evt_000000002_content' },
  ];
}

// Write an event file the way history.mjs does: pretty JSON (spaces=2), no
// trailing newline.
function writeEvent(eventsDir, seq, event) {
  writeFileSync(join(eventsDir, `${String(seq).padStart(9, '0')}.json`), JSON.stringify(event, null, 2));
}

function fabricateSession(root, sessionId, { events, meta } = {}) {
  const dir = join(root, sessionId);
  mkdirSync(join(dir, 'events'), { recursive: true });
  (events || []).forEach((event, seq) => writeEvent(join(dir, 'events'), seq, event));
  if (meta) writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  return dir;
}

const home = join(tmpdir(), `ragent-segment-pack-${process.pid}`);
await mkdir(home, { recursive: true });

// --- 1. golden bytes: the segment v1 format is pinned ---
{
  const session = fabricateSession(home, 'golden', {
    events: fixtureEvents(),
    meta: { sessionId: 'golden', title: 'fixture' },
  });
  const out = join(home, 'golden-packed');
  const result = await packSession(session, { outDir: out, eventsPerSegment: 2 });
  assert.equal(result.eventCount, 3);
  assert.equal(result.segmentCount, 2);
  assert.deepEqual(result.sideCopied, ['meta.json']);

  const segment0 = await readFile(join(out, 'segments', '000000000.jsonl'), 'utf8');
  const golden0 = [
    '{"format":"ragent-history-segment-v1","startSeq":0,"eventCount":2}',
    '{"seq":0,"event":{"id":"e1","type":"message","role":"user","content":"hello"}}',
    '{"seq":1,"event":{"id":"e2","type":"status","content":"running"}}',
    '{"type":"segment-trailer","sha256":"57a377d133c4253fcc4d4168bf12077d3dade095c525f602285b08f7702df592","eventCount":2,"endSeq":1}',
    '',
  ].join('\n');
  assert.equal(segment0, golden0, 'segment 0 bytes are pinned (header, compact events, trailer, trailing newline)');

  const segment1 = await readFile(join(out, 'segments', '000000002.jsonl'), 'utf8');
  const golden1 = [
    '{"format":"ragent-history-segment-v1","startSeq":2,"eventCount":1}',
    '{"seq":2,"event":{"id":"e3","type":"message","role":"assistant","content":"hi","bodyRef":"evt_000000002_content"}}',
    '{"type":"segment-trailer","sha256":"5077471f305cc5e2d47b68640a6691914852a6f5cb50a50912c66e01eedf3c92","eventCount":1,"endSeq":2}',
    '',
  ].join('\n');
  assert.equal(segment1, golden1, 'segment 1 bytes are pinned');

  // Side file copied verbatim.
  assert.equal(await readFile(join(out, 'meta.json'), 'utf8'), JSON.stringify({ sessionId: 'golden', title: 'fixture' }));
}

// --- 2. roundtrip: unpacked events parse-equal the originals ---
{
  const events = [
    { id: 'm1', type: 'message', role: 'user', content: '消息·测试🎯'.repeat(50), bodyRef: 'evt_000000000_content' },
    { id: 't1', type: 'tool_use', toolInput: { cmd: 'ls -la' } },
    { id: 'r1', type: 'reasoning', content: '思考', bodyRef: 'evt_000000002_content' },
  ];
  const session = fabricateSession(home, 'roundtrip', { events });
  const out = join(home, 'roundtrip-packed');
  await packSession(session, { outDir: out });

  const unpacked = join(home, 'roundtrip-unpacked');
  const result = await unpackSession(join(out, 'segments'), unpacked);
  assert.equal(result.eventCount, 3);

  const names = (await readdir(join(unpacked, 'events'))).sort();
  assert.deepEqual(names, ['000000000.json', '000000001.json', '000000002.json']);
  for (let seq = 0; seq < events.length; seq += 1) {
    const original = JSON.parse(await readFile(join(session, 'events', `${String(seq).padStart(9, '0')}.json`), 'utf8'));
    const restored = JSON.parse(await readFile(join(unpacked, 'events', `${String(seq).padStart(9, '0')}.json`), 'utf8'));
    assert.deepEqual(restored, original, `event ${seq} must parse-equal the original`);
  }
}

// --- 3. verify: tamper, truncation, unknown format, unreadable ---
{
  const session = fabricateSession(home, 'verify', { events: fixtureEvents() });
  const out = join(home, 'verify-packed');
  await packSession(session, { outDir: out, eventsPerSegment: 2 });
  const segmentPath = join(out, 'segments', '000000000.jsonl');

  const intact = await verifySegment(segmentPath);
  assert.equal(intact.ok, true);
  assert.equal(intact.format, SEGMENT_FORMAT);
  assert.equal(intact.eventCount, 2);
  assert.equal(intact.endSeq, 1);

  // Tamper: change an event's content without fixing the trailer hash.
  const tampered = (await readFile(segmentPath, 'utf8')).replace('"content":"hello"', '"content":"HACKED"');
  await writeFile(segmentPath, tampered);
  const tamperedCheck = await verifySegment(segmentPath);
  assert.equal(tamperedCheck.ok, false);
  assert.ok(tamperedCheck.reason.includes('sha256 mismatch'), tamperedCheck.reason);
  // Restore for the next sub-case.
  await packSession(session, { outDir: out, eventsPerSegment: 2 });

  // Power loss: drop the trailer line (the write never completed).
  const noTrailer = (await readFile(segmentPath, 'utf8')).split('\n').slice(0, 3).join('\n') + '\n';
  await writeFile(segmentPath, noTrailer);
  const truncatedCheck = await verifySegment(segmentPath);
  assert.equal(truncatedCheck.ok, false);
  assert.ok(truncatedCheck.reason.includes('trailer missing'), truncatedCheck.reason);
  await packSession(session, { outDir: out, eventsPerSegment: 2 });

  // Unknown format version must be refused.
  const unknown = join(out, 'segments', '000009999.jsonl');
  await writeFile(unknown, '{"format":"ragent-history-segment-v2","startSeq":9999,"eventCount":0}\n{"type":"segment-trailer","sha256":"00","eventCount":0,"endSeq":9998}\n');
  const unknownCheck = await verifySegment(unknown);
  assert.equal(unknownCheck.ok, false);
  assert.ok(unknownCheck.reason.includes('unsupported header'), unknownCheck.reason);

  const missingCheck = await verifySegment(join(out, 'segments', '000000001.jsonl.missing'));
  assert.equal(missingCheck.ok, false);
  assert.ok(missingCheck.reason.includes('unreadable'), missingCheck.reason);
}

// --- 4. power loss leaves the session verifiable and un-unpackable ---
{
  const session = fabricateSession(home, 'powerloss', { events: fixtureEvents() });
  const out = join(home, 'powerloss-packed');
  await packSession(session, { outDir: out, eventsPerSegment: 2 });
  // Simulate a crash mid-write: truncate segment 0 to 2 lines (header only).
  const segmentsDir = join(out, 'segments');
  await writeFile(join(segmentsDir, '000000000.jsonl'), '{"format":"ragent-history-segment-v1","startSeq":0,"eventCount":2}\n');

  const sessionCheck = await verifySession(segmentsDir);
  assert.equal(sessionCheck.ok, false);
  assert.equal(sessionCheck.firstBad.file, '000000000.jsonl');

  await assert.rejects(
    unpackSession(segmentsDir, join(home, 'powerloss-unpacked')),
    /refusing to unpack unverified segments/,
    'an unverified session must never unpack',
  );
}

// --- 5. read-only source + per-session rollback ---
{
  const eventsA = fixtureEvents();
  const eventsB = [{ id: 'b1', type: 'status', content: 'B' }];
  const sessionA = fabricateSession(home, 'rollbackA', { events: eventsA });
  const sessionB = fabricateSession(home, 'rollbackB', { events: eventsB });
  const outA = join(home, 'rollbackA-packed');
  const outB = join(home, 'rollbackB-packed');
  await packSession(sessionA, { outDir: outA });
  await packSession(sessionB, { outDir: outB });

  // Pack is read-only on the source: event files byte-identical, count same.
  const srcNames = (await readdir(join(sessionA, 'events'))).sort();
  assert.deepEqual(srcNames, ['000000000.json', '000000001.json', '000000002.json']);
  const sourceBytes = await readFile(join(sessionA, 'events', '000000000.json'), 'utf8');
  assert.equal(sourceBytes, JSON.stringify(eventsA[0], null, 2));

  // Rollback session A = delete its segments; B is unaffected.
  await rmSync(join(outA, 'segments'), { recursive: true, force: true });
  const rolledBack = await verifySession(join(outA, 'segments'));
  assert.equal(rolledBack.ok, false, 'deleted segments mean the session is on the legacy layout again');
  const bCheck = await verifySession(join(outB, 'segments'));
  assert.equal(bCheck.ok, true, 'session B must be unaffected by A rollback');
  assert.equal(bCheck.eventCount, 1);
}

// --- 6. multi-segment boundaries + gap detection ---
{
  const events = Array.from({ length: 2500 }, (_, i) => ({ id: `e${i}`, type: 'status', content: `line ${i}` }));
  const session = fabricateSession(home, 'multiseg', { events });
  const out = join(home, 'multiseg-packed');
  const result = await packSession(session, { outDir: out, eventsPerSegment: 1024 });
  assert.equal(result.segmentCount, 3, '2500 events → 3 segments');

  const check = await verifySession(join(out, 'segments'));
  assert.equal(check.ok, true);
  assert.equal(check.segmentCount, 3);
  assert.equal(check.eventCount, 2500);
  const starts = check.segments.map((s) => s.startSeq);
  assert.deepEqual(starts, [0, 1024, 2048], 'segments start at 1024 boundaries');

  // Deleting the middle segment breaks contiguity.
  await rmSync(join(out, 'segments', '000001024.jsonl'));
  const gapped = await verifySession(join(out, 'segments'));
  assert.equal(gapped.ok, false);
  assert.ok(gapped.reason.includes('segment gap'), gapped.reason);
}

// --- 7. out-of-order event files are packed in seq order ---
{
  const dir = join(home, 'unordered');
  mkdirSync(join(dir, 'events'), { recursive: true });
  writeEvent(join(dir, 'events'), 5, { id: 'late', type: 'status', content: 'five' });
  writeEvent(join(dir, 'events'), 3, { id: 'early', type: 'status', content: 'three' });
  const out = join(home, 'unordered-packed');
  await packSession(dir, { outDir: out });
  const unpacked = join(home, 'unordered-unpacked');
  await unpackSession(join(out, 'segments'), unpacked);
  const names = (await readdir(join(unpacked, 'events'))).sort();
  assert.deepEqual(names, ['000000003.json', '000000005.json']);
  assert.equal(JSON.parse(await readFile(join(unpacked, 'events', '000000005.json'), 'utf8')).content, 'five');
}

// --- 8. unparseable event file → pack refuses ---
{
  const dir = join(home, 'bad-event');
  mkdirSync(join(dir, 'events'), { recursive: true });
  writeFileSync(join(dir, 'events', '000000000.json'), '{ not json at all');
  await assert.rejects(packSession(dir, { outDir: join(home, 'bad-packed') }), /not valid JSON/, 'pack must refuse a corrupt event file');
}

console.log('history segment pack: all sections passed');
await rmSync(home, { recursive: true, force: true });
