// Sentinel command parser for the AgentoC privileged-approval gate (design
// §13–§14, Path G). Pure logic, no I/O.
//
// The agent declares a privileged op by running a Bash command of the form:
//
//   agentoc-privileged --description "<text>" --category install|other|delete -- <real command>
//
// At the provider permission gate (Claude bidi `can_use_tool` /
// Codex app-server `item/.../requestApproval`) — which only fires in gated,
// non-bypass mode — AgentoC recognizes this sentinel, extracts the real command
// VERBATIM (so the allow-response can rewrite `updatedInput.command` to it and
// the wrapper never reaches a shell) plus the declared description/category,
// then defers the gate response to run the P1b batch approval flow.
//
// Not yet wired into any live gate; no live code references this module today.

export const PRIVILEGED_SENTINEL_PROGRAM = 'ragent-privileged';

// Flags understood in the options segment. Also used as the set of tokens that
// are NEVER consumed as a flag's value (so `--category --description "x"` parses
// the second token as a flag boundary, not as the category value).
const SENTINEL_FLAGS = new Set(['--description', '--desc', '--category', '--']);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Basename of the first token, allowing an optional directory prefix
// (`/usr/local/bin/agentoc-privileged`). The agent is system-prompt-instructed
// to emit the bare token; the prefix tolerance just avoids fragility.
function isSentinelProgram(token) {
  const value = trimString(token);
  if (!value) return false;
  const base = value.slice(value.lastIndexOf('/') + 1);
  return base === PRIVILEGED_SENTINEL_PROGRAM || base === 'agentoc-privileged';
}

// Quote-aware tokenizer that records character spans in the source string. NOT
// a shell parser — it splits on whitespace while respecting simple quotes,
// mirroring privileged-classifier.mjs's tokenizer shape. Positions are relative
// to the trimmed input.
function tokenizeWithPositions(command) {
  const raw = trimString(command);
  if (!raw) return [];
  const re = /(?:[^\s"'`]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')+/g;
  const out = [];
  let match;
  while ((match = re.exec(raw)) !== null) {
    const text = match[0];
    out.push({
      raw: text,
      value: text.replace(/^["']|["']$/g, ''),
      start: match.index,
      end: match.index + text.length,
    });
  }
  return out;
}

// Consume the token after a flag as its value, unless that token is itself a
// flag (then there is no value and we do not advance).
function consumeFlagValue(tokens, index) {
  const next = tokens[index + 1];
  if (next && !SENTINEL_FLAGS.has(next.value)) {
    return { value: next.value, advance: 1 };
  }
  return { value: '', advance: 0 };
}

/**
 * Parse a command string for the privileged-op sentinel convention.
 *
 * @param {string} input - The raw command (e.g. a Bash `input.command`).
 * @returns {null|object} `null` if `input` is not a sentinel invocation at all
 *   (first token is not `agentoc-privileged`); otherwise an object describing
 *   the parsed sentinel, with `valid` indicating whether it has a real command
 *   to gate on.
 */
export function parsePrivilegedSentinel(input) {
  const command = trimString(input);
  const tokens = tokenizeWithPositions(command);
  if (tokens.length === 0 || !isSentinelProgram(tokens[0].value)) {
    return null;
  }

  let description = '';
  let declaredCategory = '';
  let separator = null;

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.value === '--') {
      separator = token;
      break;
    }
    if (token.value === '--description' || token.value === '--desc') {
      const consumed = consumeFlagValue(tokens, i);
      description = consumed.value;
      i += consumed.advance;
      continue;
    }
    if (token.value === '--category') {
      const consumed = consumeFlagValue(tokens, i);
      declaredCategory = consumed.value;
      i += consumed.advance;
      continue;
    }
    // Unknown tokens before the separator are ignored.
  }

  const realCommand = separator ? trimString(command.slice(separator.end)) : '';
  const valid = Boolean(separator) && realCommand.length > 0;
  const malformedReason = !separator
    ? 'missing `--` separator before the real command'
    : (realCommand.length === 0 ? 'empty real command after `--`' : '');

  return {
    isSentinel: true,
    valid,
    program: PRIVILEGED_SENTINEL_PROGRAM,
    description,
    declaredCategory,
    realCommand,
    raw: command,
    ...(malformedReason ? { malformedReason } : {}),
  };
}
