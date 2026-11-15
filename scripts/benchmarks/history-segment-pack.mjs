#!/usr/bin/env node
// DS-12 benchmark: offline pack/unpack/verify of the segmented history index.
//
// Fabricates cold sessions on disk (direct file writes, no cache warm-up —
// same convention as history-read.mjs), then measures: event file count vs
// segment file count, packed bytes, pack / verify / unpack wall time.
//
// Run each size in a FRESH process: same-process multi-size runs pick up
// filesystem page-cache effects from the previous fabrication, which showed
// up as phantom speedups in the DS-11 benchmark.
//
//   node scripts/benchmarks/history-segment-pack.mjs [--sizes 50,200,2000,20000]
//                                                 [--out artifacts/benchmarks/history-segment-pack]
//
// JSON report per size: artifacts/benchmarks/history-segment-pack/run-<size>/report.json

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { packSession, unpackSession, verifySession } from '../../chat/history-segment-pack.mjs';

const SIZES = [50, 200, 2000, 20000];
const EVENT_TYPES = ['message', 'reasoning', 'tool_use', 'tool_result', 'status'];

function parseArgs(argv) {
  const out = { sizes: SIZES, outRoot: join('artifacts', 'benchmarks', 'history-segment-pack') };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--sizes') out.sizes = argv[i + 1].split(',').map(Number);
    else if (argv[i] === '--out') out.outRoot = argv[i + 1];
  }
  return out;
}

function fabricateSession(root, size) {
  // Direct writes keep caches cold and mirror the real on-disk layout:
  // events/<9-digit>.json (pretty JSON, like writeJsonAtomic) + bodies/ for
  // externalized content.
  const eventsDir = join(root, 'events');
  const bodiesDir = join(root, 'bodies');
  mkdirSync(eventsDir, { recursive: true });
  mkdirSync(bodiesDir, { recursive: true });
  writeFileSync(join(root, 'meta.json'), JSON.stringify({ sessionId: `bench-${size}`, title: 'benchmark' }));
  let bodies = 0;
  for (let seq = 0; seq < size; seq += 1) {
    const type = EVENT_TYPES[seq % EVENT_TYPES.length];
    let event;
    if (type === 'message') {
      event = seq % 10 === 0
        ? { id: `e${seq}`, type, role: seq % 2 ? 'assistant' : 'user', content: '', bodyRef: `evt_${String(seq).padStart(9, '0')}_content` }
        : { id: `e${seq}`, type, role: seq % 2 ? 'assistant' : 'user', content: `message text ${seq}`.repeat(3) };
    } else if (type === 'reasoning') {
      event = { id: `e${seq}`, type, content: '', bodyRef: `evt_${String(seq).padStart(9, '0')}_content` };
    } else if (type === 'tool_use') {
      event = { id: `e${seq}`, type, toolInput: { cmd: `cmd ${seq}` } };
    } else if (type === 'tool_result') {
      event = seq % 4 === 0
        ? { id: `e${seq}`, type, output: '', bodyRef: `evt_${String(seq).padStart(9, '0')}_output` }
        : { id: `e${seq}`, type, output: `result ${seq}`.repeat(2) };
    } else {
      event = { id: `e${seq}`, type, content: `status ${seq}` };
    }
    if (event.bodyRef) {
      bodies += 1;
      writeFileSync(join(bodiesDir, `${event.bodyRef}.txt`), `externalized body ${seq} — 消息·🎯`.repeat(40));
    }
    writeFileSync(join(eventsDir, `${String(seq).padStart(9, '0')}.json`), JSON.stringify(event, null, 2));
  }
  return { eventsDir, bodiesDir, bodies };
}

async function main() {
  const { sizes, outRoot } = parseArgs(process.argv);
  for (const size of sizes) {
    const work = join('/tmp', `ragent-pack-bench-${process.pid}-${size}`);
    rmSync(work, { recursive: true, force: true });
    const sessionDir = join(work, 'session');
    mkdirSync(sessionDir, { recursive: true });
    const { bodies } = fabricateSession(join(sessionDir), size);

    const filesBefore = await (await import('fs/promises')).readdir(join(sessionDir, 'events')).then((n) => n.length);
    const packedOut = join(work, 'packed');
    const unpackedOut = join(work, 'unpacked');

    const t0 = performance.now();
    const packed = await packSession(sessionDir, { outDir: packedOut });
    const packMs = Math.round(performance.now() - t0);

    const t1 = performance.now();
    const verified = await verifySession(join(packedOut, 'segments'));
    const verifyMs = Math.round(performance.now() - t1);

    const t2 = performance.now();
    const unpacked = await unpackSession(join(packedOut, 'segments'), unpackedOut);
    const unpackMs = Math.round(performance.now() - t2);

    const { stat } = await import('fs/promises');
    const eventsBytes = (await Promise.all(
      (await (await import('fs/promises')).readdir(join(sessionDir, 'events'))).map((n) => stat(join(sessionDir, 'events', n)).then((s) => s.size)),
    )).reduce((a, b) => a + b, 0);
    const segmentBytes = (await Promise.all(
      (await (await import('fs/promises')).readdir(join(packedOut, 'segments'))).map((n) => stat(join(packedOut, 'segments', n)).then((s) => s.size)),
    )).reduce((a, b) => a + b, 0);
    const filesAfter = (await (await import('fs/promises')).readdir(join(packedOut, 'segments'))).length + bodies;

    const report = {
      size,
      events: size,
      externalizedBodies: bodies,
      filesBefore, // events/*.json
      filesAfter, // segments/*.jsonl + bodies/*.txt
      eventsBytes,
      segmentBytes,
      packMs,
      verifyMs,
      unpackMs,
      segments: packed.segmentCount,
      verified: verified.ok,
      unpackedEvents: unpacked.eventCount,
      invariant: {
        segmentsCoverAllEvents: packed.eventCount === size,
        roundtripEventCount: unpacked.eventCount === size,
      },
    };
    const outDir = join(outRoot, `run-${size}`);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`size=${size} files ${filesBefore}→${filesAfter} (${bodies} bodies stay) segments=${packed.segmentCount} pack=${packMs}ms verify=${verifyMs}ms unpack=${unpackMs}ms bytes ${eventsBytes}→${segmentBytes}`);
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
