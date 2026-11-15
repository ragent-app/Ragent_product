// DS-12 prototype: offline pack/unpack/verify for the segmented history index.
//
// Motivation: one-JSON-file-per-event sessions grow to ~665k small files
// (chat-history 4.7 GiB baseline). Segments replace the events/ index with a
// handful of append-friendly JSONL files while keeping every old guarantee:
// atomic write (tmp + rename), hash verification per segment, power-loss
// recovery (missing/corrupt trailer rejects the segment and the reader falls
// back to the untouched events/ dir — dual read), per-session rollback
// (delete segments/), and read-only source access (pack never writes the
// source). Design: docs/ragent-history-segmented-index-design.md.
//
// This is a PROTOTYPE: nothing here is wired into the default online read or
// write path. Segment format:
//
//   line 0        {"format":"ragent-history-segment-v1","startSeq":0,"eventCount":1024}
//   lines 1..N    {"seq":0,"event":{...compact event json...}}
//   last line     {"type":"segment-trailer","sha256":"<sha256 of all preceding bytes>",
//                  "eventCount":1024,"endSeq":1023}
//
// Events on disk are pretty-printed (writeJsonAtomic spaces=2) with embedded
// newlines, so they are re-serialized compact on pack (JSON.parse preserves
// key order — output is deterministic and golden-testable). Unpack writes
// compact event files that parse identically to the originals.

import { createHash } from 'crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { join } from 'path';

export const SEGMENT_FORMAT = 'ragent-history-segment-v1';
export const SEGMENT_EVENTS_DEFAULT = 1024;
export const EVENT_FILE_WIDTH = 9;
const SEGMENT_SUFFIX = '.jsonl';
// Files copied verbatim from the source session dir next to segments/.
const SIDE_FILES = ['meta.json', 'context.json', 'fork-context.json'];

function padSeq(seq) {
  return String(seq).padStart(EVENT_FILE_WIDTH, '0');
}

function segmentPathFor(segmentsDir, startSeq) {
  return join(segmentsDir, `${padSeq(startSeq)}${SEGMENT_SUFFIX}`);
}

function eventSeqFromName(name) {
  const seq = Number(name.replace(/\.json$/, ''));
  return Number.isInteger(seq) ? seq : null;
}

// Parse the first header line of a segment. Returns null when the line is not
// a valid header (or the format version is unknown — verify refuses to touch
// anything it does not understand).
function parseHeader(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || parsed.format !== SEGMENT_FORMAT) return null;
  if (!Number.isInteger(parsed.startSeq) || !Number.isInteger(parsed.eventCount)) return null;
  return parsed;
}

// Verify one segment file. Hash input = every line except the trailer,
// joined with '\n' plus a trailing '\n' (the exact bytes preceding the
// trailer line in the file).
export async function verifySegment(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return { ok: false, path, reason: `unreadable: ${error.message}` };
  }
  const lines = text.split('\n');
  // A file written by pack ends with '\n' after the trailer: the last split
  // element is ''.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length < 2) {
    return { ok: false, path, reason: 'too short (need header + trailer)' };
  }
  const header = parseHeader(lines[0]);
  if (!header) {
    return { ok: false, path, reason: 'missing or unsupported header' };
  }
  let trailer = null;
  try {
    trailer = JSON.parse(lines[lines.length - 1]);
  } catch {
    // fall through to the trailer check below
  }
  if (!trailer || trailer.type !== 'segment-trailer') {
    return { ok: false, path, reason: 'trailer missing or unparseable (incomplete segment)', startSeq: header.startSeq };
  }

  const eventLines = lines.slice(1, lines.length - 1);
  const countOk = eventLines.length === header.eventCount && eventLines.length === trailer.eventCount;
  if (!countOk) {
    return { ok: false, path, reason: `eventCount mismatch (header ${header.eventCount}, trailer ${trailer.eventCount}, actual ${eventLines.length})`, startSeq: header.startSeq };
  }
  // Events carry their own seq and may have GAPS (deleted events are a
  // supported state of the legacy layout — readers treat a missing file as
  // absent). Invariants: first line seq === startSeq, last line seq ===
  // endSeq, seqs strictly increasing within the segment.
  let firstSeq = null;
  let lastSeq = null;
  let prevSeq = null;
  for (let i = 0; i < eventLines.length; i += 1) {
    const line = eventLines[i];
    const seq = Number(line.match(/^\{"seq":(\d+),/)?.[1]);
    if (!Number.isInteger(seq)) {
      return { ok: false, path, reason: `event ${i} has no parseable seq (${String(line).slice(0, 40)}...)`, startSeq: header.startSeq };
    }
    if (prevSeq !== null && seq <= prevSeq) {
      return { ok: false, path, reason: `event ${i} seq not strictly increasing (${prevSeq} → ${seq})`, startSeq: header.startSeq };
    }
    if (firstSeq === null) firstSeq = seq;
    lastSeq = seq;
    prevSeq = seq;
  }
  if (firstSeq !== header.startSeq || lastSeq !== trailer.endSeq) {
    return { ok: false, path, reason: `seq range mismatch (header startSeq ${header.startSeq}, first ${firstSeq}; trailer endSeq ${trailer.endSeq}, last ${lastSeq})`, startSeq: header.startSeq };
  }
  const hash = createHash('sha256').update(`${lines.slice(0, lines.length - 1).join('\n')}\n`).digest('hex');
  const hashOk = hash === trailer.sha256;
  if (!hashOk) {
    return { ok: false, path, reason: 'sha256 mismatch (tampered or truncated)', startSeq: header.startSeq };
  }
  return { ok: true, path, format: SEGMENT_FORMAT, startSeq: header.startSeq, eventCount: header.eventCount, endSeq: lastSeq };
}

