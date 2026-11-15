import { buildRuntimeInvocation } from '../../chat/process-runner.mjs';

// Direct Codex diagnostics still go through Ragent's runtime contract. The
// harness receives provider-native permission flags derived from the
// Ragent risk mode; it never receives the generic `full-auto` value.
export function buildCodexDirectArgs(prompt, options = {}) {
  const invocation = buildRuntimeInvocation('codex-json', prompt, {
    riskMode: 'full-auto',
    ...options,
  }, 'codex-cli');
  if (invocation.args.includes('--full-auto')) {
    throw new Error('Ragent riskMode must not be forwarded as --full-auto');
  }
  return invocation.args;
}
