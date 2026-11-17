// Compatibility exports. Provider frame recognition lives at the adapter boundary.
export {
  createProviderNativeDelegationMapper,
  mapClaudeProviderDelegationEvent,
  mapCodexProviderDelegationEvent,
  replayProviderNativeDelegations,
} from './adapters/provider-native-delegation.mjs';
