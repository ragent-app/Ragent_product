// Served-model → context window tokens.
//
// Claude Code's stream-json frames never report the model's context window,
// so Ragent's window-relative features (UI context percent, auto-compact
// threshold) have no provider-side number to read.  Gateways serving
// non-Anthropic models make it worse: the CLI assumes a 200k-class window
// while e.g. GLM-5.2 actually exposes 1M.  This table keys on the
// UPSTREAM-REPORTED model id (assistant/message_start frames), not the
// requested alias — gateways remap aliases freely.
//
// Unknown models intentionally return null: a wrong window is worse than
// none (it would mis-trigger or suppress compaction), and null already
// disables window-relative behavior gracefully.

// Ordered [matcher, tokens]; first match wins.  Keep prefixes loose enough
// to catch dated variants (glm-5.2-…), tight enough to avoid cross-family
// collisions.
const MODEL_CONTEXT_WINDOWS = [
  [/^glm-5\.2/i, 1_000_000],
  [/^glm-5\.1/i, 1_000_000],
  [/^glm-5/i, 128_000],
  [/^glm-4\.[67]/i, 200_000],
  [/^glm-4(-flash)?$/i, 128_000],
  [/^deepseek-v[34]/i, 128_000],
  [/^deepseek/i, 64_000],
  [/^claude-opus-4/i, 200_000],
  [/^claude-(sonnet|haiku)-4/i, 200_000],
  [/^claude-3[-.](opus|sonnet)/i, 200_000],
  [/^claude-3[-.]5-sonnet/i, 200_000],
  [/^claude-3[-.]5-haiku/i, 200_000],
  [/^gpt-5\.[56]/i, 400_000],
  [/^gpt-5/i, 400_000],
];

export function lookupModelContextWindowTokens(model) {
  const id = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (!id) return null;
  for (const [matcher, tokens] of MODEL_CONTEXT_WINDOWS) {
    if (matcher.test(id)) return tokens;
  }
  return null;
}