// Verify a segments/ directory: every *.jsonl segment passes and segments
// are contiguous (next.startSeq === prev.endSeq + 1). Sorted by startSeq —
// the 9-digit padded names sort lexicographically, but parse the header for
// robustness.
export async function verifySession(segmentsDir) {
  let names;
  try {
    names = await readdir(segmentsDir);
  } catch (error) {
    return { ok: false, segmentsDir, reason: `unreadable: ${error.message}`, segments: [] };
  }
  const segmentFiles = names.filter((name) => name.endsWith(SEGMENT_SUFFIX)).sort();
  const segments = [];
  let eventCount = 0;
  let firstBad = null;
  for (const name of segmentFiles) {
    const result = await verifySegment(join(segmentsDir, name));
    segments.push(result);
    if (!result.ok) {
      firstBad = firstBad || { file: name, reason: result.reason };
      continue;
    }
    eventCount += result.eventCount;
  }
  if (firstBad) {
    return { ok: false, segmentsDir, reason: `segment failed: ${firstBad.file} — ${firstBad.reason}`, segments, eventCount: null, firstBad };
  }
  // Cross-segment contiguity: pack chunks by event COUNT, so segment i's
  // startSeq is always the previous segment's endSeq + 1 — by construction.
  // A missing or deleted middle segment therefore always violates this check
  // (intra-segment gaps from deleted events are legal and carried per-line).
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].startSeq !== segments[i - 1].endSeq + 1) {
      const gap = { file: segmentFiles[i], startSeq: segments[i].startSeq, previousEndSeq: segments[i - 1].endSeq };
      return { ok: false, segmentsDir, reason: `segment gap before ${segmentFiles[i]} (startSeq ${segments[i].startSeq}, previous endSeq ${segments[i - 1].endSeq})`, segments, eventCount: null, firstBad: gap };
    }
  }
  return { ok: true, segmentsDir, segmentCount: segments.length, eventCount, segments };
}

// Re-serialize one event file to its compact segment-line form. Pack refuses
// unparseable event files — the source events dir is the truth and a corrupt
// index must never be silently normalized away.
function eventLine(seq, rawText) {
  let event;
  try {
    event = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`event file ${padSeq(seq)}.json is not valid JSON (${error.message})`);
  }
  return JSON.stringify({ seq, event });
}

