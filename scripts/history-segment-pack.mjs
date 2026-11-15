#!/usr/bin/env node
// DS-12 prototype CLI: offline pack / unpack / verify for the segmented
// history index (docs/ragent-history-segmented-index-design.md).
//
//   node scripts/history-segment-pack.mjs pack <sessionDir> --out DIR [--events-per-segment N]
//   node scripts/history-segment-pack.mjs unpack <segmentsDir> --out DIR
//   node scripts/history-segment-pack.mjs verify <segmentsDir>
//
// pack  is read-only on the source session (events/ never modified); unpack
// writes the legacy per-event layout into --out; verify checks every segment
// (sha256 + counts + contiguity). Exit code 1 on any verification failure.

import { join } from 'path';
import { packSession, unpackSession, verifySession } from '../chat/history-segment-pack.mjs';

function fail(message) {
  console.error(`[history-segment-pack] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const [cmd, target, ...rest] = argv.slice(2);
  const options = { cmd, target, out: null, eventsPerSegment: null };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--out') options.out = rest[i + 1];
    else if (rest[i] === '--events-per-segment') options.eventsPerSegment = Number(rest[i + 1]);
    else if (rest[i] === '--help') {
      console.log(`Usage:
  node scripts/history-segment-pack.mjs pack <sessionDir> --out DIR [--events-per-segment N]
  node scripts/history-segment-pack.mjs unpack <segmentsDir> --out DIR
  node scripts/history-segment-pack.mjs verify <segmentsDir>`);
      process.exit(0);
    }
  }
  return options;
}

async function main() {
  const { cmd, target, out, eventsPerSegment } = parseArgs(process.argv);
  if (!cmd || !target) fail('usage: pack|unpack|verify <path> [--out DIR]');

  if (cmd === 'pack') {
    if (!out) fail('pack requires --out DIR');
    const result = await packSession(target, {
      outDir: out,
      ...(eventsPerSegment ? { eventsPerSegment } : {}),
      onProgress: (done) => process.stdout.write(`  packed ${done} segment(s)\r`),
    });
    console.log(`[history-segment-pack] packed ${result.eventCount} events into ${result.segmentCount} segment(s) at ${join(out, 'segments')}`);
    console.log(`  verified: ${result.verification.segmentCount} segment(s), ${result.verification.eventCount} events`);
    console.log(`  side files copied: ${result.sideCopied.join(', ') || '(none present)'}`);
  } else if (cmd === 'unpack') {
    if (!out) fail('unpack requires --out DIR');
    const result = await unpackSession(target, out);
    console.log(`[history-segment-pack] unpacked ${result.eventCount} events into ${join(out, 'events')}`);
  } else if (cmd === 'verify') {
    const result = await verifySession(target);
    if (!result.ok) fail(`verify failed: ${result.reason}`);
    console.log(`[history-segment-pack] verify ok: ${result.segmentCount} segment(s), ${result.eventCount} events at ${target}`);
  } else {
    fail(`unknown command ${cmd}`);
  }
}

main().catch((error) => {
  console.error(`[history-segment-pack] ${error.message}`);
  process.exit(1);
});
