import { createHash } from 'node:crypto';
import { stripAssistantControlBlocks } from './assistant-control-blocks.mjs';

const START = '<agentoc-result-packet>';
const END = '</agentoc-result-packet>';
const STATES = new Set(['completed', 'failed', 'blocked', 'waiting']);
const MAX_BLOCK_BYTES = 32768;
const FIELDS = ['changedFiles', 'tests', 'risks', 'blockers', 'acceptanceNotes', 'unresolvedItems'];

// This is a presentation of a model assertion, never an acceptance decision.
export function projectFactoryReport(packet) {
  const raw = typeof packet?.summary === 'string' ? packet.summary : '';
  const source = packet?.provenance?.assistantReport;
  if (source?.source !== 'persisted_assistant_final' || !Number.isSafeInteger(source.eventSeq)
      || source.eventSeq < 1 || !source.providerMessageId || !/^[a-f0-9]{64}$/.test(source.contentHash || '')
      || createHash('sha256').update(raw).digest('hex') !== source.contentHash) {
    return { schemaVersion: 1, source: 'unverified', declaration: { status: 'unavailable' }, readable: false };
  }
  let visibleText = stripAssistantControlBlocks(raw, { preservePotentialStart: true }).trim();
  const starts = [...raw.matchAll(/<agentoc-result-packet>/gi)];
  const ends = [...raw.matchAll(/<\/agentoc-result-packet>/gi)];
  const markers = [...raw.matchAll(/<\/?agentoc-result-packet\b/gi)];
  if (markers.length !== starts.length + ends.length) {
    // A partial or malformed marker and its suffix are protocol fragments,
    // not report text. Preserve only any text preceding the fragment.
    const malformed = /<\/?agentoc-result-packet\b(?!>)/i.exec(raw);
    if (malformed) visibleText = stripAssistantControlBlocks(raw.slice(0,malformed.index), {preservePotentialStart:true}).trim();
  }
  let declaration = { status: 'absent' };
  if (starts.length > 1 || ends.length > 1) declaration = { status: 'ambiguous' };
  else if (markers.length !== starts.length + ends.length || starts.length !== ends.length
      || (starts.length === 1 && ends[0].index < starts[0].index)) declaration = { status: 'invalid' };
  else if (starts.length === 1) {
    const content = raw.slice(starts[0].index + START.length, ends[0].index).trim();
    try {
      if (Buffer.byteLength(content, 'utf8') > MAX_BLOCK_BYTES) throw new Error('oversize');
      const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(content);
      const value = JSON.parse(fenced ? fenced[1] : content);
      if (!value || typeof value !== 'object' || Array.isArray(value) || !STATES.has(value.state)
          || (value.summary !== undefined && (typeof value.summary !== 'string' || value.summary.length > 4000))
          || FIELDS.some(k => value[k] !== undefined && (!Array.isArray(value[k]) || value[k].length > 100
            || value[k].some(v => typeof v === 'string' ? v.length > 1200
              : !v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length > 20
                || Object.values(v).some(x => !['string','number','boolean'].includes(typeof x)
                  || (typeof x === 'string' && x.length > 1200)))))) throw new Error('invalid');
      declaration = { status: 'valid', state: value.state, summary: value.summary || '' };
      for (const field of FIELDS) if (value[field] !== undefined) declaration[field] = value[field];
    } catch { declaration = { status: 'invalid' }; }
  }
  return { schemaVersion: 1, source: 'persisted_assistant_final', visibleText, declaration,
    readable: Boolean(visibleText || (declaration.status === 'valid' && declaration.summary.trim())) };
}
