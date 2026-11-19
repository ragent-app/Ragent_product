// Compatibility exports. Provider frame recognition lives at the adapter boundary.
export {
  canonicalizeNativeDelegationProvider,
  createProviderNativeDelegationMapper,
  mapAgyProviderDelegationEvent,
  mapClaudeProviderDelegationEvent,
  mapCodexProviderDelegationEvent,
  replayProviderNativeDelegations,
} from './adapters/provider-native-delegation.mjs';