// Pack a session's events/ index into segments. Read-only on the source:
// events/, bodies/, meta/ are never modified or deleted. Side files are
// copied verbatim next to segments/. The output is verified before returning.
export async function packSession(sessionDir, { outDir, eventsPerSegment = SEGMENT_EVENTS_DEFAULT, onProgress = null } = {}) {
  if (!Number.isInteger(eventsPerSegment) || eventsPerSegment < 1) {
    throw new Error(`eventsPerSegment must be a positive integer, got ${eventsPerSegment}`);
  }
  const eventsDir = join(sessionDir, 'events');
  let names;
  try {
    names = await readdir(eventsDir);
  } catch (error) {
    throw new Error(`session events dir not readable: ${eventsDir} (${error.message})`);
  }
  const eventNames = names
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, seq: eventSeqFromName(name) }))
    .filter((entry) => entry.seq !== null)
    .sort((a, b) => a.seq - b.seq);

  const segmentsDir = join(outDir, 'segments');
  await rm(segmentsDir, { recursive: true, force: true });
  await mkdir(segmentsDir, { recursive: true });

  const written = [];
  let eventCount = 0;
  for (let start = 0; start < eventNames.length; start += eventsPerSegment) {
    const chunk = eventNames.slice(start, start + eventsPerSegment);
    const startSeq = chunk[0].seq;
    const lines = [JSON.stringify({ format: SEGMENT_FORMAT, startSeq, eventCount: chunk.length })];
    for (const entry of chunk) {
      const raw = await readFile(join(eventsDir, entry.name), 'utf8');
      lines.push(eventLine(entry.seq, raw));
    }
    const endSeq = chunk[chunk.length - 1].seq;
    const body = `${lines.join('\n')}\n`;
    const sha256 = createHash('sha256').update(body).digest('hex');
    const trailer = JSON.stringify({ type: 'segment-trailer', sha256, eventCount: chunk.length, endSeq });
    const segmentText = `${body}${trailer}\n`;
    const outPath = segmentPathFor(segmentsDir, startSeq);
    const tmpPath = `${outPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, segmentText, 'utf8');
    await rename(tmpPath, outPath);
    written.push({ file: outPath, startSeq, eventCount: chunk.length, endSeq });
    eventCount += chunk.length;
    if (onProgress) onProgress(written.length);
  }

  // Copy session side files verbatim (meta/context/fork-context).
  const sideCopied = [];
  for (const name of SIDE_FILES) {
    const src = join(sessionDir, name);
    const dst = join(outDir, name);
    try {
      await writeFile(dst, await readFile(src));
      sideCopied.push(name);
    } catch {
      // absent side files are fine
    }
  }

  const verification = await verifySession(segmentsDir);
  if (!verification.ok) {
    throw new Error(`pack produced an unverifiable session: ${verification.reason}`);
  }
  return {
    sessionDir,
    outDir,
    eventCount,
    segmentCount: written.length,
    segments: written,
    sideCopied,
    verification: { segmentCount: verification.segmentCount, eventCount: verification.eventCount },
  };
}

// Unpack a verified segments/ dir back into the legacy per-event layout:
// <outDir>/events/<9-digit seq>.json. Compact-form event JSON (parse-equal
// to the original pretty-printed files). Refuses to unpack an unverified
// segments dir — a bad segment must never be allowed to become the source
// of truth. Meta side files are restored verbatim next to the events dir.
export async function unpackSession(segmentsDir, outDir) {
  const verification = await verifySession(segmentsDir);
  if (!verification.ok) {
    throw new Error(`refusing to unpack unverified segments: ${verification.reason}`);
  }
  const eventsDir = join(outDir, 'events');
  await rm(eventsDir, { recursive: true, force: true });
  await mkdir(eventsDir, { recursive: true });
  const written = [];
  for (const segment of verification.segments) {
    const lines = (await readFile(segment.path, 'utf8')).split('\n');
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const eventLines = lines.slice(1, lines.length - 1);
    for (const line of eventLines) {
      const parsed = JSON.parse(line);
      const path = join(eventsDir, `${padSeq(parsed.seq)}.json`);
      await writeFile(path, JSON.stringify(parsed.event), 'utf8');
      written.push({ seq: parsed.seq, path });
    }
  }
  for (const name of SIDE_FILES) {
    const src = join(segmentsDir, '..', name);
    const dst = join(outDir, name);
    try {
      await writeFile(dst, await readFile(src));
    } catch {
      // absent side files are fine
    }
  }
  return { segmentsDir, outDir, eventCount: written.length, written };
}
