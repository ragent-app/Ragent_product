// Machine-readable assistant envelopes are consumed by Runtime code but are
// never part of the user-facing transcript. Keep the marker grammar in one
// place so history projections and live push filtering agree.

const CONTROL_BLOCKS = Object.freeze([
  Object.freeze({ kind: 'organization-proposal', start: '<ragent-organization-proposal>', end: '</ragent-organization-proposal>' }),
  Object.freeze({ kind: 'collaboration-plan', start: '<ragent-collaboration-plan>', end: '</ragent-collaboration-plan>' }),
  Object.freeze({ kind: 'result-packet', start: '<ragent-result-packet>', end: '</ragent-result-packet>' }),
  Object.freeze({ kind: 'session-labels', start: '<ragent-session-labels>', end: '</ragent-session-labels>' }),
]);

const CONTROL_END_MARKER_RE = /<\/ragent-(?:organization-proposal|collaboration-plan|result-packet|session-labels)>/gi;

function findNextControlStart(sourceLower, fromIndex = 0) {
  let match = null;
  for (const block of CONTROL_BLOCKS) {
    const index = sourceLower.indexOf(block.start.toLowerCase(), fromIndex);
    if (index < 0 || (match && index >= match.index)) continue;
    match = { index, block };
  }
  return match;
}

function longestSuffixThatStartsMarker(value, markers) {
  const source = String(value || '');
  const lower = source.toLowerCase();
  let best = '';
  for (const marker of markers) {
    const normalized = marker.toLowerCase();
    const max = Math.min(normalized.length - 1, lower.length);
    for (let length = max; length > best.length; length -= 1) {
      if (lower.endsWith(normalized.slice(0, length))) {
        best = source.slice(-length);
        break;
      }
    }
  }
  return best;
}

export function stripAssistantControlBlocks(value, { preservePotentialStart = false } = {}) {
  const source = typeof value === 'string' ? value : '';
  if (!source) return '';

  const lower = source.toLowerCase();
  let cursor = 0;
  let visible = '';
  while (cursor < source.length) {
    const next = findNextControlStart(lower, cursor);
    if (!next) {
      visible += source.slice(cursor);
      break;
    }
    visible += source.slice(cursor, next.index);
    const payloadStart = next.index + next.block.start.length;
    const end = lower.indexOf(next.block.end.toLowerCase(), payloadStart);
    // Fail closed for malformed protocol output: once a control marker starts,
    // the remainder is internal even if the model forgot the closing marker.
    if (end < 0) break;
    cursor = end + next.block.end.length;
  }

  visible = visible.replace(CONTROL_END_MARKER_RE, '');
  if (preservePotentialStart) {
    const suffix = longestSuffixThatStartsMarker(
      visible,
      CONTROL_BLOCKS.map((block) => block.start),
    );
    if (suffix) visible = visible.slice(0, -suffix.length);
  }
  return visible;
}

export function createAssistantControlBlockStream() {
  let pending = '';
  let activeBlock = null;

  function push(value) {
    const chunk = typeof value === 'string' ? value : '';
    if (!chunk) return '';
    let input = pending + chunk;
    pending = '';
    let output = '';

    while (input) {
      if (activeBlock) {
        const lower = input.toLowerCase();
        const end = lower.indexOf(activeBlock.end.toLowerCase());
        if (end < 0) {
          pending = longestSuffixThatStartsMarker(input, [activeBlock.end]);
          return output;
        }
        input = input.slice(end + activeBlock.end.length);
        activeBlock = null;
        continue;
      }

      const next = findNextControlStart(input.toLowerCase(), 0);
      if (next) {
        output += input.slice(0, next.index);
        input = input.slice(next.index + next.block.start.length);
        activeBlock = next.block;
        continue;
      }

      pending = longestSuffixThatStartsMarker(
        input,
        CONTROL_BLOCKS.map((block) => block.start),
      );
      output += input.slice(0, input.length - pending.length);
      return stripAssistantControlBlocks(output);
    }

    return stripAssistantControlBlocks(output);
  }

  return {
    push,
    finish() {
      // Pending text may be a partial control marker; fail closed at stream end.
      const output = activeBlock ? '' : pending;
      pending = '';
      activeBlock = null;
      return stripAssistantControlBlocks(output, { preservePotentialStart: true });
    },
    reset() {
      pending = '';
      activeBlock = null;
    },
  };
}

export { CONTROL_BLOCKS };
