import { createAcpEventParser } from './acp-stdio.mjs';
import { getProviderCapabilities } from '../provider-contract.mjs';
import { getHarnessAdapterCompatibility } from '../harness-compatibility.mjs';

export const HERMES_RUNTIME_FAMILY = 'hermes-acp';

// Hermes' supported automation boundary is its official ACP server.  Keep the
// adapter deliberately thin: ACP owns message/tool framing while Ragent owns
// the durable Run, provider home, cancellation and approval policy.
export function createHermesAdapter() {
  const parser = createAcpEventParser({ provider: 'hermes', runtimeFamily: HERMES_RUNTIME_FAMILY });
  return {
    adapterCompatibility: getHarnessAdapterCompatibility('hermes'),
    capabilities: getProviderCapabilities(HERMES_RUNTIME_FAMILY),
    parseLine(line) {
      return parser.parseLine(line);
    },
    flush() { parser.reset(); return []; },
  };
}

// `hermes-acp` speaks ACP over stdin/stdout and receives the initial task via
// session/prompt. Returning no argv prevents prompts from leaking into process
// arguments and keeps the same protocol path usable on Windows.
export function buildHermesAcpArgs() {
  return [];
}
