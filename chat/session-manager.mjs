import { WORKBENCH_EXECUTION_POLICY, assertWorkbenchExecution } from '../lib/workbench-execution-policy.mjs';
import { createHash, randomBytes } from 'crypto';
import { equivalentPendingApprovals } from './approval-equivalence.mjs';
import { resolveApprovedActionRunDirectories } from './approved-action-run-directories.mjs';
import { findSessionCreationReplay, sessionCreationError } from './session-creation-contract.mjs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { watch } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { scheduleLeadingTask, cancelLeadingTask } from './leading-task-scheduler.mjs';
import {
  CHAT_PORT,
  CAPABILITY_GRANT_USAGE_DIR,
  CONFIG_DIR,
  AGY_MANAGED_HOME_DIR,
  ORG_SESSION_ADDRESSABILITY_ENABLED,
  PUBLIC_BASE_URL,
} from '../lib/config.mjs';
import { accountPolicyToSessionRiskMode, loadAccountPermissionPolicy } from '../lib/account-policy.mjs';
import { captureWindowsOwnerDevice, validateWindowsOwnerDevice } from './windows-owner-device-authority.mjs';
import { isTemporaryControlApprovalActor, temporaryControlApprovalAudit } from '../lib/temporary-control-policy.mjs';
import { getToolDefinitionAsync } from '../lib/tools.mjs';
import { assertRunStartsAllowed } from '../lib/restart-interlock.mjs';
import {
  beginApiRequestPhase,
  measureApiRequestPhase,
  recordApiRequestPhase,
  setApiRequestCorrelation,
} from './api-request-log.mjs';
import { createToolInvocation } from './process-runner.mjs';
import {
  buildProviderContractFields,
  normalizeProviderPermissionMode,
  resolveProviderPermissionPolicy,
  requiresExplicitAcpAutoMode,
  getGatedPermissionModeId,
} from './provider-contract.mjs';
import { buildCanonicalContext } from './context-canonical.mjs';
import {
  CONTEXT_RENDERER_VERSION,
  VISITOR_TURN_GUARDRAIL,
  shouldIncludeSessionTemplateInstructions,
} from './context-renderer.mjs';
import {
  formatCodexAppServerApprovalDecision,
  normalizeCodexAppServerApprovalDecision,
} from './codex-app-server-protocol.mjs';
import {
  forkCodexAppServerThread,
} from './codex-app-server-client.mjs';
import {
  appendEvent,
  appendEvents,
  prepareLiveMessageTimeline,
  hydrateTimelineMessageSnapshots,
  appendInitializationEvents,
  clearContextHead,
  clearForkContext,
  findRuntimeApprovalRequest,
  readAllRuntimeApprovalEvents,
  forEachStoredEvent,
  getContextHead,
  getForkContext,
  getHistoryBase,
  getHistorySnapshot,
  initializeForkHistory,
  loadHistory,
  loadMeta,
  markSharedForkHistoryPending,
  materializeSharedHistory,
  readEventsAfter,
  readEventsRange,
  readEventsPage,
  readApprovedActionEvents,
  readApprovedActionContinuationEvents,
  readPlanEvents,
  readRuntimeApprovalEventsForRun,
  readPrivilegedBatchEvents,
  readEventBody,
  readLastEvent,
  removeSessionHistory,
  scheduleForkHistoryIndexBuild,
  setForkContext,
  setContextHead,
  waitForForkHistoryIndexBuild,
} from './history.mjs';
import { createContinuityReducer } from './continuity-core.mjs';
import { defaultContinuityStore, rebuildContinuityCheckpoint } from './continuity-store.mjs';
import { buildExecutionStateProjection } from './execution-state-projection.mjs';
import { createContextReceipt, validateContextReceipt } from './context-receipt.mjs';
import { buildToolResultDescriptors } from './tool-result-descriptor.mjs';
import { assembleContextPlan } from './context-attention-assembler.mjs';
import { compileRuntimeContext } from './runtime-context-compiler.mjs';
import { normalizeUiLanguagePreference, pickLocalizedText } from './ui-language.mjs';
import { normalizeCodexServiceTier } from '../lib/codex-service-tier.mjs';
import { parseScopedCodexModel, getToolModelCatalog } from './models.mjs';
import {
  resolvePrivilegedCategoryApproval,
  resolvePrivilegedInstallAutoApproval,
  surfacePrivilegedBatchRequest,
  buildPrivilegedShimDeclineUpdate,
  buildPrivilegedShimPolicyDenialUpdate,
  buildPrivilegedShimInstallAutoUpdate,
  buildPrivilegedShimResolveUpdate,
  buildPrivilegedShimCategoryUpdate,
  buildPrivilegedShimTerminalUpdate,
} from './privileged-approval.mjs';
import {
  CATEGORY_INSTALL,
  CATEGORY_DELETE,
  CATEGORY_OTHER,
} from './privileged-classifier.mjs';
import {
  executePrivilegedOpAsEvent,
  getActivePrivilegedSigningKey,
  loadOrCreatePrivilegedSigningKeys,
} from './privileged-signing-keys.mjs';
import {
  PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK,
  PRIVILEGED_TOKEN_AUTH_MODE_PASSKEY,
} from './privileged-token.mjs';
import {
  computeBatchManifestHash,
  privilegedBatchResponseEvent,
  privilegedExecResultEvent,
} from './privileged-ops.mjs';
import {
  approvalRequestEvent,
  approvalResponseEvent,
  contextOperationEvent,
  managerContextEvent,
  messageEvent,
  planEvent,
  planEventModeFields,
  statusEvent,
} from './normalizer.mjs';
import { appendUsageLedgerRecord, buildUsageLedgerRecord } from './usage-ledger.mjs';
import {
  triggerSessionTaskCardSuggestion,
  triggerSessionWorkflowStateSuggestion,
} from './summarizer.mjs';
import { buildSourceRuntimePrompt } from './source-runtime-prompts.mjs';
import { sendCompletionPush, sendUserAttentionPush } from './push.mjs';
import { buildSystemContext } from './system-prompt.mjs';
import {
  normalizeSessionAgreements,
} from './session-agreements.mjs';
import {
  buildSessionContinuationContextFromBody,
  prepareSessionContinuationBody,
} from './session-continuation.mjs';
import {
  buildPreparedContinuationPromptFromWorkState,
  buildSessionControlState,
  buildSessionWorkState,
} from './session-control-state.mjs';
import {
  broadcastAll,
  broadcastOwners,
  broadcastSessionEvents,
  getClientsMatching,
  sendWithBackpressure,
} from './ws-clients.mjs';
import {
  bareProviderModel,
  classifyProviderFailure,
  hasProviderSideEffects,
  rankProviderFailoverCandidates,
  resolveProviderFailoverModel,
  shouldFailoverProvider,
} from '../lib/provider-runtime/failover.mjs';
import {
  DEFAULT_SESSION_NAME,
  isSessionAutoRenamePending,
  normalizeSessionName,
  normalizeSessionDescription,
  normalizeSessionGroup,
  resolveInitialSessionName,
} from './session-naming.mjs';
import {
  isProviderRunCompletionEvent,
  isProviderSuccessfulTerminalPayload,
  providerRequiresTerminalEvidence,
} from './run-terminal-signals.mjs';
import {
  normalizeSessionEntryMode,
  resolveSessionEntryMode,
} from './session-entry-mode.mjs';
import {
  approvedActionCapabilityTtlMs,
  isHostExecutionClass,
  isOwnerHostPasskeyRequired,
  isPrivilegeRoutingEnabled,
  isProductExecutionClass,
} from './approved-action-policy.mjs';
import {
  APPROVED_ACTION_STATE,
  buildApprovedAction,
  buildOptionalApprovedAction,
  buildApprovedActionAuditEvent,
  computeApprovedActionSelectionHash,
  createApprovedActionClientEventProjection,
  createApprovedActionClientProjection,
  isApprovedActionExpired,
} from './approved-actions.mjs';
import { createApprovedActionStore } from './approved-action-store.mjs';
import { getWindowsManagedAutoInstallStatus, loadWindowsAutoInstallPublicIdentity, loadWindowsAutoInstallSigningKey, prepareWindowsManagedUserInstall, tryWindowsManagedAutoInstall, verifyWindowsManagedUserInstallAuthorization } from './windows-managed-auto-install.mjs';
import { createWindowsPrivilegedBrokerClient } from './windows-privileged-broker.mjs';
import { queryWindowsServiceProposalFromCommand, submitOrResumeWindowsServiceProposal, waitWindowsServiceProposal } from './windows-service-proposal.mjs';
import { activeWindowsServiceRequest } from './windows-service-activity.mjs';
import { dispatchApprovedActionProposal } from './approved-action-queue.mjs';
import { createWindowsUserInstallStore } from './windows-user-install-store.mjs';
import { windowsUserInstallOperationFingerprint } from './windows-user-install-executor.mjs';
import { resolvePrivilegedBatchPolicy, deferWindowsLegacyInstallBatch } from './privileged-permission-profile.mjs';
import { buildHostPermissionFacts, executeApprovedAction } from './approved-action-executor.mjs';
import {
  isApprovedActionSemanticProjectionIntact,
  prepareApprovedActionSemanticProjection,
} from './approved-action-semantic.mjs';
import {
  isAgentCreateApprovedAction,
  isAgentCreateApprovedActionEnabled,
  isAgentCreateSessionEligible,
  prepareAgentCreateSemanticProjection,
  validateAgentCreatePayloadRegistries,
} from './approved-agent-create.mjs';
import {
  canIssueSessionControl,
  createRunSessionControlCapability,
  createRunSessionControlRenewalCapability,
} from './session-control-capability.mjs';
import { openCapabilityGrantStore } from './capability-grant-store.mjs';
import {
  createCapabilityGrant,
  CAPABILITY_AUTHORIZATION_CLASSES,
  CAPABILITY_WORKLOAD_SCOPES,
  PERMISSION_MODES,
  STRONG_AUTH_ACTIONS,
} from './permission-policy.mjs';
import {
  createCapabilityGrantProof,
  createPermissionFactsProof,
} from './permission-proof-verifier.mjs';
import {
  normalizeSessionWorkflowPriority,
  normalizeSessionWorkflowState,
} from './session-workflow-state.mjs';
import {
  formatAttachmentContextLine,
  getMessageAttachments,
  stripEventAttachmentSavedPaths,
} from './attachment-utils.mjs';

const TRUSTED_SERVER_HOME = homedir();
import {
  appendRunSpoolRecord,
  clearRunResult,
  createRun,
  createRunId,
  findRunByRequest,
  getRun,
  getRunManifest,
  getRunResult,
  isTerminalRunState,
  listRunIds,
  listRunIndexEntries,
  listDurableSessionRunIndexEntries,
  materializeRunSpoolLine,
  readRunSpoolDelta,
  readRunSpoolRecords,
  scanRunSpoolRecords,
  streamRunSpoolRecords,
  requestRunCancel,
  recoverLinuxRunScopeRevocations,
  removeRunsForSession,
  runDir,
  updateRun,
  updateRunManifest,
  writeRunResult,
} from './runs.mjs';
import { spawnDetachedRunner } from './run-launcher.mjs';
import { withMessageRequestIdentity } from './message-request-identity.mjs';
import { assertNoMessagePreparationReuse, validatePreparedMessageAttachments } from './message-preparation-store.mjs';
import { continueScopedMessageRun, admitScopedMessageLaunch } from './message-commit-store.mjs';
import { publishSessionRun } from './session-run-admission.mjs';
import { currentMessageExecution, withoutMessageExecution, applyMessageExecutionConfiguration } from './message-execution-context.mjs';
import { appendRetainedMessageEvent } from './history.mjs';
import { createRunProjectionService } from './run-projection.mjs';
import {
  createDetachedRunReconciler,
  isRecordedProcessAlive,
} from './run-reconciler.mjs';
import { resolveRunHeartbeatStaleMs } from './run-liveness.mjs';
import { reconcileProviderNativeDelegationRun } from './provider-native-delegation-runtime.mjs';
import { reconcileAgyRunCredential } from '../lib/provider-runtime/agy-credential-sync.mjs';
import { createCredentialMutationLedger } from '../lib/provider-runtime/credential-mutation.mjs';
import {
  acquireAgyAccountLock,
  isRecoverableAgyAccountLockOwner,
  listAgyAccountLocks,
  releaseAgyAccountLock,
} from '../lib/provider-runtime/agy-account-lock.mjs';
import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';
import { createAgyRotationStore } from '../lib/provider-runtime/agy-rotation.mjs';
import { resolveDefaultProviderProfileId } from '../lib/provider-runtime/run-provider-prepare.mjs';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import {
  classifyRunAuthFailure,
  normalizeRunAuthRecovery,
  planRunAuthRecovery,
} from '../lib/provider-runtime/run-auth-recovery.mjs';
import { validateRunModelSelection } from '../lib/provider-runtime/model-catalog.mjs';
import { resolveClaudeModelContract } from '../lib/provider-runtime/claude-model-contract.mjs';
import { sortAgyQueuedRuns } from '../lib/provider-runtime/agy-queue.mjs';
import { isEnvToggleEnabled } from '../lib/env-toggle.mjs';
import {
  getAdaptiveConcurrencyBudget,
  getAdaptiveHarnessBudget,
} from './adaptive-concurrency-registry.mjs';
import {
  filterUnknownHarnessEvents,
  getProviderEventReplayKey,
} from './provider-event-dedup.mjs';
import {
  getHarnessEventPolicy,
  isHarnessEphemeralEvent,
  limitHarnessDurableEvents,
} from './harness-event-policy.mjs';
import { BoundedLruMap } from './cache-utils.mjs';
import { registerCache } from './memory-registry.mjs';
import { cacheBudget } from '../lib/cache-budget.mjs';
import { buildEventBlockEvents, buildSessionDisplayEvents, filterSessionDisplayPushEvents } from './session-display-events.mjs';
import { projectMessageTimelineIdentities } from './message-timeline.mjs';
import { buildRunActivityProjection } from './run-activity-projection.mjs';
import {
  buildSessionActivity,
  getSessionQueueCount,
  getSessionRunId,
  isSessionRunning,
  normalizeAuthRecoveryForActivity,
  resolveSessionRunActivity,
} from './session-activity.mjs';
import {
  findSessionMeta,
  findSessionMetaCached,
  loadSessionsMeta,
  mutateSessionMeta,
  removeSessionMeta,
  withSessionsMetaMutation,
} from './session-meta-store.mjs';
import { createKeyedTaskQueue } from './fs-utils.mjs';
import { dispatchSessionEmailCompletionTargets, sanitizeEmailCompletionTargets } from '../lib/agent-mail-completion-targets.mjs';
import { dispatchSessionConnectorActions, sanitizeAllCompletionTargets } from '../lib/connector-action-dispatcher.mjs';
import {
  consumeOwnerWebAuthnProof,
  createOwnerWebAuthnAssertionOptions,
  verifyOwnerWebAuthnAssertion,
} from '../lib/owner-webauthn.mjs';
import { buildRunConnectorSurface, buildSessionConnectorSurface } from './session-connectors.mjs';
import { getSessionLocalBridgeSurface } from './local-bridge-store.mjs';
import {
  repairSessionRuntimeTool,
  resolveSessionRuntimeTool,
} from './session-runtime-binding.mjs';
import {
  DEFAULT_APP_ID,
  createApp,
  getApp,
  getBuiltinApp,
  listApps,
  normalizeAppId,
} from './apps.mjs';
import {
  shouldRunDispatch,
  shouldUseAsyncDispatchPlanning,
  executeContinuationPlan,
  isTrivialContinuationPlan,
  planSessionContinuations,
} from './session-dispatch.mjs';
import { publishLocalFileAssetFromPath } from './file-assets.mjs';
import { stageAttachmentInputs } from './file-asset-input-staging.mjs';
import {
  normalizeSessionTaskCard,
} from './session-task-card.mjs';
import {
  normalizeSessionGoalIntent,
  buildCodexGoalIntent,
  applyGoalSnapshot,
  extractCodexGoalSnapshotFromEvents,
  isAgyRuntimeFamily,
  isPromptGoalRuntimeFamily,
  buildPromptGoalSection,
} from './session-goal.mjs';
import {
  buildDelegationHandoff,
  clipCompactionSection,
} from './session-context-compaction.mjs';
import {
  WELCOME_STARTER_PRESET,
  normalizeSessionStarterPreset,
} from './session-starter-preset.mjs';
import {
  ensureProjectForSessionFolder,
  ensureProjectsInitialized,
  expandProjectRootPath,
  getProject,
  normalizeProjectId,
} from './projects.mjs';
import { prepareRunExecution } from './run-admission.mjs';
import {
  buildCodexContextMetricsPayload,
  readLatestCodexSessionMetrics,
} from './codex-session-metrics.mjs';
import {
  applyCompactionWorkerResult,
  COMPACTION_LEVEL,
  getProgressiveCompactionLevel,
  INTERNAL_SESSION_ROLE_CONTEXT_COMPACTOR,
  maybeApplyContextBudget,
  queueContextCompaction,
} from './session-auto-compaction.mjs';
import {
  findLatestAssistantMessageForRun,
  maybeApplyAssistantSessionLabels,
  maybeApplyAssistantTaskCard,
  scheduleSessionTaskCardSuggestion,
} from './session-assistant-followups.mjs';
import {
  applyAssistantSessionLabelsToSession,
  claimPendingSessionTitleForRun,
} from './session-labels.mjs';
import { runDetachedAssistantPrompt } from './session-detached-assistant.mjs';
import {
  buildReplySelfCheckPrompt,
  buildReplySelfRepairPrompt,
  isReplySelfCheckClearlyComplete,
  isReplySelfCheckWaitingForUser,
  loadReplySelfCheckTurnContext,
  parseReplySelfCheckDecision,
  summarizeReplySelfCheckReason,
} from './session-reply-self-check.mjs';
import {
  buildReplyPublicationPayload,
  collectReplyPublicationHistory,
  getRunResponseIds,
  normalizeReplyPublicationResponseIds,
  resolveReplyPublicationUserEvent,
  runIncludesResponseId,
  sourceContextReferencesRequest,
} from './reply-publication.mjs';
import { maybeRunMemoryWriteback } from './session-memory-writeback.mjs';
import { createSessionTurnCompletionHelpers } from './session-turn-completion.mjs';
import {
  buildProjectMemoryContext,
  scheduleProjectMemoryForFinalizedRun,
  scheduleProjectMemoryRefresh,
} from './project-memory-engine.mjs';
import { extractTaggedBlock } from './session-text-parsing.mjs';
import { buildTurnContextHook } from './turn-context-hook.mjs';
import {
  buildDelegationResultFromRun,
  normalizeDelegationResult,
  projectDelegationResults,
} from './delegation-result.mjs';
import { processRootLeadershipProposal } from './organization-leader-ingress.mjs';
import { processCollaborationPlan } from './collaboration-leader-ingress.mjs';
import { provisionRootLeadershipRevision } from './organization-provisioning.mjs';
import { createManagedSessionForNode } from './organization-managed-session-factory.mjs';
import { displayPromptPath } from './prompt-paths.mjs';
import {
  EXTENSION_MIME_TYPES,
  IMAGE_MAX_DIMENSION,
  MIME_EXTENSIONS,
  RESIZABLE_MIME_TYPES,
  buildMessageAttachmentRefs,
  normalizeAttachmentSizeBytes,
  resolveAttachmentExtension,
  resolveAttachmentMimeType,
  resizeImageIfNeeded,
  resolveSavedAttachments,
  sanitizeOriginalAttachmentName,
  saveAttachments,
} from './session-attachments.mjs';
import {
  collectAssistantLocalMarkdownImageRewrites,
  collectAssistantLocalResultFileRewrites,
  collectGeneratedResultFilesFromRun,
  collectUnresolvedAssistantFileReferences,
  normalizePublishedResultAssetAttachments,
} from './session-result-files.mjs';
import {
  buildSavedTemplateContextContent,
  formatSessionSourceNameFromId,
  hasRequestedSessionSourceHint,
  normalizeSessionSourceName,
  normalizeSessionTemplateName,
  normalizeSessionUserName,
  normalizeSessionVisitorName,
  parseTimestampMs,
  resolveAuthSessionAgentId,
  resolveAuthSessionPrincipalId,
  resolveRequestedSessionPrincipalFields,
  resolveRequestedSessionSourceId,
  resolveRequestedSessionSourceName,
  resolveSessionAgentId,
  resolveSessionPrincipalId,
  resolveSessionSourceId,
  resolveSessionSourceName,
  resolveSessionTemplateId,
  resolveSessionTemplateName,
} from './session-source-resolution.mjs';
import {
  assertManagedInputAllowed,
  assertManagedSessionLineage,
  assertUserAddressable,
  isManagedSessionClass,
  normalizeManagedScope,
  normalizeSessionClass,
  resolveSessionClass,
} from './managed-input.mjs';
import {
  buildSessionHierarchyIndex,
  buildSessionHierarchyProjection,
  isRootSessionMeta,
} from './session-hierarchy.mjs';

const INTERNAL_SESSION_ROLE_AGENT_DELEGATE = 'agent_delegate';
const REPLY_SELF_REPAIR_INTERNAL_OPERATION = 'reply_self_repair';
const REPLY_SELF_CHECK_REVIEWING_STATUS = 'Assistant self-check: reviewing the latest reply for early stop…';
const REPLY_SELF_CHECK_ACCEPT_STATUS = 'Assistant self-check: kept the latest reply as-is.';
const REPLY_SELF_CHECK_DEFAULT_REASON = 'the latest reply left avoidable unfinished work';

const FOLLOW_UP_FLUSH_DELAY_MS = 1500;
const MAX_RECENT_FOLLOW_UP_REQUEST_IDS = 100;
const STARTUP_RECOVERY_BATCH_SIZE = (() => {
  const parsed = Number.parseInt(String(process.env.AGENTOC_STARTUP_RECOVERY_BATCH_SIZE || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 8;
})();
// Perf (AGENTOC_PERF_OBSERVER=off restores the old behavior): the fs.watch on
// the run dir is the live fast path for spool appends; the poller is only a
// backstop for missed watch events (inotify overflow), so 1s is plenty and
// cuts idle-run observer churn ~4x.
const AGENTOC_PERF_OBSERVER_ENV = 'AGENTOC_PERF_OBSERVER';
const PERF_OBSERVER_ENABLED = isEnvToggleEnabled(process.env[AGENTOC_PERF_OBSERVER_ENV], { defaultValue: true });
const OBSERVED_RUN_POLL_INTERVAL_MS = PERF_OBSERVER_ENABLED ? 1000 : 250;
const DETACHED_RUN_RESULT_SYNTHESIS_GRACE_MS = 1500;
const DETACHED_RUN_LAUNCH_GRACE_MS = 30_000;
const ORPHAN_RUN_SWEEP_INTERVAL_MS = 5 * 60_000;
const AGY_QUEUE_DRAIN_RETRY_MS = 10_000;
const MAX_AGY_QUEUE_DRAIN_CANDIDATES = 64;
const CONTINUATION_PLANNER_TIMEOUT_MS = 15_000;
const PENDING_PLANNING_STALE_MS = 30_000;
const FOLLOW_UP_STEER_CANCEL_TIMEOUT_MS = 8_000;
// Terminal replay consumes the complete spool as a stream, but only keeps a
// bounded control/event tail for finalization side effects. Durable events are
// flushed in small batches so a very long Run cannot turn completion into an
// unbounded array or a WebSocket-sized push burst.
const MAX_TERMINAL_RETAINED_EVENTS = 4096;
const MAX_TERMINAL_PENDING_EVENTS = 512;
const MAX_TERMINAL_PUSH_EVENTS = 512;

const MAX_DELEGATION_DEPTH = 3;
const DELEGATION_RATE_WINDOW_MS = 60_000;
const DELEGATION_RATE_MAX_PER_WINDOW = 8;
const _delegationTimestamps = [];

function normalizeSessionSidebarOrder(value) {
  const parsed = typeof value === 'number'
    ? value
    : parseInt(String(value || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

const sessionRuntimeStateById = new Map();
const observedRuns = new Map();
const agyRunLocks = new Map();
const agyLaunchesInFlight = new Set();
const agyLockRecoveryPromises = new Map();
const harnessRunLeases = new Map();
const yieldedRunLeaseIds = new Set();
// Process-local index of durable runs waiting only for adaptive capacity.
// Keeping this separate from the run directory avoids a full spool/run scan
// on every lease release when an instance owns many historical runs.
const adaptiveQueuedRunIds = new Set();
const detachedRunLaunchPromises = new Map();
const preparingRunPromises = new Map();
const scopedMessageTimers = new Map();
let scopedMessageEpoch = 0;
let adaptiveRunDrainTimer = null;
let adaptiveRunDrainBusy = false;
let agyQueueDrainTimer = null;
const MAX_ADAPTIVE_DRAIN_CANDIDATES = 64;
const harnessRunBudget = getAdaptiveConcurrencyBudget('harnessRuns');
const runSyncPromises = new Map();
const runPostFinalizePromises = new Map();
const approvedActionProposalQueue = createKeyedTaskQueue();
const approvedActionResolutionQueue = createKeyedTaskQueue();
const runAuthRecoveryQueue = createKeyedTaskQueue();
const runAuthRecoveryLaunchPromises = new Map();
const RESUMABLE_AUTH_RECOVERY_LAUNCH_STATES = new Set([
  'auth_retry_pending',
  'auth_retry_launching',
  'lifecycle_submitting',
]);
const privilegedCategoryApprovalQueue = createKeyedTaskQueue();
let totalObservedRuns = 0;
let orphanRunSweepPromise = null;
let orphanRunSweepTimer = null;
let linuxRunScopeRecoveryTimer = null;
let linuxRunScopeRecoveryPromise = null;
let linuxRunScopeRenewalTimer = null;
let linuxRunScopeRenewalPromise = null;
let linuxRunScopeOutboxTimer = null;
let linuxRunScopeOutboxPromise = null;
let linuxRunResultTransactionTimer = null;
let linuxRunResultTransactionPromise = null;

// Memory registry (DS-06): active detached-run watchers.
registerCache('observedRuns', {
  kind: 'observed-runs',
  snapshot: () => ({
    entries: observedRuns.size,
    bytes: 0,
    hits: totalObservedRuns,
    misses: 0,
    evictions: 0,
    hitRate: null,
    oldestEntryAgeMs: null,
    maxEntries: null,
    maxBytes: null,
  }),
});
// Memory registry (DS-06 + DS-07): per-session runtime state. `stale` counts
// entries idle past the current TTL (they will be released by the next sweep
// unless activity or a guard blocks it) — the observable proof that the map is
// bounded by active sessions, not by every session ever touched.
registerCache('session.runtime', {
  kind: 'runtime-state',
  snapshot: (now = Date.now()) => {
    const ttlMs = resolveSessionRuntimeTtlMs();
    let stale = 0;
    for (const state of sessionRuntimeStateById.values()) {
      if (now - (state.lastActivityAt || 0) >= ttlMs) stale += 1;
    }
    return {
      entries: sessionRuntimeStateById.size,
      bytes: 0,
      hits: 0,
      misses: 0,
      evictions: 0,
      hitRate: null,
      oldestEntryAgeMs: null,
      maxEntries: null,
      maxBytes: null,
      stale,
      ttlMs,
    };
  },
});
// Memory registry (DS-06 + DS-07): timeline-bundle invalidation generation.
registerCache('timeline.generation', {
  kind: 'generation-map',
  snapshot: () => ({
    entries: timelineInvalidationGeneration.size,
    bytes: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
    hitRate: null,
    oldestEntryAgeMs: null,
    maxEntries: null,
    maxBytes: null,
  }),
});
// Per-session cache of provider-event dedup keys already persisted to history.
// Lets the observer skip the full-history load on delta ticks where every new
// candidate key is already known — the common streaming case, where the same
// provider-identified events are re-emitted across spool lines. The set is
// rebuilt from authoritative persisted history on first touch and dropped when
// the bounded maps overflow, so eviction costs at most one future full load
// (the status quo cost). History files are never deleted (compaction only
// advances activeFromSeq), so the set cannot diverge from persisted events.
const KNOWN_DEDUP_KEY_SESSIONS = 160;
const KNOWN_DEDUP_KEYS_PER_SESSION = 50_000;
const knownProviderDedupKeys = new Map(); // sessionId -> Set<string>
// Dedup-set observability (DS-06): per-set insertion time and total key bytes
// so the registry can report age/bytes without O(all keys) scans per snapshot.
const dedupKeySetInsertMs = new Map();
const dedupKeySetBytes = new Map(); // sessionId -> sum of key string lengths
let dedupTotalKeyBytes = 0;
let dedupSetHits = 0;
let dedupSetMisses = 0;

// Memory registry (DS-06): dedup key sets — entries = sessions with a seeded
// set; bytes/age tracked incrementally so the snapshot is O(sessions), never
// O(total keys).
registerCache('dedup.knownKeySets', {
  kind: 'dedup-sets',
  snapshot: (now = Date.now()) => {
    let oldestInsertMs = null;
    for (const insertedMs of dedupKeySetInsertMs.values()) {
      if (oldestInsertMs == null || insertedMs < oldestInsertMs) oldestInsertMs = insertedMs;
    }
    const lookups = dedupSetHits + dedupSetMisses;
    return {
      entries: knownProviderDedupKeys.size,
      bytes: dedupTotalKeyBytes,
      hits: dedupSetHits,
      misses: dedupSetMisses,
      evictions: 0,
      hitRate: lookups > 0 ? Math.round((dedupSetHits / lookups) * 10000) / 10000 : null,
      oldestEntryAgeMs: oldestInsertMs == null ? null : Math.max(0, now - oldestInsertMs),
      maxEntries: KNOWN_DEDUP_KEY_SESSIONS,
      maxBytes: null,
    };
  },
});

function getKnownDedupKeySet(sessionId) {
  const set = knownProviderDedupKeys.get(sessionId);
  if (set) {
    dedupSetHits += 1;
    // LRU touch so hot sessions survive the bounded outer map.
    knownProviderDedupKeys.delete(sessionId);
    knownProviderDedupKeys.set(sessionId, set);
  } else {
    dedupSetMisses += 1;
  }
  return set || null;
}

function rememberDedupKeySet(sessionId, set) {
  const hadSet = knownProviderDedupKeys.has(sessionId);
  knownProviderDedupKeys.delete(sessionId);
  let setBytes = 0;
  if (set) {
    for (const key of set) setBytes += typeof key === 'string' ? key.length : 0;
  }
  if (hadSet) dedupTotalKeyBytes -= dedupKeySetBytes.get(sessionId) || 0;
  knownProviderDedupKeys.set(sessionId, set);
  dedupTotalKeyBytes += setBytes;
  dedupKeySetBytes.set(sessionId, setBytes);
  dedupKeySetInsertMs.set(sessionId, Date.now());
  while (knownProviderDedupKeys.size > KNOWN_DEDUP_KEY_SESSIONS) {
    const oldest = knownProviderDedupKeys.keys().next().value;
    if (oldest === undefined) break;
    knownProviderDedupKeys.delete(oldest);
    dedupTotalKeyBytes -= dedupKeySetBytes.get(oldest) || 0;
    dedupKeySetBytes.delete(oldest);
    dedupKeySetInsertMs.delete(oldest);
  }
}

// Record newly persisted provider-identified events into the session's known
// set (if one exists). A session whose set outgrows the per-session cap is
// dropped entirely — its next tick pays one full load, no worse than the
// pre-cache behavior for pathological sessions.
function noteDedupKeysSeen(sessionId, events) {
  const set = knownProviderDedupKeys.get(sessionId);
  if (!set) return;
  for (const event of Array.isArray(events) ? events : []) {
    const key = getProviderEventReplayKey(event);
    if (!key) continue;
    if (set.has(key)) continue;
    if (set.size >= KNOWN_DEDUP_KEYS_PER_SESSION) {
      knownProviderDedupKeys.delete(sessionId);
      dedupTotalKeyBytes -= dedupKeySetBytes.get(sessionId) || 0;
      dedupKeySetBytes.delete(sessionId);
      dedupKeySetInsertMs.delete(sessionId);
      return;
    }
    set.add(key);
    const keyBytes = typeof key === 'string' ? key.length : 0;
    dedupTotalKeyBytes += keyBytes;
    dedupKeySetBytes.set(sessionId, (dedupKeySetBytes.get(sessionId) || 0) + keyBytes);
  }
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Seed the active-run dedup set without materializing a complete transcript.
// When a pathological session exceeds the retained-key cap, keep only the
// candidate keys seen in storage; the caller can still filter this batch
// exactly while avoiding a full history array and avoiding an unbounded Set.
async function scanProviderDedupKeys(sessionId, candidates = [], options = {}) {
  const retainAllKeys = options.retainAllKeys !== false;
  const candidateKeys = new Set();
  for (const event of Array.isArray(candidates) ? candidates : []) {
    const key = getProviderEventReplayKey(event);
    if (key) candidateKeys.add(key);
  }
  const candidateKeysFound = new Set();
  const allKeys = retainAllKeys ? new Set() : null;
  let capped = !retainAllKeys;
  await forEachStoredEvent(sessionId, (event) => {
    const key = getProviderEventReplayKey(event);
    if (!key) return;
    if (candidateKeys.has(key)) candidateKeysFound.add(key);
    if (!allKeys || capped) return;
    if (allKeys.has(key)) return;
    if (allKeys.size >= KNOWN_DEDUP_KEYS_PER_SESSION) {
      capped = true;
      return;
    }
    allKeys.add(key);
  });
  return { keys: allKeys, candidateKeys: candidateKeysFound, capped };
}

function filterProviderEventsAgainstScan(candidates, scan) {
  const knownKeys = scan?.keys instanceof Set ? scan.keys : scan?.candidateKeys;
  return filterUnknownHarnessEvents(candidates, knownKeys instanceof Set ? knownKeys : new Set());
}
const MAX_SESSION_SOURCE_CONTEXT_BYTES = 16 * 1024;
// When a session has no compaction head (context.json), the fork-context
// "history" branch must not load the entire transcript (can be tens of
// thousands of events, which both blows the heap and re-injects the oldest
// turns as if they were current). Bound it to a recent window instead.
const MAX_FORK_HISTORY_EVENTS = 200;
const MAX_PROVIDER_RESUME_DELTA_EVENTS = 200;
const HISTORICAL_FORK_PAGE_SIZE = 200;
const historicalForkQueue = createKeyedTaskQueue();

function nowIso() {
  return new Date().toISOString();
}

function getCompactionServices() {
  return { appendEvent, broadcastSessionInvalidation, clearPersistedResumeIds, createSession, enrichSessionMeta, ensureSessionRuntimeState, getSession, getSessionQueueCount, isContextCompactorSession, loadSessionsMeta, mutateSessionMeta, nowIso, sendMessage };
}

function getTaskCardFollowupServices() {
  return { getSession, isInternalSession, isTaskCardEnabledForSession, triggerSessionTaskCardSuggestion, updateSessionTaskCard };
}

function normalizeSourceContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized === '{}' || Buffer.byteLength(serialized, 'utf8') > MAX_SESSION_SOURCE_CONTEXT_BYTES) {
      return null;
    }
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

const synthesizeDetachedRunTermination = createDetachedRunReconciler({
  appendRunSpoolRecord,
  collectRunOutputPreview,
  graceMs: DETACHED_RUN_RESULT_SYNTHESIS_GRACE_MS,
  launchGraceMs: DETACHED_RUN_LAUNCH_GRACE_MS,
  isTerminalRunState,
  nowIso,
  stallAfterMs: resolveRunHeartbeatStaleMs(),
  shouldSkipRunnerStall: (run) => hasPendingApprovedActionPause(run) || Boolean(activeWindowsServiceRequest(run)),
  onRunnerStalled: async ({
    runId,
    run,
    runnerProcessAlive,
    runnerUnitActive,
    toolAlive,
    heartbeatAgeMs,
    staleAfterMs,
  }) => {
    const stalledAt = nowIso();
    let claimed = false;
    const stalledRun = await updateRun(runId, (current) => {
      if (!current || isTerminalRunState(current.state) || current.cancelRequested === true || current.stalledAt) {
        return current;
      }
      claimed = true;
      return {
        ...current,
        cancelRequested: true,
        cancelRequestedAt: current.cancelRequestedAt || stalledAt,
        stalledAt,
        stalledReason: 'runner_heartbeat_stale',
      };
    });
    if (!claimed) return stalledRun;
    const diagnostic = {
      type: 'run.runner_stalled',
      heartbeatAgeMs: Math.max(0, heartbeatAgeMs || 0),
      staleAfterMs,
      runnerProcessAlive,
      runnerUnitActive,
      toolAlive,
      lastHeartbeatAt: run?.runnerHeartbeatAt || null,
    };
    await appendRunSpoolRecord(runId, {
      ts: stalledAt,
      stream: 'error',
      line: `Detached runner heartbeat stale for ${Math.round(Math.max(0, heartbeatAgeMs || 0) / 1000)}s; cancellation requested`,
      json: diagnostic,
    }).catch((error) => {
      console.error(`[runs] Failed to append stalled-run diagnostic for ${runId}: ${error?.message || error}`);
    });
    console.error(`[runs] Runner heartbeat stale; cancellation requested for ${runId}: ${JSON.stringify(diagnostic)}`);
    return stalledRun;
  },
  reconcileProviderNativeDelegationRun,
  readRunSpoolRecords,
  streamRunSpoolRecords,
  updateRun: async (runId, updater) => updateRun(runId, updater),
  writeRunResult,
});
const {
  collectNormalizedRunEvents,
  collectNormalizedRunEventDelta,
  releaseRunRuntimeInvocation,
} = createRunProjectionService({
  buildCodexContextMetricsPayload,
  clipPreview: clipFailurePreview,
  createToolInvocation,
  materializeRunSpoolLine,
  normalizeRunEvents,
  readLatestCodexSessionMetrics,
  readRunSpoolDelta,
  readRunSpoolRecords,
  streamRunSpoolRecords,
  scanRunSpoolRecords,
});

const MAX_LIVE_REASONING_CHARS_PER_PUSH = 16 * 1024;
const PROVIDER_SEMANTIC_EVENT_TYPES = new Set([
  'reasoning', 'text_delta', 'message', 'tool_use', 'tool_result', 'file_change',
  'plan', 'approval_request', 'approval_response', 'privileged_batch_request',
  'privileged_batch_response', 'approved_action_batch_request',
  'approved_action_batch_response', 'approved_action_state', 'context_barrier',
  'context_operation', 'status',
]);

function isReasoningDeltaEvent(event) {
  if (event?.type !== 'reasoning') return false;
  return event.reasoningLifecycle === 'delta'
    || event.operationLifecycle === 'delta'
    || event.providerLifecycle === 'delta'
    || event.state === 'running';
}

function sameReasoningStream(left, right) {
  if (!isReasoningDeltaEvent(left) || !isReasoningDeltaEvent(right)) return false;
  return trimString(left.runId) === trimString(right.runId)
    && trimString(left.providerBlockId) === trimString(right.providerBlockId)
    && Number(left.blockIndex || 0) === Number(right.blockIndex || 0);
}

// Provider reasoning commonly arrives one token per JSONL frame. Keep the raw
// spool and normalized event count exact, but send one bounded live update for
// each contiguous reasoning stream in an observer tick. This prevents a burst
// of thousands of Claude/Codex/Pi reasoning fragments from becoming thousands
// of WebSocket renders while preserving event order around tools and messages.
export function coalesceHarnessLiveReasoningEvents(events = []) {
  const output = [];
  let pending = null;
  let pendingCount = 0;

  const flush = () => {
    if (!pending) return;
    output.push({
      ...pending,
      ...(pendingCount > 1 ? { coalesced: true, reasoningDeltaCount: pendingCount } : {}),
    });
    pending = null;
    pendingCount = 0;
  };

  for (const event of Array.isArray(events) ? events : []) {
    if (!isReasoningDeltaEvent(event)) {
      flush();
      output.push(event);
      continue;
    }
    if (!pending || !sameReasoningStream(pending, event)) {
      flush();
      pending = { ...event };
      pendingCount = 1;
      continue;
    }
    const content = `${typeof pending.content === 'string' ? pending.content : ''}${typeof event.content === 'string' ? event.content : ''}`;
    pending = {
      ...pending,
      ...event,
      content: content.length > MAX_LIVE_REASONING_CHARS_PER_PUSH
        ? content.slice(-MAX_LIVE_REASONING_CHARS_PER_PUSH)
        : content,
      ...(content.length > MAX_LIVE_REASONING_CHARS_PER_PUSH ? { contentTruncated: true } : {}),
    };
    pendingCount += 1;
  }
  flush();
  return output;
}

function latestHarnessEventIso(events, predicate, fallbackIso) {
  let latestMs = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (!predicate(event)) continue;
    const timestamp = typeof event?.timestamp === 'number'
      ? event.timestamp
      : Date.parse(String(event?.timestamp || ''));
    if (Number.isFinite(timestamp) && timestamp > latestMs) latestMs = timestamp;
  }
  return latestMs > 0 ? new Date(latestMs).toISOString() : fallbackIso;
}

export function buildDetachedRunPushEvents(normalizedEvents = [], durableEvents = [], storedDurableEvents = []) {
  const storedByOriginalEvent = new Map();
  const storedByEventId = new Map();
  durableEvents.forEach((event, index) => {
    const storedEvent = storedDurableEvents[index];
    if (event && storedEvent) {
      storedByOriginalEvent.set(event, storedEvent);
      if (trimString(event.id)) storedByEventId.set(trimString(event.id), storedEvent);
    }
  });
  const pushEvents = [];
  for (const event of coalesceHarnessLiveReasoningEvents(normalizedEvents)) {
    if (isHarnessEphemeralEvent(event)) {
      // Runtime progress is intentionally not persisted, but connected
      // clients still need immediate live state. Run invalidation/run-sheet
      // consumers can render these overlays without reloading history.
      pushEvents.push(event);
      continue;
    }
    const storedEvent = storedByOriginalEvent.get(event)
      || (trimString(event?.id) ? storedByEventId.get(trimString(event.id)) : null);
    if (storedEvent) pushEvents.push(storedEvent);
  }
  return pushEvents;
}

export function isDurableChatHistoryEvent(event) {
  if (isHarnessEphemeralEvent(event)) return false;
  return true;
}

function deriveRunStateFromResult(run, result) {
  if (!result || typeof result !== 'object') return null;
  if (result.cancelled === true) {
    return 'cancelled';
  }
  if ((result.exitCode ?? 1) === 0 && !result.error) {
    return 'completed';
  }
  if (run?.cancelRequested === true && (((result.exitCode ?? 1) !== 0) || result.signal)) {
    return 'cancelled';
  }
  return 'failed';
}

function hasPendingApprovedActionPause(run) {
  return Boolean(
    run?.approvedActionPending?.batchId
    && run?.actionPause?.kind === 'approved_action'
    && run?.actionPause?.state === 'waiting_user',
  );
}

function deriveRunFailureReasonFromResult(run, result) {
  if (!result || typeof result !== 'object') {
    return run?.failureReason || null;
  }
  if (typeof result.error === 'string' && result.error.trim()) {
    return result.error.trim();
  }
  if (typeof run?.failureReason === 'string' && run.failureReason.trim()) {
    return run.failureReason.trim();
  }
  if (result.cancelled === true) {
    return null;
  }
  if (typeof result.signal === 'string' && result.signal) {
    return `Process exited via signal ${result.signal}`;
  }
  if (Number.isInteger(result.exitCode)) {
    return `Process exited with code ${result.exitCode}`;
  }
  return run?.failureReason || null;
}

function redactFailureSecretFragments(text) {
  return String(text || '')
    .replace(/\bsk-[A-Za-z0-9_.*-]{12,}\b/g, (value) => (
      value.includes('*') ? value : `${value.slice(0, 8)}...redacted`
    ));
}

function clipFailurePreview(text, maxChars = 280) {
  if (typeof text !== 'string') return '';
  const normalized = redactFailureSecretFragments(text).replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function deriveStructuredRuntimeProviderErrorReason(events = [], previewText = '') {
  const providerErrorEvent = (Array.isArray(events) ? events : []).find((event) => (
    event?.type === 'status'
    && event.providerErrorRetryable !== true
    && (
      typeof event.providerErrorType === 'string'
      || /^error:/i.test(String(event.content || '').trim())
    )
  ));
  if (!providerErrorEvent) return null;

  const providerErrorType = typeof providerErrorEvent.providerErrorType === 'string'
    && providerErrorEvent.providerErrorType.trim()
    ? providerErrorEvent.providerErrorType.trim()
    : 'provider_error';
  const content = clipFailurePreview(providerErrorEvent.content || '');
  const providerMessage = clipFailurePreview(providerErrorEvent.providerErrorMessage || '', 500);
  const preview = clipFailurePreview(previewText, 500);
  const detailParts = [content, providerMessage, preview]
    .filter(Boolean)
    .filter((part, index, all) => all.findIndex((candidate) => candidate.includes(part) || part.includes(candidate)) === index);
  const detail = detailParts.join(' | ');
  return `Provider error (${providerErrorType}): ${detail || 'structured runtime reported an error'}`;
}

async function collectRunOutputPreview(runId, maxLines = 3) {
  const records = await readRunSpoolRecords(runId);
  if (!Array.isArray(records) || records.length === 0) return '';

  const lines = [];
  for (const record of records) {
    if (!record || !['stdout', 'stderr', 'error'].includes(record.stream)) continue;
    const line = clipFailurePreview(await materializeRunSpoolLine(runId, record));
    if (!line) continue;
    lines.push(line);
  }

  return lines.slice(-maxLines).join(' | ');
}

async function deriveStructuredRuntimeFailureReason(runId, previewText = '') {
  const preview = clipFailurePreview(previewText) || await collectRunOutputPreview(runId);
  if (preview && /(请登录|登录超时|auth|authentication|sso|sign in|login)/i.test(preview)) {
    return `Provider requires interactive login before Ragent can use it: ${preview}`;
  }
  if (preview) {
    return `Provider exited without emitting structured events: ${preview}`;
  }
  return 'Provider exited without emitting structured events';
}

// Provider-scoped model catalog gate for run admission. The returned catalog
// is also frozen into Claude's model contract so a later hidden title request
// cannot resolve against a different shared provider home.
async function validateRunModelAgainstCatalog({ tool, model, providerProfileId }) {
  try {
    const catalog = await getToolModelCatalog(tool, providerProfileId);
    if (!catalog) return { ok: true, skipped: 'no-catalog', catalog: null };
    return { ...validateRunModelSelection({ catalog, model, providerProfileId }), catalog };
  } catch (error) {
    // A legacy/non-native tool is still allowed through. Native Claude with a
    // selected provider receives an additional contract gate below.
    console.error(`[runs] model catalog validation failed: ${error?.message || String(error)}`);
    return { ok: true, skipped: 'catalog-error', catalog: null };
  }
}

function isClaudeRunSelection(tool, runtimeFamily) {
  const normalizedTool = trimString(tool);
  const normalizedRuntime = trimString(runtimeFamily);
  return normalizedTool === 'claude' || normalizedTool === 'claude-bidi'
    || normalizedRuntime.startsWith('claude-');
}

async function buildRunClaudeModelContract({
  tool,
  runtimeFamily,
  model,
  providerProfileId,
  catalog = null,
  priorContract = null,
}) {
  if (!isClaudeRunSelection(tool, runtimeFamily) || !trimString(providerProfileId)) {
    return { ok: true, contract: null };
  }
  const registry = createNativeProviderRegistry({ configDir: CONFIG_DIR });
  const profile = await registry.getProviderProfile(providerProfileId).catch(() => null);
  if (!profile || profile.agentType !== 'claude') {
    return {
      ok: false,
      code: 'claude-model-contract-invalid',
      message: `Claude provider profile ${providerProfileId} is unavailable.`,
    };
  }
  return resolveClaudeModelContract({
    contract: priorContract,
    providerProfileId: profile.id,
    providerRevision: profile.revision,
    requestedModel: model,
    modelPolicy: profile.modelPolicy,
    catalog,
  });
}

function generateId() {
  return randomBytes(16).toString('hex');
}

function buildForkSessionName(session) {
  const sourceName = typeof session?.name === 'string' ? session.name.trim() : '';
  return `fork - ${sourceName || 'session'}`;
}

function buildSessionNavigationHref(sessionId) {
  const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
  const path = !normalized
    ? '/?tab=sessions'
    : `/?session=${encodeURIComponent(normalized)}&tab=sessions`;
  return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}${path}` : path;
}

function buildDelegationNoticeMessage(task, childSession) {
  const normalizedTask = clipCompactionSection(task, 240)
    .replace(/\s+/g, ' ')
    .trim();
  const childName = typeof childSession?.name === 'string'
    ? childSession.name.trim()
    : 'new session';
  const childId = typeof childSession?.id === 'string' ? childSession.id.trim() : '';
  const targetUrl = childId ? buildSessionNavigationHref(childId) : '';
  const link = targetUrl ? `[${childName}](${targetUrl})` : childName;
  return [
    'Spawned a parallel session for this work.',
    '',
    normalizedTask ? `- Task: ${normalizedTask}` : '',
    `- Session: ${link}`,
    targetUrl ? `- Open: ${targetUrl}` : '',
    '',
    'This new session is independent and can continue on its own.',
  ].filter(Boolean).join('\n');
}

async function ensureDelegatedChildCompletionWake(parentSessionId, childSessionId) {
  const parentId = trimString(parentSessionId);
  const childId = trimString(childSessionId);
  if (!parentId || !childId) return false;
  try {
    const { createTrigger } = await import('./triggers.mjs');
    await createTrigger({
      sessionId: parentId,
      eventType: 'run_terminal',
      eventFilter: { sessionId: childId },
      dedupeKey: `delegated-child-terminal:${parentId}:${childId}`,
      text: `Delegated child session ${childId} finished. Review its result and continue the parent task.`,
      title: `Child session finished: ${childId}`,
    });
    return true;
  } catch (error) {
    console.error(`[delegate] failed to register child completion wake for ${childId}: ${error.message || String(error)}`);
    return false;
  }
}

function buildDelegationContextOperation(task, childSession) {
  const normalizedTask = clipCompactionSection(task, 240)
    .replace(/\s+/g, ' ')
    .trim();
  const delegationTaskFingerprint = buildDelegationTaskFingerprint(task);
  const childName = typeof childSession?.name === 'string'
    ? childSession.name.trim()
    : 'new session';
  const childId = typeof childSession?.id === 'string' ? childSession.id.trim() : '';

  return contextOperationEvent({
    operation: 'delegate_session',
    phase: 'applied',
    trigger: 'delegation',
    title: 'Parallel session spawned',
    summary: `Ragent handed off a focused subtask to ${childName}.`,
    reason: normalizedTask || `Child session ${childId || childName} is running independently.`,
    ...(delegationTaskFingerprint ? { delegationTaskFingerprint } : {}),
    ...(childId ? { targetSessionId: childId } : {}),
    ...(childName ? { targetSessionName: childName } : {}),
    ...(typeof childSession?.folder === 'string' && childSession.folder.trim() ? { targetSessionFolder: childSession.folder.trim() } : {}),
    ...(typeof childSession?.internalRole === 'string' && childSession.internalRole.trim() ? { targetSessionInternalRole: childSession.internalRole.trim() } : {}),
    ...(Number.isInteger(childSession?.delegationDepth) && childSession.delegationDepth > 0 ? { targetSessionDelegationDepth: childSession.delegationDepth } : {}),
  });
}

function normalizeDelegationTask(task, maxChars = 240) {
  return clipCompactionSection(task, maxChars)
    .replace(/\s+/g, ' ')
    .trim();
}

const DELEGATION_TASK_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by',
  'can', 'could', 'create', 'created', 'creating', 'current', 'do', 'does',
  'did', 'else', 'for', 'from', 'handle', 'handled', 'handling', 'if', 'in',
  'into', 'is', 'it', 'its', 'make', 'making', 'move', 'moving', 'must',
  'new', 'no', 'not', 'of', 'on', 'only', 'or', 'same', 'session', 'sessions',
  'should', 'sole', 'spawn', 'spawned', 'spawning', 'start', 'started',
  'starting', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'this', 'those', 'to', 'treat', 'treated', 'use', 'using', 'was', 'were',
  'will', 'with', 'without', 'workflow', 'workflows', 'would',
]);

const DELEGATION_TASK_DIFFERENTIATORS = new Set([
  'different',
  'distinct',
  'another',
]);

function buildDelegationTaskTokens(task) {
  const normalized = clipCompactionSection(task, 4000)
    .toLowerCase()
    .replace(/\b(?:parent|requesting|root|related|additional)\s+session\s+id:\s*[^\n]+/g, ' ')
    .replace(/\b[a-f0-9]{8,}\b/g, ' ');
  const rawTokens = normalized.match(/[\p{L}\p{N}_-]+/gu) || [];
  const uniqueTokens = [];
  const seen = new Set();
  for (const rawToken of rawTokens) {
    const token = rawToken.replace(/^[-_]+|[-_]+$/g, '');
    if (token.length < 3) continue;
    if (DELEGATION_TASK_STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    uniqueTokens.push(token);
  }
  return uniqueTokens;
}

function buildDelegationTaskFingerprint(task) {
  const tokens = buildDelegationTaskTokens(task);
  return tokens.length > 0 ? [...tokens].sort().join(' ') : '';
}

function delegationTasksLikelyMatch(leftTask, rightTask, explicitFingerprint = '') {
  const normalizedLeft = normalizeDelegationTask(leftTask);
  const normalizedRight = normalizeDelegationTask(rightTask);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;

  const leftRawTokens = new Set(buildDelegationTaskTokens(leftTask));
  const rightRawTokens = new Set(buildDelegationTaskTokens(rightTask));
  for (const differentiator of DELEGATION_TASK_DIFFERENTIATORS) {
    if (leftRawTokens.has(differentiator) !== rightRawTokens.has(differentiator)) {
      return false;
    }
  }

  const leftFingerprint = explicitFingerprint || buildDelegationTaskFingerprint(leftTask);
  const rightFingerprint = buildDelegationTaskFingerprint(rightTask);
  if (leftFingerprint && rightFingerprint && leftFingerprint === rightFingerprint) {
    return true;
  }

  const leftTokens = leftFingerprint ? leftFingerprint.split(' ').filter(Boolean) : buildDelegationTaskTokens(leftTask);
  const rightTokens = rightFingerprint ? rightFingerprint.split(' ').filter(Boolean) : buildDelegationTaskTokens(rightTask);
  if (leftTokens.length === 0 || rightTokens.length === 0) return false;

  const rightSet = new Set(rightTokens);
  const overlapCount = leftTokens.filter((token) => rightSet.has(token)).length;
  const smallerSide = Math.min(leftTokens.length, rightTokens.length);
  return overlapCount >= 4 && (overlapCount / smallerSide) >= 0.75;
}

async function findReusableDelegatedChild(sourceSessionId, task) {
  const normalizedTask = normalizeDelegationTask(task);
  const delegationTaskFingerprint = buildDelegationTaskFingerprint(task);
  if (!sourceSessionId || !normalizedTask) return null;

  let beforeSeq = 0;
  while (true) {
    const page = await readEventsPage(sourceSessionId, {
      direction: 'latest',
      beforeSeq,
      limit: 256,
      includeBodies: false,
      includeMessageBodies: false,
    });
    const events = Array.isArray(page?.events) ? page.events : [];
    // Delegation records are appended near the end of the source session. Walk
    // newest-first and stop after the first valid child, so repeated delegate
    // requests do not revisit every historical operation or resolve every
    // previously-created child session.
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const candidate = events[index];
      if (candidate?.type !== 'context_operation'
        || candidate.operation !== 'delegate_session'
        || candidate.phase !== 'applied') continue;
      const targetSessionId = typeof candidate.targetSessionId === 'string' ? candidate.targetSessionId.trim() : '';
      if (!targetSessionId || !delegationTasksLikelyMatch(
        candidate.reason || '',
        task,
        typeof candidate.delegationTaskFingerprint === 'string' ? candidate.delegationTaskFingerprint : delegationTaskFingerprint,
      )) continue;
      const child = await getSession(targetSessionId);
      if (child && child.delegatedFromSessionId === sourceSessionId) return child;
    }
    if (events.length === 0 || page?.pagination?.hasMoreBefore !== true) return null;
    const nextBeforeSeq = Number.isInteger(page?.pagination?.nextBeforeSeq)
      ? page.pagination.nextBeforeSeq
      : 0;
    if (nextBeforeSeq < 2 || nextBeforeSeq === beforeSeq) return null;
    beforeSeq = nextBeforeSeq;
  }
}

async function findLatestRunForSession(sessionId) {
  if (!sessionId) return null;
  // Prefer the durable index so a session lookup does not hydrate every Run
  // status/manifest in a large installation.  Legacy index entries without a
  // session id remain harmless because getRun() is still the authority.
  const indexedRuns = await listRunIndexEntries({ sessionId, reverse: true });
  for (const indexed of indexedRuns) {
    const run = await getRun(indexed.id);
    if (run?.sessionId === sessionId) {
      return run;
    }
  }
  return null;
}


function getFollowUpQueue(meta) {
  return Array.isArray(meta?.followUpQueue) ? meta.followUpQueue : [];
}

function getFollowUpQueueCount(meta) {
  return getFollowUpQueue(meta).length;
}

function getPendingPlanningQueue(meta) {
  return Array.isArray(meta?.pendingPlanningQueue) ? meta.pendingPlanningQueue : [];
}

function getPendingPlanningQueueCount(meta) {
  return getPendingPlanningQueue(meta).length;
}


function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// A run-scoped history reader for completion/reply side effects.  These
// paths used to call loadHistory(..., { includeBodies: true }) and therefore
// reconstructed the entire session transcript every time a run finished or a
// connector polled for its reply.  Scan uncached event metadata, retain only a
// bounded tail for the selected run, and hydrate message bodies one at a time.
// The durable event files remain the source of truth; this is only a bounded
// read projection for side effects that need the latest turn text.
const MAX_SCOPED_HISTORY_EVENTS = 4096;
const MAX_SCOPED_BODY_BYTES = 256 * 1024;
// Completion/reply side effects often hydrate a bounded tail of events in
// parallel.  A per-event cap alone still permits a large aggregate allocation
// (4096 * 256 KiB) when a run has many message events, so reserve one shared
// budget before starting each body read.
const MAX_SCOPED_TOTAL_BODY_BYTES = 4 * 1024 * 1024;
const SCOPED_HISTORY_BODY_CONCURRENCY = 8;

function clipScopedBody(value, maxBytes = MAX_SCOPED_BODY_BYTES) {
  const text = typeof value === 'string' ? value : '';
  if (!text || Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const headChars = Math.max(1, Math.floor(maxBytes * 0.6));
  const tailChars = Math.max(1, maxBytes - headChars);
  return `${text.slice(0, headChars).trimEnd()}\n[... truncated by Ragent ...]\n${text.slice(-tailChars).trimStart()}`;
}

async function hydrateScopedHistoryBodies(sessionId, events = [], {
  includeAssistantControlBlocks = false,
  maxTotalBodyBytes = MAX_SCOPED_TOTAL_BODY_BYTES,
} = {}) {
  const source = Array.isArray(events) ? events : [];
  const hydrated = new Array(source.length);
  let remainingBodyBytes = Number.isFinite(maxTotalBodyBytes) && maxTotalBodyBytes > 0
    ? maxTotalBodyBytes
    : MAX_SCOPED_TOTAL_BODY_BYTES;
  // Hydrate newest messages first so a bounded budget never leaves the latest
  // assistant reply (the value completion/reply side effects consume) lazy
  // merely because older messages appeared earlier in the returned array.
  const hydrationOrder = source
    .map((event, index) => ({ event, index }))
    .sort((left, right) => (right.event?.seq || 0) - (left.event?.seq || 0));
  let cursor = 0;
  const workerCount = Math.min(SCOPED_HISTORY_BODY_CONCURRENCY, source.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const orderIndex = cursor;
      cursor += 1;
      if (orderIndex >= hydrationOrder.length) return;
      const index = hydrationOrder[orderIndex].index;
      const event = source[index];
      if (!event || event.bodyLoaded !== false || !event.bodyAvailable || !event.bodyField) {
        hydrated[index] = event;
        continue;
      }
      // Side-effect consumers only need message text.  Tool/reasoning bodies
      // are intentionally left at their bounded preview to avoid reintroducing
      // the large-body allocation this reader is designed to prevent.
      if (event.type !== 'message') {
        hydrated[index] = event;
        continue;
      }
      // Reserve the shared budget synchronously before awaiting I/O.  Workers
      // therefore cannot race past the aggregate cap, even when all reads
      // complete at different times.
      if (remainingBodyBytes <= 0) {
        hydrated[index] = event;
        continue;
      }
      const bodyBudget = Math.min(MAX_SCOPED_BODY_BYTES, remainingBodyBytes);
      remainingBodyBytes -= bodyBudget;
      const body = await readEventBody(sessionId, event.seq, {
        includeAssistantControlBlocks,
        maxBytes: bodyBudget,
      }).catch(() => null);
      if (!body || typeof body.value !== 'string') {
        hydrated[index] = event;
        continue;
      }
      hydrated[index] = {
        ...event,
        [body.field]: clipScopedBody(body.value),
        bodyLoaded: true,
        ...(body.truncated ? { bodyTruncated: true } : {}),
      };
    }
  }));
  return hydrated;
}

async function loadRunScopedHistory(sessionId, runId, {
  includeBodies = false,
  includeAssistantControlBlocks = false,
  responseIds = [],
  maxEvents = MAX_SCOPED_HISTORY_EVENTS,
} = {}) {
  const normalizedRunId = trimString(runId);
  const responseIdSet = new Set((Array.isArray(responseIds) ? responseIds : [])
    .map(trimString)
    .filter(Boolean));
  const cap = Number.isInteger(maxEvents) && maxEvents > 0
    ? maxEvents
    : MAX_SCOPED_HISTORY_EVENTS;
  const selected = [];
  let latestUserMessage = null;
  const responseIdsFound = new Set();
  let beforeSeq = 0;
  // Run completion/publication paths usually target the newest Run. Read
  // newest-first so a large session does not replay every historical event
  // just to retain the final bounded window. The stop condition preserves the
  // old semantics: keep the newest `cap` matching events, the latest user
  // message, and continue until every requested response id has been seen.
  while (true) {
    const page = await readEventsPage(sessionId, {
      direction: 'latest',
      beforeSeq,
      limit: 256,
      includeBodies: false,
      includeMessageBodies: false,
    }).catch(() => null);
    const events = Array.isArray(page?.events) ? page.events : [];
    if (events.length === 0) break;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event) continue;
      const sameRun = !!normalizedRunId && trimString(event.runId) === normalizedRunId;
      const responseId = trimString(event.responseId);
      const sameResponse = responseIdSet.size > 0 && responseIdSet.has(responseId);
      if (!sameRun && !sameResponse) continue;
      if (sameResponse) responseIdsFound.add(responseId);
      // Reverse traversal encounters the latest user message first. Keep it
      // even when it lies just outside the bounded matching-event window.
      if (!latestUserMessage && sameRun && event.type === 'message' && event.role === 'user') {
        latestUserMessage = event;
      }
      selected.push(event);
      if (selected.length > cap) selected.pop();
    }
    const responseComplete = responseIdsFound.size >= responseIdSet.size;
    if (selected.length >= cap && latestUserMessage && responseComplete) break;
    if (page?.pagination?.hasMoreBefore !== true) break;
    const nextBeforeSeq = Number.isInteger(page?.pagination?.nextBeforeSeq)
      ? page.pagination.nextBeforeSeq
      : 0;
    if (nextBeforeSeq < 2 || nextBeforeSeq === beforeSeq) break;
    beforeSeq = nextBeforeSeq;
  }
  if (latestUserMessage && !selected.includes(latestUserMessage)) {
    selected.unshift(latestUserMessage);
  }
  selected.sort((left, right) => (left?.seq || 0) - (right?.seq || 0));
  return includeBodies
    ? hydrateScopedHistoryBodies(sessionId, selected, { includeAssistantControlBlocks })
    : selected;
}

async function loadRecentDelegationResultEvents(sessionId, expectedCount = 0) {
  const normalizedExpected = Number.isInteger(expectedCount) && expectedCount > 0
    ? expectedCount
    : 4096;
  const cap = Math.min(4096, normalizedExpected);
  const results = [];
  let beforeSeq = 0;
  // Delegation results are append-only. Walk newest-first and stop once the
  // durable child count is covered; a parent with a very large transcript no
  // longer needs a full forward scan merely to rebuild its sidebar summary.
  while (true) {
    const page = await readEventsPage(sessionId, {
      direction: 'latest',
      beforeSeq,
      limit: 256,
      includeBodies: false,
      includeMessageBodies: false,
    }).catch(() => null);
    const events = Array.isArray(page?.events) ? page.events : [];
    if (events.length === 0) break;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== 'context_operation' || event.operation !== 'delegation_result') continue;
      results.push(event);
      if (results.length >= cap) break;
    }
    if (results.length >= cap || page?.pagination?.hasMoreBefore !== true) break;
    const nextBeforeSeq = Number.isInteger(page?.pagination?.nextBeforeSeq)
      ? page.pagination.nextBeforeSeq
      : 0;
    if (nextBeforeSeq < 2 || nextBeforeSeq === beforeSeq) break;
    beforeSeq = nextBeforeSeq;
  }
  return results.sort((left, right) => (left?.seq || 0) - (right?.seq || 0));
}

async function scanStoredEvents(sessionId, visitor, { includeMessageBodies = false } = {}) {
  return forEachStoredEvent(sessionId, async (event) => {
    let next = event;
    if (includeMessageBodies && event?.type === 'message'
      && event.bodyAvailable && event.bodyLoaded === false) {
      const body = await readEventBody(sessionId, event.seq, {
        includeAssistantControlBlocks: true,
      }).catch(() => null);
      if (body && typeof body.value === 'string') {
        next = { ...event, [body.field]: body.value, bodyLoaded: true };
      }
    }
    return visitor(next);
  });
}

async function findLatestStoredEvent(sessionId, predicate) {
  if (typeof predicate !== 'function') return null;
  let beforeSeq = 0;
  while (true) {
    const page = await readEventsPage(sessionId, {
      direction: 'latest',
      beforeSeq,
      limit: 256,
      includeBodies: false,
      includeMessageBodies: false,
    });
    const events = Array.isArray(page?.events) ? page.events : [];
    // readEventsPage returns each backward page in chronological order. Walk
    // it in reverse so the first match is the same latest event the former
    // full forward scan would have returned.
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (predicate(events[index])) return events[index];
    }
    if (events.length === 0 || page?.pagination?.hasMoreBefore !== true) return null;
    const nextBeforeSeq = Number.isInteger(page?.pagination?.nextBeforeSeq)
      ? page.pagination.nextBeforeSeq
      : 0;
    if (nextBeforeSeq < 2 || nextBeforeSeq === beforeSeq) return null;
    beforeSeq = nextBeforeSeq;
  }
}

async function loadRecentTurnHistory(sessionId, {
  includeBodies = false,
  includeAssistantControlBlocks = false,
} = {}) {
  const pages = [];
  let beforeSeq = 0;
  for (let index = 0; index < 8; index += 1) {
    const page = await readEventsPage(sessionId, {
      direction: 'latest',
      beforeSeq,
      limit: 256,
      includeBodies: false,
      includeMessageBodies: false,
    });
    const events = Array.isArray(page?.events) ? page.events : [];
    if (events.length === 0) break;
    pages.unshift(...events);
    if (events.some((event) => event?.type === 'message' && event?.role === 'user')) break;
    const nextBeforeSeq = Number.isInteger(page?.pagination?.nextBeforeSeq)
      ? page.pagination.nextBeforeSeq
      : 0;
    if (nextBeforeSeq < 2 || nextBeforeSeq === beforeSeq) break;
    beforeSeq = nextBeforeSeq;
  }
  return includeBodies
    ? hydrateScopedHistoryBodies(sessionId, pages, { includeAssistantControlBlocks })
    : pages;
}

async function reduceContinuityHistory(sessionId, {
  fromSeq = 0,
  toSeq = 0,
  initialState = null,
  executionInput = {},
  executionProjection = null,
  bindings = [],
} = {}) {
  let firstUserMessage = null;
  let latestAssistantMessage = null;
  await forEachStoredEvent(sessionId, async (event) => {
    if (event?.type === 'message' && event.role === 'user' && !firstUserMessage) {
      firstUserMessage = event;
    }
    if (event?.type === 'message' && event.role === 'assistant') {
      latestAssistantMessage = event;
    }
    return true;
  }, {
    ...(Number.isInteger(fromSeq) && fromSeq > 0 ? { fromSeq } : {}),
    ...(Number.isInteger(toSeq) && toSeq > 0 ? { toSeq } : {}),
  });

  // Continuity reduction needs every sequence to prove coverage, but only the
  // first user goal and latest assistant next-action need message bodies. Do a
  // metadata pass followed by a streaming reducer pass so a 100K-event
  // session never creates `events` and `hydrated` arrays in memory.
  const targetSeqs = new Set(
    [firstUserMessage?.seq, latestAssistantMessage?.seq]
      .filter((seq) => Number.isInteger(seq) && seq > 0),
  );
  const reducer = createContinuityReducer(sessionId, {
    executionInput,
    ...(executionProjection ? { executionProjection } : {}),
    bindings,
  }, initialState);
  await forEachStoredEvent(sessionId, async (event) => {
    let next = event;
    if (targetSeqs.has(event?.seq) && event.bodyLoaded === false && event.bodyAvailable && event.bodyField) {
      const body = await readEventBody(sessionId, event.seq, {
        includeAssistantControlBlocks: true,
      }).catch(() => null);
      if (body?.field === 'content' && typeof body.value === 'string') {
        next = { ...event, content: clipScopedBody(body.value), bodyLoaded: true };
      }
    }
    reducer.push(next);
    return true;
  }, {
    ...(Number.isInteger(fromSeq) && fromSeq > 0 ? { fromSeq } : {}),
    ...(Number.isInteger(toSeq) && toSeq > 0 ? { toSeq } : {}),
  });
  return reducer.finish();
}

// sessionPlane is an orthogonal dimension (user | organization | system) per
// the Organization constitution §3.2. Undefined/empty defaults to 'user';
// anything else that is not one of the three legal planes is rejected.
function normalizeSessionPlane(value) {
  if (value === undefined || value === null) return 'user';
  if (typeof value !== 'string') {
    throw Object.assign(new Error('sessionPlane must be "user", "organization" or "system"'), { code: 'INVALID_SESSION_PLANE' });
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) return 'user';
  if (['user', 'organization', 'system'].includes(normalized)) return normalized;
  throw Object.assign(new Error('sessionPlane must be "user", "organization" or "system"'), { code: 'INVALID_SESSION_PLANE' });
}

function normalizeSessionContractForCreate(extra, sessionPlane) {
  const hasClass = Object.prototype.hasOwnProperty.call(extra, 'sessionClass');
  const requestedClass = hasClass ? normalizeSessionClass(extra.sessionClass) : '';
  if (hasClass && !requestedClass) {
    const error = new Error('sessionClass is invalid');
    error.code = 'SESSION_CLASS_INVALID';
    error.statusCode = 400;
    throw error;
  }
  if (requestedClass === 'ROOT_LEADERSHIP' && sessionPlane !== 'user') {
    const error = new Error('ROOT_LEADERSHIP sessions must use the user session plane');
    error.code = 'SESSION_CLASS_INVALID';
    error.statusCode = 400;
    throw error;
  }
  if (isManagedSessionClass(requestedClass) && sessionPlane !== 'organization') {
    const error = new Error('Managed sessions must use the organization session plane');
    error.code = 'SESSION_CLASS_INVALID';
    error.statusCode = 400;
    throw error;
  }
  return {
    hasClass,
    sessionClass: requestedClass,
    userAddressable: requestedClass === 'ROOT_LEADERSHIP'
      ? extra.userAddressable !== false
      : (isManagedSessionClass(requestedClass) ? false : undefined),
    // C1: Managed sessions carry a two-state managedScope ('organization' |
    // 'consultation'); invalid/missing values fall back to 'organization' so
    // legacy managed sessions keep the Organization lineage contract.
    managedScope: isManagedSessionClass(requestedClass)
      ? normalizeManagedScope(extra.managedScope)
      : undefined,
  };
}

function applySessionContractFields(session, extra, contract) {
  if (contract.sessionClass) session.sessionClass = contract.sessionClass;
  if (contract.userAddressable !== undefined) session.userAddressable = contract.userAddressable;

  const textFields = {
    organizationRootSessionId: extra.organizationRootSessionId || extra.rootSessionId,
    organizationId: extra.organizationId,
    organizationNodeId: extra.organizationNodeId || extra.nodeId,
    roleInstanceId: extra.roleInstanceId || extra.role,
    controllerSessionId: extra.controllerSessionId,
    parentSessionId: extra.parentSessionId,
    // C1/P4-T1a: persist the managed-scope spectrum plus the consultation
    // lineage fields so a consultation managed session survives a reload.
    managedScope: normalizeManagedScope(extra.managedScope),
    consultationRoundId: extra.consultationRoundId,
    expertAssignmentId: extra.expertAssignmentId,
  };
  for (const [field, value] of Object.entries(textFields)) {
    if (typeof value === 'string' && value.trim()) session[field] = value.trim();
  }
  const revision = extra.organizationRevision ?? extra.revision;
  const revisionNumber = typeof revision === 'string' && revision.trim() ? Number(revision) : revision;
  if (Number.isInteger(revisionNumber) && revisionNumber > 0) {
    session.organizationRevision = revisionNumber;
  }
  if (Number.isInteger(extra.depth) && extra.depth >= 0) session.depth = extra.depth;
  if (extra.inputPolicy && typeof extra.inputPolicy === 'object' && !Array.isArray(extra.inputPolicy)) {
    session.inputPolicy = extra.inputPolicy;
  }
  if (session.organizationRootSessionId && !session.rootSessionId) {
    session.rootSessionId = session.organizationRootSessionId;
  }
  return session;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveResponseId(requestId, options = {}) {
  const explicit = trimString(options.responseId);
  if (explicit) return explicit;
  return trimString(requestId);
}

function buildInitialReplyPublication(run, responseIds = []) {
  const normalizedResponseIds = normalizeReplyPublicationResponseIds(
    responseIds,
    trimString(run?.responseId || run?.requestId),
  );
  return {
    responseIds: normalizedResponseIds,
    state: 'running',
    resolution: '',
    rootRunId: trimString(run?.id),
    finalRunId: trimString(run?.id),
    continuationRunIds: [],
    updatedAt: nowIso(),
    readyAt: null,
    failedAt: null,
    lastError: null,
  };
}

function buildReplyPublicationSummary(input = {}) {
  const responseIds = normalizeReplyPublicationResponseIds(
    input.responseIds,
    trimString(input.id || input.responseId),
  );
  const state = trimString(input.state) || 'running';
  return {
    id: trimString(input.id || responseIds[0] || ''),
    responseIds,
    state,
    ready: state.toLowerCase() === 'ready',
    resolution: trimString(input.resolution),
    rootRunId: trimString(input.rootRunId),
    finalRunId: trimString(input.finalRunId),
    continuationRunIds: normalizeReplyPublicationResponseIds(input.continuationRunIds || []),
    updatedAt: trimString(input.updatedAt),
    readyAt: trimString(input.readyAt),
    failedAt: trimString(input.failedAt),
    lastError: trimString(input.lastError),
    payload: input.payload && typeof input.payload === 'object'
      ? input.payload
      : null,
  };
}

async function updateRunReplyPublication(runId, updater) {
  if (!trimString(runId) || typeof updater !== 'function') return null;
  return updateRun(runId, (current) => {
    const existing = current?.replyPublication && typeof current.replyPublication === 'object'
      ? current.replyPublication
      : buildInitialReplyPublication(current, getRunResponseIds(current));
    const next = updater(existing, current);
    if (!next || typeof next !== 'object') {
      return current;
    }
    const normalizedResponseIds = normalizeReplyPublicationResponseIds(
      next.responseIds,
      trimString(current?.responseId || current?.requestId),
    );
    return {
      ...current,
      replyPublication: {
        ...existing,
        ...next,
        responseIds: normalizedResponseIds,
        updatedAt: trimString(next.updatedAt) || nowIso(),
      },
    };
  });
}

function deriveReplyPublicationStateFromRun(run = {}) {
  const state = trimString(run?.state).toLowerCase();
  if (state === 'failed') return 'failed';
  if (state === 'cancelled') return 'cancelled';
  if (state === 'completed') return 'ready';
  return 'running';
}

export { resolveAttachmentMimeType } from './session-attachments.mjs';

function sanitizeQueuedFollowUpAttachments(images) {
  return (images || [])
    .map((image) => {
      const filename = typeof image?.filename === 'string' ? image.filename.trim() : '';
      const savedPath = typeof image?.savedPath === 'string' ? image.savedPath.trim() : '';
      const assetId = typeof image?.assetId === 'string' ? image.assetId.trim() : '';
      const originalName = sanitizeOriginalAttachmentName(image?.originalName || '');
      const mimeType = resolveAttachmentMimeType(image?.mimeType, originalName || filename);
      const sizeBytes = normalizeAttachmentSizeBytes(image?.sizeBytes);
      const renderAs = trimString(image?.renderAs) === 'file' ? 'file' : '';
      if (!savedPath && !assetId) return null;
      return {
        ...(filename ? { filename } : {}),
        ...(savedPath ? { savedPath } : {}),
        ...(assetId ? { assetId } : {}),
        ...(originalName ? { originalName } : {}),
        mimeType,
        ...(sizeBytes ? { sizeBytes } : {}),
        ...(renderAs ? { renderAs } : {}),
      };
    })
    .filter(Boolean);
}

function toAssetBoundAttachmentRefs(images) {
  const normalized = sanitizeQueuedFollowUpAttachments(images);
  const unbound = normalized.find((attachment) => !trimString(attachment?.assetId));
  if (unbound) {
    const error = new Error('Attachment must be resolved to a server file asset before a Run starts');
    error.code = 'FILE_ASSET_INPUT_RESOURCE_UNKNOWN';
    error.statusCode = 409;
    throw error;
  }
  return normalized.map((attachment) => ({
    assetId: trimString(attachment.assetId),
    ...(trimString(attachment.originalName) ? { originalName: attachment.originalName } : {}),
    mimeType: attachment.mimeType,
    ...(Number.isInteger(attachment.sizeBytes) ? { sizeBytes: attachment.sizeBytes } : {}),
    ...(trimString(attachment.renderAs) === 'file' ? { renderAs: 'file' } : {}),
  }));
}

function getManifestAttachmentSourceRefs(manifest = {}) {
  const candidates = Array.isArray(manifest?.attachmentRefs)
    ? manifest.attachmentRefs
    : (Array.isArray(manifest?.options?.attachmentRefs)
      ? manifest.options.attachmentRefs
      : manifest?.options?.images);
  return toAssetBoundAttachmentRefs(candidates);
}

async function stageRunAttachmentInputs({ sessionId, runId, turnId, attachments = [] } = {}) {
  const sourceRefs = toAssetBoundAttachmentRefs(attachments);
  const staged = await stageAttachmentInputs({
    sessionId,
    runId,
    turnId,
    attachments: sourceRefs,
  });
  return {
    sourceRefs,
    stagedAttachments: staged.attachments,
    staging: staged.staging,
  };
}

function sanitizeQueuedFollowUpOptions(options = {}) {
  const next = {};
  if (typeof options.tool === 'string' && options.tool.trim()) next.tool = options.tool.trim();
  if (typeof options.providerProfile === 'string' && options.providerProfile.trim()) {
    next.providerProfile = options.providerProfile.trim().slice(0, 256);
  }
  if (typeof options.harnessInstructions === 'string' && options.harnessInstructions.trim()) {
    next.harnessInstructions = options.harnessInstructions.trim().slice(0, 48_000);
  }
  if (typeof options.model === 'string' && options.model.trim()) next.model = options.model.trim();
  if (typeof options.effort === 'string' && options.effort.trim()) next.effort = options.effort.trim();
  if (typeof options.serviceTier === 'string' && options.serviceTier.trim()) {
    next.serviceTier = normalizeCodexServiceTier(options.serviceTier);
  }
  if (typeof options.interactionMode === 'string' && ['agent', 'plan'].includes(options.interactionMode.trim().toLowerCase())) {
    next.interactionMode = options.interactionMode.trim().toLowerCase();
  }
  if (typeof options.permissionMode === 'string' && options.permissionMode.trim()) {
    next.permissionMode = options.permissionMode.trim();
  }
  if (typeof options.templateId === 'string' && options.templateId.trim()) {
    next.templateId = options.templateId.trim();
  }
  const planAction = normalizePlanAction(options.planAction);
  if (planAction) next.planAction = planAction;
  const planId = normalizePlanId(options.planId);
  if (planId) next.planId = planId;
  if (options.thinking === true) next.thinking = true;
  const sourceContext = normalizeSourceContext(options.sourceContext);
  if (sourceContext) next.sourceContext = sourceContext;
  if (options.freshThread === true) next.freshThread = true;
  if (options.skipSessionContinuation === true) next.skipSessionContinuation = true;
  if (options.transientProviderContext === true) next.transientProviderContext = true;
  if (options.browserMcpEnabled === true) next.browserMcpEnabled = true;
  // This value is computed at an authenticated HTTP ingress. Preserve it when
  // a busy or planning queue defers the same turn; never derive it from the
  // queued message payload itself.
  if (typeof options.authenticatedPrincipalKind === 'string' && options.authenticatedPrincipalKind.trim()) {
    next.authenticatedPrincipalKind = options.authenticatedPrincipalKind.trim();
  }
  if (next.authenticatedPrincipalKind === 'trusted_device' && options.authenticatedOwnerDevice) {
    next.authenticatedOwnerDevice = structuredClone(options.authenticatedOwnerDevice);
  }
  if (options.temporaryControlAuthority) next.temporaryControlAuthority = structuredClone(options.temporaryControlAuthority);
  if (options.internalOperation === 'approved_action_resume') {
    next.internalOperation = 'approved_action_resume';
  }
  if (options.recordUserMessage === false) next.recordUserMessage = false;
  return next;
}

function normalizePlanAction(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ['revise', 'execute'].includes(normalized) ? normalized : '';
}

function normalizePlanId(value) {
  const normalized = trimString(value);
  return normalized ? normalized.slice(0, 160) : '';
}

function resolvePlanActionInteractionMode(planAction) {
  if (planAction === 'revise') return 'plan';
  if (planAction === 'execute') return 'agent';
  return '';
}

function normalizePlanArtifactStatus(value) {
  const normalized = trimString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (['drafting', 'running', 'in_progress', 'started'].includes(normalized)) return 'drafting';
  if (['awaiting_decision', 'ready'].includes(normalized)) return 'awaiting_decision';
  if (['completed', 'complete', 'done'].includes(normalized)) return 'completed';
  if (normalized === 'revising') return 'revising';
  if (normalized === 'approved') return 'approved';
  if (normalized === 'executing') return 'executing';
  if (normalized === 'superseded') return 'superseded';
  if (normalized === 'failed') return 'failed';
  return 'drafting';
}

function normalizePlanArtifactItemStatus(value) {
  const normalized = trimString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (['completed', 'complete', 'done', 'success', 'succeeded'].includes(normalized)) return 'completed';
  if (['in_progress', 'active', 'current', 'running', 'started'].includes(normalized)) return 'in_progress';
  return 'pending';
}

function normalizePlanArtifactItems(event) {
  const sourceItems = Array.isArray(event?.items)
    ? event.items
    : (Array.isArray(event?.plan) ? event.plan : []);
  return sourceItems
    .map((item) => (item && typeof item === 'object' ? item : { text: item }))
    .map((item) => ({
      text: trimString(item.text || item.step || item.title),
      status: normalizePlanArtifactItemStatus(item.status || item.state || (item.completed === true ? 'completed' : 'pending')),
    }))
    .filter((item) => item.text);
}

function getPlanArtifactTitle(event) {
  return trimString(event?.title) || 'Codex plan';
}

function formatPlanArtifactItemsMarkdown(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => `${item.status === 'completed' ? '[x]' : '[ ]'} ${item.text}`)
    .join('\n');
}

function formatPlanArtifactMarkdown(artifact = {}) {
  const bodyMarkdown = trimString(artifact.bodyMarkdown);
  if (bodyMarkdown) return bodyMarkdown;
  const title = trimString(artifact.title) || 'Codex plan';
  const itemsMarkdown = formatPlanArtifactItemsMarkdown(artifact.items);
  return [title, '', itemsMarkdown].join('\n').trim();
}

function getPlanFallbackTitle(markdown) {
  const match = trimString(markdown).match(/^\s{0,3}#\s+(.+)$/m);
  return match ? trimString(match[1].replace(/[#*_`]+/g, '')) : '';
}

function extractPlanFallbackMarkdown(markdown) {
  const source = trimString(markdown);
  if (!source) return '';
  const taggedPlan = source.match(/<proposed_plan\b[^>]*>([\s\S]*?)<\/proposed_plan>/i);
  return taggedPlan ? trimString(taggedPlan[1]) : source;
}

function countPlanFallbackStepLines(markdown) {
  return trimString(markdown)
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*+]\s+|\d+[.)、]\s+|\[[ xX]\]\s+)/.test(line))
    .length;
}

function looksLikePlanFallbackMarkdown(markdown) {
  const source = trimString(markdown);
  if (!source) return false;
  if (/<proposed_plan\b/i.test(source)) return true;
  const stepCount = countPlanFallbackStepLines(source);
  if (stepCount >= 2) return true;
  return stepCount >= 1 && /\bplan\b|方案|计划|步骤|执行路径|implementation/i.test(source);
}

function normalizePlanArtifactEvent(event, fallbackRevision = 1) {
  const seq = Number.isInteger(event?.seq) ? event.seq : 0;
  const planId = normalizePlanId(event?.planId || event?.artifactId || event?.id || (seq > 0 ? `plan-${seq}` : ''));
  if (!planId) return null;
  const items = normalizePlanArtifactItems(event);
  const revision = Number.isInteger(event?.revision) && event.revision > 0
    ? event.revision
    : fallbackRevision;
  return {
    planId,
    artifactId: planId,
    title: getPlanArtifactTitle(event),
    bodyMarkdown: trimString(event?.bodyMarkdown || event?.text || event?.content),
    items,
    status: normalizePlanArtifactStatus(event?.status || event?.state),
    state: normalizePlanArtifactStatus(event?.status || event?.state),
    revision,
    source: trimString(event?.source),
    providerThreadId: trimString(event?.providerThreadId),
    providerTurnId: trimString(event?.providerTurnId),
    previousPlanId: trimString(event?.previousPlanId),
    lastPlanAction: trimString(event?.lastPlanAction),
    sourceRunId: trimString(event?.runId),
    requestId: trimString(event?.requestId),
    responseId: trimString(event?.responseId),
    seq,
    timestamp: Number.isFinite(event?.timestamp) ? event.timestamp : null,
  };
}

async function findLatestPlanArtifact(sessionId, planId) {
  const normalizedPlanId = normalizePlanId(planId);
  if (!normalizedPlanId) return null;
  // Plan actions are control-plane requests and must remain cheap even when
  // the session that owns the plan has a very long provider transcript. The
  // append-maintained plan index returns only the revisions for this artifact;
  // event files remain the source of truth if the index needs rebuilding.
  const history = await readPlanEvents(sessionId, normalizedPlanId).catch(() => []);
  let latest = null;
  let revision = 0;
  for (const event of history) {
    if (event?.type !== 'plan') continue;
    const eventPlanId = normalizePlanId(event.planId || event.artifactId || event.id);
    if (eventPlanId !== normalizedPlanId) continue;
    revision += 1;
    const artifact = normalizePlanArtifactEvent(event, revision);
    if (!artifact) continue;
    if (!latest || artifact.seq >= latest.seq) {
      latest = artifact;
    }
  }
  return latest;
}

function buildPlanActionPrompt({ action, artifact, userText = '' } = {}) {
  const normalizedAction = normalizePlanAction(action);
  const normalizedUserText = trimString(userText);
  const planMarkdown = formatPlanArtifactMarkdown(artifact);
  const title = trimString(artifact?.title) || 'Ragent plan';
  const planId = normalizePlanId(artifact?.planId);
  const instructions = normalizedAction === 'execute'
    ? [
        'The user approved this Ragent plan artifact.',
        'Execute the approved plan now. Do not ask for another approval unless a real blocker appears.',
      ]
    : [
        'The user wants this Ragent plan artifact revised.',
        'Stay in planning mode. Return an updated plan for approval and do not implement it yet.',
      ];
  return [
    '<private>',
    `Ragent plan action: ${normalizedAction || 'unknown'}`,
    planId ? `Plan artifact id: ${planId}` : '',
    title ? `Plan title: ${title}` : '',
    ...instructions,
    '</private>',
    '',
    normalizedUserText ? `User note:\n${normalizedUserText}` : '',
    '',
    'Current plan artifact:',
    planMarkdown,
  ].filter((part) => part !== '').join('\n');
}

async function appendPlanArtifactStateEvent(sessionId, artifact, {
  state,
  run = null,
  requestId = '',
  responseId = '',
  lastPlanAction = '',
} = {}) {
  if (!artifact?.planId || !state) return null;
  const event = planEvent({
    planId: artifact.planId,
    title: artifact.title,
    bodyMarkdown: artifact.bodyMarkdown,
    items: artifact.items,
    state,
    source: 'agentoc-plan-action',
    revision: artifact.revision,
    providerThreadId: artifact.providerThreadId,
    providerTurnId: artifact.providerTurnId,
    previousPlanId: artifact.previousPlanId,
    lastPlanAction,
    planIntent: 'proposal',
  });
  const stored = await appendEvent(sessionId, {
    ...event,
    ...(run?.id ? { runId: run.id } : {}),
    ...(requestId ? { requestId } : {}),
    ...(responseId ? { responseId } : {}),
  });
  broadcastSessionInvalidation(sessionId);
  return stored;
}

function shouldCreatePlanFallbackArtifact(run, manifest, history = []) {
  if (run?.state !== 'completed') return false;
  if (manifest?.internalOperation) return false;
  const interactionMode = trimString(manifest?.options?.interactionMode).toLowerCase();
  const planAction = normalizePlanAction(manifest?.options?.planAction);
  if (planAction === 'execute') return false;
  if (interactionMode !== 'plan' && planAction !== 'revise') return false;
  const runId = trimString(run?.id);
  if (!runId) return false;
  // Strict gate: if the run already surfaced an ExitPlanMode approval request
  // (Claude asks mid-run in plan mode), the plan was presented to the user —
  // no end-of-run fallback card is needed.
  if (history.some((event) =>
    event?.type === 'approval_request'
    && trimString(event.runId) === runId
    && String(event?.kind || '').trim().toLowerCase() === 'plan')) {
    return false;
  }
  return !history.some((event) =>
    event?.type === 'plan'
    && trimString(event.runId) === runId
    && trimString(event.source) !== 'agentoc-plan-action'
    && trimString(event.bodyMarkdown || event.bodyPreview));
}

function findPlanFallbackSourceMessage(run, history = []) {
  const runId = trimString(run?.id);
  if (!runId) return null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index];
    if (event?.type !== 'message' || event.role !== 'assistant') continue;
    if (trimString(event.runId) !== runId) continue;
    if (!trimString(event.content || event.bodyPreview)) continue;
    return event;
  }
  return null;
}

async function maybeAppendPlanFallbackArtifact(sessionId, run, manifest) {
  const history = await loadRunScopedHistory(sessionId, run?.id, { includeBodies: true });
  if (!shouldCreatePlanFallbackArtifact(run, manifest, history)) return null;
  const sourceMessage = findPlanFallbackSourceMessage(run, history);
  const sourceMarkdown = trimString(sourceMessage?.content || sourceMessage?.bodyPreview);
  if (!sourceMessage) return null;
  // Strict gate: only wrap the reply in a plan card when it actually looks
  // like a plan (step list / <proposed_plan> tag). Providers without native
  // plan artifacts (e.g. Claude) finish plan mode with a plain-text plan —
  // that is exactly the case worth carding; execution output is not.
  if (!looksLikePlanFallbackMarkdown(sourceMarkdown)) return null;
  const bodyMarkdown = extractPlanFallbackMarkdown(sourceMarkdown);
  if (!bodyMarkdown) return null;
  const previousPlanId = normalizePlanAction(manifest?.options?.planAction) === 'revise'
    ? normalizePlanId(manifest?.options?.planId)
    : '';
  const event = planEvent({
    planId: normalizePlanId(`plan-${run.id}`),
    title: getPlanFallbackTitle(bodyMarkdown) || undefined,
    bodyMarkdown,
    state: 'awaiting_decision',
    source: 'agentoc-plan-fallback',
    interactionMode: 'plan',
    planIntent: 'proposal',
    previousPlanId,
    ...(Number.isInteger(sourceMessage.seq) ? { sourceMessageSeq: sourceMessage.seq } : {}),
  });
  const stored = await appendEvent(sessionId, {
    ...event,
    runId: run.id,
    ...(run.requestId || manifest?.requestId ? { requestId: run.requestId || manifest.requestId } : {}),
    ...(run.responseId || manifest?.responseId ? { responseId: run.responseId || manifest.responseId } : {}),
  });
  broadcastSessionInvalidation(sessionId);
  return stored;
}

function sanitizePendingDispatchOptions(options = {}) {
  return sanitizeQueuedFollowUpOptions(options);
}

function buildQueuedFollowUpSourceContext(queue = []) {
  if (!Array.isArray(queue) || queue.length === 0) return null;
  if (queue.length === 1) {
    return normalizeSourceContext(queue[0]?.sourceContext);
  }
  const queuedMessages = queue
    .map((entry) => {
      const sourceContext = normalizeSourceContext(entry?.sourceContext);
      if (!sourceContext) return null;
      const requestId = typeof entry?.requestId === 'string' ? entry.requestId.trim() : '';
      const responseId = typeof entry?.responseId === 'string' ? entry.responseId.trim() : '';
      return {
        ...(requestId ? { requestId } : {}),
        ...(responseId ? { responseId } : {}),
        sourceContext,
      };
    })
    .filter(Boolean);
  return queuedMessages.length > 0 ? { queuedMessages } : null;
}

function serializeQueuedFollowUp(entry) {
  const attachments = getMessageAttachments(entry).map((image) => ({
    ...(image?.filename ? { filename: image.filename } : {}),
    ...(image?.assetId ? { assetId: image.assetId } : {}),
    ...(image?.originalName ? { originalName: image.originalName } : {}),
    ...(image?.mimeType ? { mimeType: image.mimeType } : {}),
    ...(normalizeAttachmentSizeBytes(image?.sizeBytes) ? { sizeBytes: normalizeAttachmentSizeBytes(image.sizeBytes) } : {}),
    ...(trimString(image?.renderAs) === 'file' ? { renderAs: 'file' } : {}),
  }));
  return {
    requestId: typeof entry?.requestId === 'string' ? entry.requestId : '',
    responseId: typeof entry?.responseId === 'string' ? entry.responseId : '',
    text: typeof entry?.text === 'string' ? entry.text : '',
    queuedAt: typeof entry?.queuedAt === 'string' ? entry.queuedAt : '',
    ...(attachments.length > 0 ? { attachments, images: attachments } : {}),
  };
}

function trimRecentFollowUpRequestIds(ids) {
  if (!Array.isArray(ids)) return [];
  const unique = [];
  const seen = new Set();
  for (const value of ids) {
    const requestId = typeof value === 'string' ? value.trim() : '';
    if (!requestId || seen.has(requestId)) continue;
    seen.add(requestId);
    unique.push(requestId);
  }
  return unique.slice(-MAX_RECENT_FOLLOW_UP_REQUEST_IDS);
}

function hasRecentFollowUpRequestId(meta, requestId) {
  const normalized = typeof requestId === 'string' ? requestId.trim() : '';
  if (!normalized) return false;
  return trimRecentFollowUpRequestIds(meta?.recentFollowUpRequestIds).includes(normalized);
}

function findQueuedFollowUpByRequest(meta, requestId) {
  const normalized = typeof requestId === 'string' ? requestId.trim() : '';
  if (!normalized) return null;
  return getFollowUpQueue(meta).find((entry) => entry.requestId === normalized) || null;
}

function findQueuedFollowUpByResponse(meta, responseId) {
  const normalized = trimString(responseId);
  if (!normalized) return null;
  return getFollowUpQueue(meta).find((entry) => trimString(entry?.responseId || entry?.requestId) === normalized) || null;
}

function findPendingDispatchByRequest(meta, requestId) {
  const normalized = trimString(requestId);
  if (!normalized) return null;
  return getPendingPlanningQueue(meta).find((entry) => trimString(entry?.requestId) === normalized) || null;
}

function findPendingDispatchByResponse(meta, responseId) {
  const normalized = trimString(responseId);
  if (!normalized) return null;
  return getPendingPlanningQueue(meta).find((entry) => trimString(entry?.responseId || entry?.requestId) === normalized) || null;
}

function isPendingPlanningEntryStale(entry, nowMs = Date.now()) {
  const queuedAtMs = Date.parse(trimString(entry?.queuedAt));
  return Number.isFinite(queuedAtMs) && (nowMs - queuedAtMs) > PENDING_PLANNING_STALE_MS;
}

function formatQueuedFollowUpTextEntry(entry, index) {
  const lines = [];
  if (index !== null) {
    lines.push(`${index + 1}.`);
  }
  const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
  if (text) {
    if (index !== null) {
      lines[0] = `${lines[0]} ${text}`;
    } else {
      lines.push(text);
    }
  }
  const attachmentLine = formatAttachmentContextLine(getMessageAttachments(entry));
  if (attachmentLine) lines.push(attachmentLine);
  return lines.join('\n');
}

function buildQueuedFollowUpTranscriptText(queue) {
  if (!Array.isArray(queue) || queue.length === 0) return '';
  if (queue.length === 1) {
    return formatQueuedFollowUpTextEntry(queue[0], null);
  }
  return [
    'Queued follow-up messages sent while Ragent was busy:',
    '',
    ...queue.map((entry, index) => formatQueuedFollowUpTextEntry(entry, index)),
  ].join('\n\n');
}

function buildQueuedFollowUpDispatchText(queue) {
  if (!Array.isArray(queue) || queue.length === 0) return '';
  if (queue.length === 1) {
    return buildQueuedFollowUpTranscriptText(queue);
  }
  return [
    `The user sent ${queue.length} follow-up messages while you were busy.`,
    'Treat the ordered items below as the next user turn.',
    'If a later item corrects or overrides an earlier one, follow the latest correction.',
    '',
    ...queue.map((entry, index) => formatQueuedFollowUpTextEntry(entry, index)),
  ].join('\n\n');
}

function resolveQueuedFollowUpDispatchOptions(queue, session) {
  const resolved = {
    tool: session?.tool || '',
    model: undefined,
    effort: undefined,
    serviceTier: undefined,
    thinking: false,
  };
  for (const entry of queue || []) {
    if (typeof entry?.tool === 'string' && entry.tool.trim()) {
      resolved.tool = entry.tool.trim();
    }
    if (typeof entry?.model === 'string' && entry.model.trim()) {
      resolved.model = entry.model.trim();
    }
    if (typeof entry?.effort === 'string' && entry.effort.trim()) {
      resolved.effort = entry.effort.trim();
    }
    if (typeof entry?.serviceTier === 'string' && entry.serviceTier.trim()) {
      resolved.serviceTier = normalizeCodexServiceTier(entry.serviceTier);
    }
    if (entry?.thinking === true) {
      resolved.thinking = true;
    }
  }
  if (!resolved.tool) {
    resolved.tool = session?.tool || 'codex';
  }
  return resolved;
}

function clearFollowUpFlushTimer(sessionId) {
  const runtimeState = sessionRuntimeStateById.get(sessionId);
  if (!runtimeState?.followUpFlushTimer) return false;
  clearTimeout(runtimeState.followUpFlushTimer);
  delete runtimeState.followUpFlushTimer;
  return true;
}

function clearPendingDispatchFlushTimer(sessionId) {
  const runtimeState = sessionRuntimeStateById.get(sessionId);
  if (!runtimeState?.pendingDispatchFlushTimer) return false;
  clearTimeout(runtimeState.pendingDispatchFlushTimer);
  delete runtimeState.pendingDispatchFlushTimer;
  return true;
}

async function flushQueuedFollowUps(sessionId) {
  const runtimeState = ensureSessionRuntimeState(sessionId);
  if (runtimeState.followUpFlushPromise) {
    return runtimeState.followUpFlushPromise;
  }

  const promise = (async () => {
    clearFollowUpFlushTimer(sessionId);

    let rawSession = await findSessionMeta(sessionId);
    if (!rawSession) return false;
    rawSession = (await reconcileSessionActiveRuns(rawSession)).meta;

    if (rawSession.activeRunId) {
      const activeRun = await flushDetachedRunIfNeeded(sessionId, rawSession.activeRunId) || await getRun(rawSession.activeRunId);
      if (activeRun && !isTerminalRunState(activeRun.state)) {
        return false;
      }
    }

    const queue = getFollowUpQueue(rawSession);
    if (queue.length === 0) return false;

    const entry = queue[0];
    const requestId = trimString(entry?.requestId);
    if (!requestId) return false;
    const responseId = trimString(entry?.responseId || entry?.requestId);
    const removed = await removeQueuedFollowUpForSteer(sessionId, requestId);
    if (!removed.changed || !removed.entry) return false;

    try {
      const dispatchText = buildQueuedFollowUpDispatchText([removed.entry]);
      const transcriptText = buildQueuedFollowUpTranscriptText([removed.entry]);
      const dispatchOptions = resolveQueuedFollowUpDispatchOptions([removed.entry], rawSession);
      const queuedSourceContext = buildQueuedFollowUpSourceContext([removed.entry]);

      await submitHttpMessage(sessionId, dispatchText, [], {
        requestId,
        ...(responseId ? { responseId } : {}),
        tool: dispatchOptions.tool,
        model: dispatchOptions.model,
        effort: dispatchOptions.effort,
        serviceTier: dispatchOptions.serviceTier,
        thinking: dispatchOptions.thinking,
        ...sanitizeQueuedFollowUpOptions(removed.entry),
        ...(queuedSourceContext ? { sourceContext: queuedSourceContext } : {}),
        preSavedAttachments: sanitizeQueuedFollowUpAttachments(getMessageAttachments(removed.entry)),
        recordedUserText: transcriptText,
        queueIfBusy: false,
        skipDispatch: true,
      });

      const tracked = await mutateSessionMeta(sessionId, (session) => {
        session.recentFollowUpRequestIds = trimRecentFollowUpRequestIds([
          ...(session.recentFollowUpRequestIds || []),
          requestId,
        ]);
        session.updatedAt = nowIso();
        return true;
      });

      if (tracked.changed) {
        broadcastSessionInvalidation(sessionId);
      }
      return true;
    } catch (error) {
      await restoreQueuedFollowUpAfterFailedSteer(sessionId, removed.entry, removed.index);
      throw error;
    }
  })().catch((error) => {
    console.error(`[follow-up-queue] failed to flush ${sessionId}: ${error.message}`);
    scheduleQueuedFollowUpDispatch(sessionId, FOLLOW_UP_FLUSH_DELAY_MS * 2);
    return false;
  }).finally(() => {
    const current = sessionRuntimeStateById.get(sessionId);
    if (current?.followUpFlushPromise === promise) {
      delete current.followUpFlushPromise;
    }
  });

  runtimeState.followUpFlushPromise = promise;
  return promise;
}

async function flushPendingDispatchQueue(sessionId) {
  const runtimeState = ensureSessionRuntimeState(sessionId);
  if (runtimeState.pendingDispatchFlushPromise) {
    return runtimeState.pendingDispatchFlushPromise;
  }

  const promise = (async () => {
    clearPendingDispatchFlushTimer(sessionId);

    const rawSession = await findSessionMeta(sessionId);
    if (!rawSession) return false;

    const queue = getPendingPlanningQueue(rawSession);
    if (queue.length === 0) return false;

    const entry = queue[0];
    if (!entry || !trimString(entry.requestId) || !trimString(entry.text)) {
      await mutateSessionMeta(sessionId, (session) => {
        const currentQueue = getPendingPlanningQueue(session);
        if (currentQueue.length === 0) return false;
        session.pendingPlanningQueue = currentQueue.slice(1);
        if (session.pendingPlanningQueue.length === 0) {
          delete session.pendingPlanningQueue;
        }
        session.updatedAt = nowIso();
        return true;
      });
      broadcastSessionInvalidation(sessionId);
      return false;
    }

    const normalizedText = trimString(entry.text);
    const entryIsStale = isPendingPlanningEntryStale(entry);
    const planningOptions = {
      requestId: trimString(entry.requestId),
      ...(trimString(entry.responseId) ? { responseId: trimString(entry.responseId) } : {}),
      ...sanitizePendingDispatchOptions(entry),
      preSavedAttachments: sanitizeQueuedFollowUpAttachments(getMessageAttachments(entry)),
    };

    let completed = false;
    try {
      const session = await getSession(sessionId);
      if (!session) return false;

      let plannedElsewhere = false;
      if (!entryIsStale && shouldRunDispatch(session, planningOptions)) {
        try {
          const continuationPlan = await planSessionContinuations({
            session,
            message: normalizedText,
            loadSessionHistory: (targetSessionId) => loadHistory(targetSessionId, { includeBodies: false }),
            runPrompt: (prompt) => runDetachedAssistantPrompt({
              ...session,
              id: sessionId,
              tool: session.tool,
              model: undefined,
              effort: 'low',
              thinking: false,
            }, prompt, {
              timeoutMs: CONTINUATION_PLANNER_TIMEOUT_MS,
              usageTracking: {
                operation: 'session_continuation_planner',
              },
            }),
          });

          if (!isTrivialContinuationPlan(continuationPlan)) {
            const planningOutcome = await executeContinuationPlan({
              plan: continuationPlan,
              sourceSession: session,
              sourceSessionId: sessionId,
              message: normalizedText,
              images: [],
              options: planningOptions,
              createSession: (folder, tool, name, extra) => createSession(folder, tool, name, extra),
              submitMessage: submitHttpMessage,
              appendEvent,
              broadcastInvalidation: broadcastSessionInvalidation,
              messageEvent,
              contextOperationEvent,
              buildSessionNavigationHref,
              prepareFullParentContext: async () => {
                const [snapshot, contextHead] = await Promise.all([
                  getHistorySnapshot(sessionId),
                  getContextHead(sessionId),
                ]);
                return getOrPrepareForkContext(sessionId, snapshot, contextHead);
              },
              setPreparedChildContext: async (childSessionId, prepared) => setForkContext(childSessionId, prepared),
              createDerivedRequestId: (destination, index) => {
                const prefix = destination?.mode === 'fork' ? 'fork' : 'fresh';
                return createInternalRequestId(`continuation_${prefix}_${index + 1}`);
              },
            });
            plannedElsewhere = planningOutcome.applied === true;
          }
        } catch (dispatchError) {
          console.error(`[session-continuation] Async planning error during ${sessionId?.slice(0, 8)}: ${dispatchError.message}`);
        }
      } else if (entryIsStale) {
        console.warn(`[session-continuation] Pending planning entry ${trimString(entry.requestId)} is stale; falling back to current session`);
      }

      if (!plannedElsewhere) {
        await submitHttpMessage(sessionId, normalizedText, [], {
          ...planningOptions,
          skipDispatch: true,
          skipPendingDispatchLookup: true,
        });
      }
      completed = true;
    } catch (error) {
      console.error(`[session-continuation] Failed to flush accepted planning queue for ${sessionId}: ${error.message}`);
    }

    if (!completed) {
      schedulePendingDispatchFlush(sessionId, FOLLOW_UP_FLUSH_DELAY_MS * 2);
      return false;
    }

    const cleared = await mutateSessionMeta(sessionId, (session) => {
      const currentQueue = getPendingPlanningQueue(session);
      if (currentQueue.length === 0) return false;
      const [head, ...rest] = currentQueue;
      if (trimString(head?.requestId) !== trimString(entry.requestId)) {
        return false;
      }
      if (rest.length > 0) {
        session.pendingPlanningQueue = rest;
      } else {
        delete session.pendingPlanningQueue;
      }
      session.updatedAt = nowIso();
      return true;
    });

    if (cleared.changed) {
      broadcastSessionInvalidation(sessionId);
    }
    if (getPendingPlanningQueueCount(cleared.meta) > 0) {
      schedulePendingDispatchFlush(sessionId, 0);
    }
    return true;
  })().finally(() => {
    const current = sessionRuntimeStateById.get(sessionId);
    if (current?.pendingDispatchFlushPromise === promise) {
      delete current.pendingDispatchFlushPromise;
    }
  });

  runtimeState.pendingDispatchFlushPromise = promise;
  return promise;
}

function scheduleQueuedFollowUpDispatch(sessionId, delayMs = FOLLOW_UP_FLUSH_DELAY_MS) {
  const runtimeState = ensureSessionRuntimeState(sessionId);
  if (runtimeState.followUpFlushPromise) return true;
  clearFollowUpFlushTimer(sessionId);
  runtimeState.followUpFlushTimer = setTimeout(() => {
    const current = sessionRuntimeStateById.get(sessionId);
    if (current?.followUpFlushTimer) {
      delete current.followUpFlushTimer;
    }
    void flushQueuedFollowUps(sessionId);
  }, delayMs);
  if (typeof runtimeState.followUpFlushTimer.unref === 'function') {
    runtimeState.followUpFlushTimer.unref();
  }
  return true;
}

function schedulePendingDispatchFlush(sessionId, delayMs = 0) {
  const runtimeState = ensureSessionRuntimeState(sessionId);
  if (runtimeState.pendingDispatchFlushPromise) return true;
  clearPendingDispatchFlushTimer(sessionId);
  runtimeState.pendingDispatchFlushTimer = setTimeout(() => {
    const current = sessionRuntimeStateById.get(sessionId);
    if (current?.pendingDispatchFlushTimer) {
      delete current.pendingDispatchFlushTimer;
    }
    void flushPendingDispatchQueue(sessionId);
  }, Math.max(0, delayMs));
  if (typeof runtimeState.pendingDispatchFlushTimer.unref === 'function') {
    runtimeState.pendingDispatchFlushTimer.unref();
  }
  return true;
}

function createInternalRequestId(prefix = 'internal') {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;
}

function getInternalSessionRole(meta) {
  return typeof meta?.internalRole === 'string' ? meta.internalRole.trim() : '';
}

function isInternalSession(meta) {
  return !!getInternalSessionRole(meta);
}

function isContextCompactorSession(meta) {
  return getInternalSessionRole(meta) === INTERNAL_SESSION_ROLE_CONTEXT_COMPACTOR;
}

function hasExplicitSessionSource(meta) {
  const sourceId = normalizeAppId(meta?.sourceId);
  if (!sourceId || sourceId === DEFAULT_APP_ID) {
    return false;
  }
  return true;
}

function shouldExposeSession(meta) {
  return !isInternalSession(meta);
}

function isUserAddressableSession(meta) {
  if (!meta || meta.userAddressable === false) return false;
  const sessionPlane = typeof meta.sessionPlane === 'string'
    ? meta.sessionPlane.trim().toLowerCase()
    : 'user';
  if (sessionPlane === 'organization') return false;
  return !isManagedSessionClass(resolveSessionClass(meta));
}

function isTaskCardEnabledForSession(meta) {
  if (!meta || isInternalSession(meta)) return false;
  if (meta.visitorId) return false;
  if (normalizeSessionTaskCard(meta.taskCard)) return true;
  if (normalizeSessionStarterPreset(meta?.starterPreset) === WELCOME_STARTER_PRESET) return true;
  return !hasExplicitSessionSource(meta);
}

function isWelcomeOnboardingActive(meta) {
  if (!meta || isInternalSession(meta)) return false;
  if (normalizeSessionStarterPreset(meta?.starterPreset) !== WELCOME_STARTER_PRESET) return false;
  return !(typeof meta.welcomeOnboardingRetiredAt === 'string' && meta.welcomeOnboardingRetiredAt.trim());
}

function shouldRetireWelcomeOnboarding(meta) {
  if (!isWelcomeOnboardingActive(meta)) return false;
  if (!normalizeSessionTaskCard(meta.taskCard)) return false;
  return Number(meta.messageCount || 0) >= 2;
}

export function ensureSessionRuntimeState(sessionId) {
  let runtimeState = sessionRuntimeStateById.get(sessionId);
  if (!runtimeState) {
    runtimeState = { lastActivityAt: Date.now() };
    sessionRuntimeStateById.set(sessionId, runtimeState);
  }
  return runtimeState;
}

// DS-07: per-session runtime state and timeline-bundle generation lifecycle.
//
// sessionRuntimeStateById and timelineInvalidationGeneration used to grow for
// the lifetime of the process: every session that ever had a message submit,
// flush timer, rename, or invalidation kept one Map entry forever. Nothing
// durable lives there (meta, history, run records, and approval events are all
// persisted), so idle entries can be released. A session is never released
// while it has an active run, pending send (queued follow-ups / planning
// queue / in-flight flush), or pending approval — see
// releaseSessionRuntimeState. observedRuns needs no equivalent release: each
// entry carries an unref'd watcher + poller, is keyed by run id, and is
// stopped as soon as its run reaches a terminal state or its storage
// disappears.
function touchSessionRuntimeState(sessionId) {
  const runtimeState = sessionRuntimeStateById.get(sessionId);
  if (runtimeState) {
    runtimeState.lastActivityAt = Date.now();
  }
}

const SESSION_RUNTIME_SWEEP_INTERVAL_MS = 60_000;
const SESSION_RUNTIME_IDLE_TTL_MS = 15 * 60_000;
const SESSION_RUNTIME_TTL_ENV = 'AGENTOC_SESSION_RUNTIME_TTL_MS';
const SESSION_RUNTIME_SWEEP_INTERVAL_ENV = 'AGENTOC_SESSION_RUNTIME_SWEEP_MS';

function resolveSessionRuntimeTtlMs() {
  const parsed = Number.parseInt(process.env[SESSION_RUNTIME_TTL_ENV] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SESSION_RUNTIME_IDLE_TTL_MS;
}

function resolveSessionRuntimeSweepIntervalMs() {
  const parsed = Number.parseInt(process.env[SESSION_RUNTIME_SWEEP_INTERVAL_ENV] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SESSION_RUNTIME_SWEEP_INTERVAL_MS;
}

// Serializes releases per session so two concurrent callers (sweep tick + an
// eager caller) can never both pass the guards and both run cleanup.
const runtimeStateReleaseInFlight = new Set();

/**
 * Guard checked synchronously against the live runtime state object. Blocks on
 * in-flight flush/dispatch promises (a queued send is being processed right
 * now) and on pending context compaction. Pending timers are deliberately not
 * checked here: they are the durable queues' schedule, so the meta phase
 * below decides on them.
 */
function collectSyncRuntimeReleaseGuard(runtimeState) {
  if (runtimeState.pendingCompact === true) {
    return { blocked: true, reason: 'pending-compact' };
  }
  if (runtimeState.followUpFlushPromise || runtimeState.pendingDispatchFlushPromise) {
    return { blocked: true, reason: 'pending-send' };
  }
  return { blocked: false, reason: '' };
}

/**
 * Async guard phase: reads the durable session meta and (when one exists) the
 * cached run record. Blocks on active runs, run-level pending approvals
 * (defense in depth — such runs are non-terminal anyway), queued follow-ups /
 * planning queue, and pending flush timers.
 */
async function collectSessionRuntimeReleaseGuard(sessionId, runtimeState) {
  const syncGuard = collectSyncRuntimeReleaseGuard(runtimeState);
  if (syncGuard.blocked) return syncGuard;
  const meta = await findSessionMeta(sessionId);
  if (meta) {
    const activeRunId = typeof meta.activeRunId === 'string' ? meta.activeRunId.trim() : '';
    if (activeRunId) {
      const run = await getRun(activeRunId).catch(() => null);
      if (run) {
        if (hasPendingRunApproval(run)) {
          return { blocked: true, reason: 'pending-approval' };
        }
        if (!isTerminalRunState(run.state)) {
          return { blocked: true, reason: 'active-run' };
        }
      }
    }
    if (getFollowUpQueueCount(meta) > 0 || getPendingPlanningQueueCount(meta) > 0) {
      return { blocked: true, reason: 'pending-send' };
    }
    if (runtimeState.followUpFlushTimer || runtimeState.pendingDispatchFlushTimer) {
      return { blocked: true, reason: 'pending-send' };
    }
  }
  return { blocked: false, reason: '' };
}

/**
 * Release a session's runtime state (and its timeline-bundle generation
 * entry). Idempotent and race-safe:
 *   - a per-session in-flight set serializes concurrent releases, so cleanup
 *     never runs twice for the same entry;
 *   - guards are re-validated synchronously right before cleanup, and cleanup
 *     only deletes the exact object that passed the guards (identity check),
 *     so an activity that re-created the entry during the async guard phase
 *     is never torn down;
 *   - timers are cleared, not fired; nothing durable is touched.
 * force: true skips every guard (used when the session is known gone).
 */
export async function releaseSessionRuntimeState(sessionId, options = {}) {
  const normalizedId = trimString(sessionId);
  if (!normalizedId) return { released: false, reason: 'invalid-id' };
  const runtimeState = sessionRuntimeStateById.get(normalizedId);
  if (!runtimeState) return { released: false, reason: 'absent' };
  if (runtimeStateReleaseInFlight.has(normalizedId)) {
    return { released: false, reason: 'release-in-flight' };
  }
  runtimeStateReleaseInFlight.add(normalizedId);
  try {
    if (options.force === true) {
      cleanupSessionRuntimeState(normalizedId, runtimeState);
      return { released: true, reason: 'force' };
    }
    const guard = await collectSessionRuntimeReleaseGuard(normalizedId, runtimeState);
    if (guard.blocked) {
      return { released: false, reason: guard.reason };
    }
    const current = sessionRuntimeStateById.get(normalizedId);
    if (!current || current !== runtimeState) {
      return { released: false, reason: 'recreated' };
    }
    const recheck = collectSyncRuntimeReleaseGuard(runtimeState);
    if (recheck.blocked) {
      return { released: false, reason: recheck.reason };
    }
    cleanupSessionRuntimeState(normalizedId, runtimeState);
    return { released: true, reason: 'idle' };
  } finally {
    runtimeStateReleaseInFlight.delete(normalizedId);
  }
}

function cleanupSessionRuntimeState(sessionId, runtimeState) {
  clearFollowUpFlushTimer(sessionId);
  clearPendingDispatchFlushTimer(sessionId);
  // The sync guard already proved no promise is in flight; drop the transient
  // fields so the released object cannot keep anything alive.
  delete runtimeState.followUpFlushPromise;
  delete runtimeState.pendingDispatchFlushPromise;
  delete runtimeState.renameState;
  delete runtimeState.renameError;
  delete runtimeState.pendingCompact;
  delete runtimeState.lastActivityAt;
  if (sessionRuntimeStateById.get(sessionId) === runtimeState) {
    sessionRuntimeStateById.delete(sessionId);
  }
  timelineInvalidationGeneration.delete(sessionId);
}

async function sweepSessionRuntimeStates() {
  const ttlMs = resolveSessionRuntimeTtlMs();
  const now = Date.now();
  // Stale runtime-state entries: release (guards still apply, so an entry that
  // became busy again is left for the next tick).
  for (const sessionId of [...sessionRuntimeStateById.keys()]) {
    const runtimeState = sessionRuntimeStateById.get(sessionId);
    if (!runtimeState) continue;
    if (now - (runtimeState.lastActivityAt || 0) < ttlMs) continue;
    try {
      // Guarded: an entry that became busy again is simply left for the next
      // tick (active run, pending send, pending approval, compaction).
      await releaseSessionRuntimeState(sessionId);
    } catch (error) {
      console.error(`[session-runtime] sweep release failed for ${sessionId}: ${error.message}`);
    }
  }
  // Stale generation-only entries (sessions with no runtime state that only
  // ever received invalidations). Entries for live runtime states are removed
  // by the release path above.
  for (const [sessionId, entry] of [...timelineInvalidationGeneration.entries()]) {
    if (sessionRuntimeStateById.has(sessionId)) continue;
    if (!entry || typeof entry !== 'object' || now - (entry.at || 0) < ttlMs) continue;
    timelineInvalidationGeneration.delete(sessionId);
  }
}

let sessionRuntimeSweepTimer = null;

export function startSessionRuntimeStateSweep() {
  if (sessionRuntimeSweepTimer) return sessionRuntimeSweepTimer;
  sessionRuntimeSweepTimer = setInterval(() => {
    void sweepSessionRuntimeStates();
  }, resolveSessionRuntimeSweepIntervalMs());
  if (typeof sessionRuntimeSweepTimer.unref === 'function') {
    sessionRuntimeSweepTimer.unref();
  }
  return sessionRuntimeSweepTimer;
}

export function stopSessionRuntimeStateSweep() {
  if (!sessionRuntimeSweepTimer) return false;
  clearInterval(sessionRuntimeSweepTimer);
  sessionRuntimeSweepTimer = null;
  return true;
}

// Test-only surface: observe release behavior without probing module internals
// (precedent: __getTimelineBundleCounters).
export function __getSessionRuntimeSnapshot() {
  return {
    entries: sessionRuntimeStateById.size,
    sessionIds: [...sessionRuntimeStateById.keys()],
    generationEntries: timelineInvalidationGeneration.size,
    generations: [...timelineInvalidationGeneration.entries()]
      .map(([sessionId, entry]) => ({ sessionId, gen: entry?.gen || 0, at: entry?.at || 0 })),
  };
}

export function __getSessionRuntimeState(sessionId) {
  return sessionRuntimeStateById.get(trimString(sessionId)) || null;
}

function isReplySelfRepairOperation(manifest) {
  return manifest?.internalOperation === REPLY_SELF_REPAIR_INTERNAL_OPERATION;
}

function allowsSessionTurnCompletionEffects(manifest) {
  return !manifest?.internalOperation || isReplySelfRepairOperation(manifest);
}


function stopObservedRun(runId) {
  const observed = observedRuns.get(runId);
  if (!observed) return;
  cancelLeadingTask(observed);
  if (observed.poller) {
    clearInterval(observed.poller);
  }
  try {
    observed.watcher?.close();
  } catch {}
  observedRuns.delete(runId);
  // Drop the per-run delta adapter so its auto-approval suppression Set is
  // released with the run (re-created + re-seeded on any later observation).
  releaseRunRuntimeInvocation(runId);
}

function isMissingRunStorageError(error) {
  if (!error || error.code !== 'ENOENT') {
    return false;
  }
  const message = typeof error.message === 'string' ? error.message : '';
  return /chat-runs|status\.json|manifest\.json|result\.json|spool\.jsonl/.test(message);
}

function scheduleObservedRunSync(runId, delayMs = 40) {
  const observed = observedRuns.get(runId);
  if (!observed) return;
  scheduleLeadingTask(observed, async () => {
    const current = observedRuns.get(runId);
    if (!current || current !== observed) return;
      try {
        const run = await syncDetachedRun(current.sessionId, runId);
        const runUpdated = Boolean(
          run?.updatedAt
          && run.updatedAt !== current.lastRunUpdatedAt,
        );
        current.lastRunUpdatedAt = run?.updatedAt || current.lastRunUpdatedAt || null;
        if (!run || isTerminalRunState(run.state)) {
          stopObservedRun(runId);
        } else if (runUpdated && run.providerLiveness?.heartbeatAt) {
          // Provider heartbeats intentionally do not create history events.
          // Still invalidate the session so clients can distinguish a live
          // process waiting on AgY output from a genuinely stale run.
          broadcastSessionInvalidation(current.sessionId);
        }
      } catch (error) {
        if (isMissingRunStorageError(error)) {
          stopObservedRun(runId);
          return;
        }
        // The normal poller retries once the root revocation becomes available.
        if (error?.code === 'LINUX_RUN_RESULT_UNAVAILABLE') return;
        console.error(`[runs] observer sync failed for ${runId}: ${error.message}`);
      }
  }, delayMs);
}

function observeDetachedRun(sessionId, runId) {
  if (!runId) return false;
  const existing = observedRuns.get(runId);
  if (existing) {
    existing.sessionId = sessionId;
    return true;
  }
  try {
    const watcher = watch(runDir(runId), (_eventType, filename) => {
      if (filename) {
        const changed = String(filename);
        if (!['spool.jsonl', 'status.json', 'result.json', 'result.pending.json'].includes(changed)) {
          return;
        }
      }
      scheduleObservedRunSync(runId);
    });
    watcher.on('error', (error) => {
      console.error(`[runs] observer error for ${runId}: ${error.message}`);
      stopObservedRun(runId);
    });
    const poller = setInterval(() => {
      scheduleObservedRunSync(runId, 0);
    }, OBSERVED_RUN_POLL_INTERVAL_MS);
    if (typeof poller.unref === 'function') {
      poller.unref();
    }
    observedRuns.set(runId, {
      sessionId,
      watcher,
      timer: null,
      poller,
      lastRunUpdatedAt: null,
    });
    totalObservedRuns += 1;
    scheduleObservedRunSync(runId, 0);
    return true;
  } catch (error) {
    console.error(`[runs] failed to observe ${runId}: ${error.message}`);
    return false;
  }
}

async function buildSessionTimelineEvents(sessionId, options = {}) {
  const sessionMeta = options.sessionMeta || await findSessionMeta(sessionId);
  const activeRunId = typeof sessionMeta?.activeRunId === 'string' ? sessionMeta.activeRunId.trim() : '';
  // getSessionTimelineBundle syncs the run itself (before computing its cache
  // key) and passes skipSync to avoid a second sync inside the build.
  if (activeRunId && !options.skipSync) {
    await syncDetachedRun(sessionId, activeRunId);
  }
  const events = await loadHistory(sessionId, { includeBodies: options.includeBodies !== false });
  return enrichRunCapabilities(await enrichPlanEventIntents(events));
}

// Perf (AGENTOC_PERF_TIMELINE_CACHE=off): the frontend refetches the visible
// timeline (events / event-delta endpoints) on every session invalidation,
// and each request used to rebuild the whole transcript (with bodies) plus
// the display transform plus the run-activity projection. The bundle is now
// memoized per session, keyed on everything that can change its content:
// latestSeq, activeRunId, the run state fingerprint, and an invalidation
// generation counter (covers any future in-place event mutation). Bundles
// over the size threshold are not cached at all (pathological sessions), and
// the cache itself is bounded.
//
// DS-10 hardening: the cached payload is the display projection only — the
// raw timeline (with hidden event types and their bodies) is a build
// intermediate that no consumer reads, and retaining it in the memo would
// drag tool_result/reasoning bodies into the heap of sessions whose display
// projection looks small. The skip decision therefore estimates exactly what
// the memo retains (displayEvents + runActivity), not a few display fields.
const AGENTOC_PERF_TIMELINE_CACHE_ENV = 'AGENTOC_PERF_TIMELINE_CACHE';
const PERF_TIMELINE_CACHE_ENABLED = isEnvToggleEnabled(process.env[AGENTOC_PERF_TIMELINE_CACHE_ENV], { defaultValue: true });
const TIMELINE_BUNDLE_CACHE_ENTRIES = 16;
const TIMELINE_BUNDLE_CACHE_MAX_BYTES = cacheBudget('timeline.bundle', 2);
// The legacy bundle endpoint is still used by older clients and integrations,
// but it must not reconstruct an entire transcript on every refresh. Newer
// clients already consume the paginated timeline endpoint; keep this
// compatibility bundle to the same bounded latest window and expose its
// pagination metadata for callers that want to page backwards.
const TIMELINE_BUNDLE_PAGE_LIMIT = (() => {
  const parsed = Number.parseInt(String(process.env.AGENTOC_TIMELINE_BUNDLE_PAGE_LIMIT || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : 100;
})();
let TIMELINE_BUNDLE_SKIP_ESTIMATE_BYTES = 64 * 1024 * 1024;
const timelineBundleCache = new BoundedLruMap({
  maxEntries: TIMELINE_BUNDLE_CACHE_ENTRIES,
  maxBytes: TIMELINE_BUNDLE_CACHE_MAX_BYTES,
  bytesOf: (entry) => entry?.estimateBytes || 0,
});
// Metadata reads happen before the cache key is known. Coalesce the common
// no-options request at the outer boundary as well as the keyed build below;
// otherwise a very fast first build can finish before a concurrent caller
// reaches the key check and that caller is misclassified as a separate memo
// hit (or starts redundant work).
const timelineBundleRequestInflight = new Map();
// A cache miss is still expensive when several UI surfaces refresh the same
// session at once. Coalesce identical builds so only one bounded page read /
// projection runs per session+key; callers arriving during the build await it.
const timelineBundleInflight = new Map();
const timelineInvalidationGeneration = new Map(); // sessionId -> int

// Memory registry (DS-06): timeline bundle memo — hit rate uses the semantic
// key-match counters (hits vs rebuilds), not the LRU get() counters. skips
// count builds that were deliberately not cached (DS-10: over the estimate
// threshold), and skipReasons records the latest per-session skip cause
// (bounded map — diagnostics only, never read for decisions).
registerCache('timeline.bundle', {
  kind: 'lru',
  snapshot: (now = Date.now()) => ({
    ...timelineBundleCache.snapshotMetrics(now),
    hits: timelineBundleCacheHits,
    misses: timelineBundleCacheBuilds,
    skips: timelineBundleCacheSkips,
    skipReasonSessions: timelineBundleSkipReasons.size,
    enabled: PERF_TIMELINE_CACHE_ENABLED,
    skipThresholdBytes: TIMELINE_BUNDLE_SKIP_ESTIMATE_BYTES,
    generationEntries: timelineInvalidationGeneration.size,
  }),
});
let timelineBundleCacheHits = 0;
let timelineBundleCacheBuilds = 0;
let timelineBundleCacheSkips = 0;
const TIMELINE_BUNDLE_SKIP_REASON_CAP = 64;
const timelineBundleSkipReasons = new Map(); // sessionId -> reason (latest, capped)

function noteTimelineBundleSkip(sessionId, reason) {
  timelineBundleCacheSkips += 1;
  if (!timelineBundleSkipReasons.has(sessionId)
    && timelineBundleSkipReasons.size >= TIMELINE_BUNDLE_SKIP_REASON_CAP) {
    const oldest = timelineBundleSkipReasons.keys().next().value;
    if (oldest !== undefined) timelineBundleSkipReasons.delete(oldest);
  }
  timelineBundleSkipReasons.set(sessionId, reason);
}

// A generation counter only matters while its bundle is cached — without an
// entry there is no key to compare. Sweeping it alongside cache misses bounds
// the generation map by the cache size instead of growing with every session
// ever invalidated (DS-10: generation is releasable).
function sweepTimelineInvalidationGenerations() {
  for (const sessionId of [...timelineInvalidationGeneration.keys()]) {
    if (!timelineBundleCache.has(sessionId)) {
      timelineInvalidationGeneration.delete(sessionId);
    }
  }
}

// Release a session's memoized bundle, its generation counter, and any skip
// reason — used when the session is deleted so the heap is given
// back immediately instead of waiting for LRU eviction (DS-10).
export function releaseSessionTimelineCache(sessionId) {
  timelineBundleCache.delete(sessionId);
  timelineBundleInflight.delete(sessionId);
  timelineBundleRequestInflight.delete(sessionId);
  timelineInvalidationGeneration.delete(sessionId);
  timelineBundleSkipReasons.delete(sessionId);
}

// Honest retained-payload estimator (DS-10): walks the exact structures the
// memo keeps in memory (display events + run activity), counting strings and
// container overhead instead of guessing field names. Early-exits as soon as
// the skip threshold is crossed, so pathological sessions pay at most one
// threshold-sized walk.
function estimateBundleBytes(bundle) {
  let total = 0;
  const walk = (value) => {
    if (total > TIMELINE_BUNDLE_SKIP_ESTIMATE_BYTES) return;
    if (typeof value === 'string') {
      total += value.length;
    } else if (typeof value === 'number') {
      total += 8;
    } else if (typeof value === 'boolean') {
      total += 4;
    } else if (Array.isArray(value)) {
      total += 8;
      for (const item of value) walk(item);
    } else if (value && typeof value === 'object') {
      total += 32;
      for (const key of Object.keys(value)) {
        total += key.length;
        walk(value[key]);
      }
    }
  };
  walk(bundle);
  return total;
}

function buildSessionTimelineBundle(sessionMeta, run, timeline) {
  const sessionRunning = run?.state === 'running' || hasPendingApprovedActionPause(run);
  // projectRoot/home 供 operation 投影做风险分级（tier/arbitrate），
  // sessionId 供 LLM 增强完成回调回推（broadcastSessionInvalidation）。
  const displayEvents = buildSessionDisplayEvents(timeline, {
    sessionRunning,
    projectRoot: sessionMeta?.folder || '',
    home: process.env.HOME || '',
  });
  const runActivity = buildRunActivityProjection(displayEvents, {
    sessionRunning,
    run,
    sessionId: sessionMeta?.id || '',
  });
  // DS-10: 不把 raw timeline 放进 bundle——displayEvents/runActivity 是唯一被消费的投影，
  // 缓存里留存 timeline 会把 tool_result/reasoning 大体拖进 heap。
  return { displayEvents, runActivity, sessionRunning };
}

// The memo key must change whenever the bundle content can change:
//   - every metadata/event commit bumps historyMeta.historyRevision (the
//     authoritative content revision), while event appends also bump latestSeq;
//   - run content feeds the run-activity projection, so the run state
//     fingerprint (state/updatedAt/lastNormalizedAt) is part of the key;
//   - in-place event mutation (compaction rewrite, operation re-projection,
//     approval side effects, fork cleanup) may leave seq/run fields untouched,
//     so broadcastSessionInvalidation bumps the generation counter instead.
// The key is compared as an opaque string, never parsed.
function timelineBundleKeyFor(sessionId, historyMeta, activeRunId, run) {
  return [
    sessionId,
    historyMeta?.historyRevision || 0,
    historyMeta?.latestSeq || 0,
    activeRunId,
    run?.state || '',
    run?.updatedAt || '',
    run?.lastNormalizedAt || '',
    timelineInvalidationGeneration.get(sessionId)?.gen || 0,
  ].join(':');
}

async function getSessionTimelineBundleInternal(sessionId, options = {}) {
  let sessionMeta = options?.sessionMeta || await findSessionMeta(sessionId);
  sessionMeta = (await reconcileSessionActiveRuns(sessionMeta)).meta;
  let activeRunId = typeof sessionMeta?.activeRunId === 'string' ? sessionMeta.activeRunId.trim() : '';
  let synchronizedActiveRun = false;
  if (activeRunId) {
    await syncDetachedRun(sessionId, activeRunId);
    // Terminal reconciliation clears the session's activeRunId. Refresh the
    // metadata before deriving the cache key; otherwise this request caches a
    // bundle under a stale active-run fingerprint and the very next read
    // (which correctly sees an idle session) rebuilds it again.
    synchronizedActiveRun = true;
    if (synchronizedActiveRun) {
      sessionMeta = await findSessionMeta(sessionId);
      activeRunId = typeof sessionMeta?.activeRunId === 'string' ? sessionMeta.activeRunId.trim() : '';
    }
  }
  // A sync can append normalized events or update the Run status. In that
  // case the request-scoped snapshot is stale; refresh only the active-run
  // path. Idle sessions reuse the metadata read by the route unchanged.
  const run = activeRunId ? await getRun(activeRunId).catch(() => null) : (options?.run || null);
  const historyMeta = synchronizedActiveRun || activeRunId
    ? await loadMeta(sessionId, { strict: options?.strict === true })
    : (options?.historyMeta || await loadMeta(sessionId, { strict: options?.strict === true }));
  if (!PERF_TIMELINE_CACHE_ENABLED) {
    const page = await getSessionTimelinePage(sessionId, {
      limit: TIMELINE_BUNDLE_PAGE_LIMIT,
      direction: 'latest',
      sessionMeta,
      historyMeta,
      run,
      ...(options?.strict ? { strict: true } : {}),
    });
    return {
      displayEvents: Array.isArray(page?.events) ? page.events : [],
      runActivity: page?.runActivity || null,
      sessionRunning: run?.state === 'running' || hasPendingApprovedActionPause(run),
      pagination: page?.pagination || null,
    };
  }
  // latestSeq comes from the history meta (the authoritative per-event
  // counter), not the sessions file — every event append bumps it and the
  // memo rebuilds.
  const key = timelineBundleKeyFor(sessionId, historyMeta, activeRunId, run);
  const inflight = timelineBundleInflight.get(sessionId);
  if (inflight?.key === key && inflight.promise) {
    // Keep callers that arrive while the first build is still completing on
    // the shared promise. Checking this before the cache avoids counting a
    // just-finished coalesced caller as an additional memo hit (and, more
    // importantly, preserves the single-build/single-hit contract under fast
    // event-loop scheduling).
    return inflight.promise;
  }
  const cached = timelineBundleCache.get(sessionId);
  if (cached?.key === key) {
    timelineBundleCacheHits += 1;
    return cached.bundle;
  }
  timelineBundleCacheBuilds += 1;
  const buildPromise = (async () => {
    const page = await getSessionTimelinePage(sessionId, {
      limit: TIMELINE_BUNDLE_PAGE_LIMIT,
      direction: 'latest',
      sessionMeta,
      historyMeta,
      run,
      ...(options?.strict ? { strict: true } : {}),
    });
    const bundle = {
      displayEvents: Array.isArray(page?.events) ? page.events : [],
      runActivity: page?.runActivity || null,
      sessionRunning: run?.state === 'running' || hasPendingApprovedActionPause(run),
      pagination: page?.pagination || null,
    };
    const estimateBytes = estimateBundleBytes({ displayEvents: bundle.displayEvents, runActivity: bundle.runActivity });
    if (estimateBytes <= TIMELINE_BUNDLE_SKIP_ESTIMATE_BYTES) {
      timelineBundleCache.set(sessionId, { key, bundle, estimateBytes });
      timelineBundleSkipReasons.delete(sessionId);
      sweepTimelineInvalidationGenerations();
    } else {
      // Build happens but nothing is retained — the request still returns the
      // fresh bundle; only the memo skips it. Reasoned and observable (DS-10).
      noteTimelineBundleSkip(sessionId, 'over_estimate_threshold');
    }
    return bundle;
  })();
  timelineBundleInflight.set(sessionId, { key, promise: buildPromise });
  try {
    return await buildPromise;
  } finally {
    if (timelineBundleInflight.get(sessionId)?.promise === buildPromise) {
      timelineBundleInflight.delete(sessionId);
    }
  }
}

export async function getSessionTimelineBundle(sessionId, options = {}) {
  // Route callers may pass a request-scoped snapshot. It must retain its
  // existing semantics, so only the default (live) request is coalesced here.
  const canCoalesce = !options || Object.keys(options).length === 0;
  if (!canCoalesce) return getSessionTimelineBundleInternal(sessionId, options);
  const existing = timelineBundleRequestInflight.get(sessionId);
  if (existing) return existing;
  const promise = getSessionTimelineBundleInternal(sessionId, options);
  timelineBundleRequestInflight.set(sessionId, promise);
  try {
    return await promise;
  } finally {
    if (timelineBundleRequestInflight.get(sessionId) === promise) {
      timelineBundleRequestInflight.delete(sessionId);
    }
  }
}

// Test-only counters so the memo behavior is observable without probing the
// cache internals (precedent: this suite exposes __-prefixed surfaces).
export function __getTimelineBundleCounters() {
  return { hits: timelineBundleCacheHits, builds: timelineBundleCacheBuilds };
}

// Test-only decision probe: reports what the memo would decide for a session
// without building or syncing runs (read-only — does not touch the LRU order
// or the run state). Used by the scenario tests to assert hit/build/skip
// reasons per invalidation kind.
export async function __probeTimelineBundleDecision(sessionId) {
  if (!PERF_TIMELINE_CACHE_ENABLED) {
    return { decision: 'disabled', reason: 'env_toggle_off' };
  }
  let sessionMeta = await findSessionMeta(sessionId);
  const activeRunId = typeof sessionMeta?.activeRunId === 'string' ? sessionMeta.activeRunId.trim() : '';
  const run = activeRunId ? await getRun(activeRunId).catch(() => null) : null;
  const historyMeta = await loadMeta(sessionId);
  const key = timelineBundleKeyFor(sessionId, historyMeta, activeRunId, run);
  let cachedKey = null;
  if (timelineBundleCache.has(sessionId)) {
    for (const [cachedSessionId, entry] of timelineBundleCache) {
      if (cachedSessionId === sessionId) {
        cachedKey = entry?.key || null;
        break;
      }
    }
  }
  if (cachedKey === key) return { decision: 'hit', reason: 'key_match' };
  const skippedReason = timelineBundleSkipReasons.get(sessionId);
  if (skippedReason) return { decision: 'skip', reason: skippedReason };
  return { decision: 'miss', reason: 'key_mismatch' };
}

// Test-only limit override so the skip-threshold behavior is assertable
// without allocating tens of MB per test (precedent: history.mjs exposes
// __setCacheLimitsForTest).
export function __setTimelineCacheLimitsForTest({ skipEstimateBytes = null } = {}) {
  if (skipEstimateBytes != null) {
    if (!(Number.isFinite(skipEstimateBytes) && skipEstimateBytes > 0)) {
      throw new Error('skipEstimateBytes must be a positive finite number');
    }
    TIMELINE_BUNDLE_SKIP_ESTIMATE_BYTES = skipEstimateBytes;
  }
  return { skipEstimateBytes: TIMELINE_BUNDLE_SKIP_ESTIMATE_BYTES };
}

// Test-only diagnostics: full cache observability surface (DS-10) — counts,
// per-session skip reasons, what is retained, and the generation-map size so
// tests can assert memory is released on archive/deletion/eviction.
export function __getTimelineBundleDiagnostics() {
  return {
    enabled: PERF_TIMELINE_CACHE_ENABLED,
    hits: timelineBundleCacheHits,
    builds: timelineBundleCacheBuilds,
    skips: timelineBundleCacheSkips,
    skipReasons: Object.fromEntries(timelineBundleSkipReasons),
    cacheEntries: [...timelineBundleCache.keys()],
    cachedBytes: timelineBundleCache.byteSize,
    generationEntries: timelineInvalidationGeneration.size,
    generationSessions: [...timelineInvalidationGeneration.keys()],
    skipThresholdBytes: TIMELINE_BUNDLE_SKIP_ESTIMATE_BYTES,
    maxEntries: TIMELINE_BUNDLE_CACHE_ENTRIES,
    maxBytes: TIMELINE_BUNDLE_CACHE_MAX_BYTES,
  };
}

function getInstallAutoOps(batch) {
  return (Array.isArray(batch?.installAuto) ? batch.installAuto : [])
    .filter((op) => trimString(op?.opId) && trimString(op?.command));
}

function findPrivilegedExecResultForOp(events = [], opId = '') {
  const normalizedOpId = trimString(opId);
  if (!normalizedOpId) return null;
  return [...(Array.isArray(events) ? events : [])].reverse().find((event) =>
    event?.type === 'privileged_exec_result'
    && trimString(event?.opId) === normalizedOpId) || null;
}

function isSuccessfulPrivilegedExecResult(event) {
  return event?.type === 'privileged_exec_result'
    && !trimString(event?.error)
    && event?.exitCode === 0;
}

// Only runtimes with a live permission-response channel may receive an
// interactive privileged batch. Classic Claude streams remain fail-closed.
export function getPrivilegedExecutorRuntimeBlock(run, label = 'privileged execution', { allowCodex = false, platform = process.platform } = {}) {
  // macOS has neither a verified administrator helper nor an executor-side
  // authorization and target-revalidation boundary. Report this before any
  // signing key or Linux socket lookup instead of suggesting a broken setup.
  if (platform === 'darwin') return 'macOS administrator execution is not available on this host';
  const runtimeFamily = trimString(run?.runtimeFamily);
  if (runtimeFamily === 'claude-stream-json-bidi'
    || (allowCodex && runtimeFamily === 'codex-app-server-json')) return '';
  return `${label} is not supported for runtime ${runtimeFamily || 'unknown'}`;
}

function formatInstallAutoPreflightError(error) {
  const explicit = trimString(error?.installAutoErrorMessage);
  if (explicit) return explicit;
  return `Signing key load failed: ${error?.message || error}`;
}

async function executeInstallAutoOpAsStoredEvent(sessionId, run, batch, op, store, preflightError = null, deps = {}) {
  const batchId = trimString(batch?.batchId);
  // The legacy install-auto bridge predates the Phase 2B approved-action
  // executor. Keep injected executors available to compatibility tests and
  // migration tooling, but never let the production default bypass the single
  // permission gate when no Phase 2B authorization context is present.
  const executeOpAsEvent = typeof deps.executeOpAsEvent === 'function'
    ? deps.executeOpAsEvent
    : null;
  let event = null;
  if (!preflightError && !executeOpAsEvent) {
    preflightError = new Error('legacy install-auto execution is disabled until it is routed through the Phase 2B approved-action policy gate');
    preflightError.installAutoErrorMessage = preflightError.message;
  }
  if (preflightError) {
    event = privilegedExecResultEvent({
      opId: trimString(op?.opId),
      category: CATEGORY_INSTALL,
      error: formatInstallAutoPreflightError(preflightError),
    });
  } else {
    try {
      event = await executeOpAsEvent(op, {
        sessionId,
        runId: run?.id,
        turnId: trimString(batch?.turnId),
        authMode: 'install-auto',
        auditLabel: trimString(op?.description) || trimString(op?.command).slice(0, 300),
      });
    } catch (error) {
      event = privilegedExecResultEvent({
        opId: trimString(op?.opId),
        category: CATEGORY_INSTALL,
        error: error?.message || String(error),
      });
    }
  }
  if (!event) return null;
  return store.appendEvent({
    ...event,
    ...(batchId ? { batchId } : {}),
    runId: run?.id,
  });
}

async function enqueuePrivilegedCategoryApprovalResponses(
  runId,
  batchId,
  category,
  resolved,
  execResults = [],
  requestId = '',
  { decisionSource = 'execution' } = {},
) {
  const byOpId = new Map((Array.isArray(execResults) ? execResults : [])
    .map((event) => [trimString(event?.opId), event])
    .filter(([opId]) => opId));
  const entries = [];
  for (const op of Array.isArray(resolved?.categoryOps) ? resolved.categoryOps : []) {
    const resultEvent = byOpId.get(trimString(op?.opId)) || null;
    // The managed executor has already handled (or refused) this operation.
    // Allowing the original provider command would execute it again, possibly
    // outside the privileged boundary. Preserve the actual decision and result
    // separately from the provider gate's required denial.
    const privilegedDecision = resolved?.decisions?.[op?.opId] || 'unknown';
    const entry = buildPrivilegedApprovalQueueEntry({
      batchId,
      category,
      op,
      approved: false,
      requestId,
    });
    if (entry) entries.push({
      ...entry,
      privilegedDecision,
      privilegedDecisionSource: decisionSource,
      privilegedExecutionState: isSuccessfulPrivilegedExecResult(resultEvent)
        ? 'completed'
        : (trimString(resultEvent?.error) || Number.isInteger(resultEvent?.exitCode))
          ? 'failed' : 'unknown',
    });
  }
  if (entries.length === 0) return [];

  const updatedRun = await updateRun(runId, (current) => {
    const existingQueue = Array.isArray(current?.appServerApprovalResponseQueue)
      ? current.appServerApprovalResponseQueue
      : [];
    const existingApprovalIds = new Set(existingQueue
      .map((entry) => normalizeRuntimeApprovalId(entry?.approvalId))
      .filter(Boolean));
    const freshEntries = entries.filter((entry) => !existingApprovalIds.has(entry.approvalId));
    if (freshEntries.length === 0) return current;
    return {
      ...current,
      appServerApprovalResponseQueue: [...existingQueue, ...freshEntries],
    };
  });
  return (Array.isArray(updatedRun?.appServerApprovalResponseQueue)
    ? updatedRun.appServerApprovalResponseQueue
    : [])
    .filter((entry) => entries.some((candidate) => candidate.id === entry.id));
}

export async function executePrivilegedInstallAutoBatch(sessionId, run, batch, store, deps = {}) {
  const installAutoOps = getInstallAutoOps(batch);
  if (installAutoOps.length === 0) {
    return { changed: false, resolved: null, execResults: [], queuedApprovals: [] };
  }
  const loadSigningKeys = typeof deps.loadSigningKeys === 'function'
    ? deps.loadSigningKeys
    : loadOrCreatePrivilegedSigningKeys;

  const resolved = await resolvePrivilegedInstallAutoApproval({
    batchId: batch.batchId,
    batch,
  }, store);

  const eventsAfterResponse = await store.readEvents();
  const execResults = [];
  const missingResultOps = [];
  for (const op of installAutoOps) {
    const existingResult = findPrivilegedExecResultForOp(eventsAfterResponse, op.opId);
    if (existingResult) {
      execResults.push(existingResult);
    } else {
      missingResultOps.push(op);
    }
  }

  const runtimeBlock = getPrivilegedExecutorRuntimeBlock(run, 'install-auto privileged execution');
  let preflightError = null;
  if (runtimeBlock) {
    preflightError = new Error(runtimeBlock);
    preflightError.installAutoErrorMessage = runtimeBlock;
  }
  if (missingResultOps.length > 0 && !preflightError) {
    try {
      await loadSigningKeys();
    } catch (error) {
      preflightError = error;
      console.error(`[privileged] load signing key for install-auto batch ${batch.batchId}: ${error?.message || error}`);
    }
  }

  for (const op of missingResultOps) {
    const stored = await executeInstallAutoOpAsStoredEvent(sessionId, run, batch, op, store, preflightError, deps);
    if (stored) execResults.push(stored);
  }

  const queuedApprovals = await enqueuePrivilegedCategoryApprovalResponses(
    run.id,
    batch.batchId,
    CATEGORY_INSTALL,
    resolved,
    execResults,
  );

  return {
    changed: resolved?.duplicate !== true || missingResultOps.length > 0 || queuedApprovals.length > 0,
    resolved,
    execResults,
    queuedApprovals,
  };
}

async function denyPrivilegedBatchCategories(run, batch, store, categories) {
  let changed = false;
  for (const [category, ops] of categories) {
    if (!Array.isArray(ops) || ops.length === 0) continue;
    const resolved = await resolvePrivilegedCategoryApproval({
      batchId: batch.batchId,
      category,
      checkedOpIds: [],
    }, store, { source: 'agentoc_auto_policy' });
    const queued = await enqueuePrivilegedCategoryApprovalResponses(
      run.id, batch.batchId, category, resolved, [], '', { decisionSource: 'policy' },
    );
    if (!resolved.duplicate || queued.length > 0) changed = true;
  }
  return changed;
}

// Phase 4 — other/delete with a human WebAuthn proof runs through the
// privileged executor as root (design §5.6). Mirrors the install-auto batch:
// resolve the approved subset → verify the proof covers exactly this subset →
// execute each approved op with a passkey-mode token → enqueue the responses.
// Fails closed: no proof, or a proof whose manifestHash does not equal the
// approved subset hash, rejects the whole submission — nothing executes on a
// bad passkey.
export async function executePrivilegedPasskeyBatch(sessionId, run, batch, category, store, options = {}, deps = {}) {
  const normalizedCategory = trimString(category);
  const temporaryApproval = temporaryApprovalDelegation(options.approvalActor, 'approval.privileged.resolve');
  const resolved = await resolvePrivilegedCategoryApproval({
    batchId: trimString(batch?.batchId),
    category: normalizedCategory,
    checkedOpIds: Array.isArray(options.checkedOpIds) ? options.checkedOpIds : [],
  }, store, { source: temporaryApproval?.source || trimString(options.source) || undefined,
    temporaryControlGrantId: temporaryApproval?.grantId || '',
    assertAuthorization: () => temporaryApprovalDelegation(options.approvalActor, 'approval.privileged.resolve') });

  const requestId = trimString(options.requestId);
  let proof = options.webauthnProof && typeof options.webauthnProof === 'object'
    ? options.webauthnProof
    : null;

  // Browser callers submit the assertion returned by navigator.credentials.
  // Verify it here to mint the one-shot proof consumed below; internal callers
  // may still provide that already-issued proof directly.
  if (proof && !trimString(proof.token) && proof.response) {
    const verifyAssertion = typeof deps.verifyOwnerWebAuthnAssertion === 'function'
      ? deps.verifyOwnerWebAuthnAssertion
      : verifyOwnerWebAuthnAssertion;
    const verified = await verifyAssertion(proof);
    proof = {
      ...proof,
      ...(verified?.proof || {}),
      ...(verified?.credentialId ? { credentialId: verified.credentialId } : {}),
    };
  }

  const eventsAfterResponse = await store.readEvents();
  const execResults = [];
  const missingResultOps = [];
  for (const op of Array.isArray(resolved.approved) ? resolved.approved : []) {
    const existingResult = findPrivilegedExecResultForOp(eventsAfterResponse, op.opId);
    if (existingResult) execResults.push(existingResult);
    else missingResultOps.push(op);
  }

  // Idempotent replay: when every approved op already has a stored exec result
  // (a network retry of an executed submission), the WebAuthn proof was already
  // consumed on the first run — reuse the results without re-verifying. Only a
  // NEW execution needs the human proof. With the owner-click policy the proof
  // layer is skipped entirely; the token still binds the exact checked subset
  // via resolved.manifestHash, so the signing gate's subset check stays intact.
  const passkeyRequired = isOwnerHostPasskeyRequired();
  if (missingResultOps.length > 0 && passkeyRequired && !temporaryApproval) {
    const proofValid = Boolean(proof)
      && await consumeOwnerWebAuthnProof({
        token: trimString(proof?.token),
        purpose: PRIVILEGED_PASSKEY_APPROVAL_PURPOSE,
        sessionId,
        requestId,
        manifestHash: resolved.manifestHash,
      });
    if (!proofValid) {
      const error = new Error('Passkey approval is required for this category (WebAuthn proof over the batch subset)');
      error.code = 'PRIVILEGED_PASSKEY_REQUIRED';
      throw error;
    }
  }
  const credentialId = trimString(proof?.credentialId);
  const signedManifestHash = passkeyRequired && !temporaryApproval
    ? trimString(proof?.signedManifestHash)
    : resolved.manifestHash;

  const runtimeBlock = getPrivilegedExecutorRuntimeBlock(run, 'passkey privileged execution', { allowCodex: true });
  let preflightError = null;
  if (runtimeBlock) {
    preflightError = new Error(runtimeBlock);
    preflightError.passkeyErrorMessage = runtimeBlock;
  }
  if (missingResultOps.length > 0 && !preflightError) {
    try {
      const loadSigningKeys = typeof deps.loadSigningKeys === 'function'
        ? deps.loadSigningKeys
        : loadOrCreatePrivilegedSigningKeys;
      await loadSigningKeys();
    } catch (error) {
      preflightError = error;
      console.error(`[privileged] load signing key for passkey batch ${batch.batchId}: ${error?.message || error}`);
    }
  }

  for (const op of missingResultOps) {
    temporaryApprovalDelegation(options.approvalActor, 'approval.privileged.resolve');
    const stored = await executePasskeyOpAsStoredEvent(
      sessionId,
      run,
      batch,
      normalizedCategory,
      op,
      store,
      preflightError,
      {
        ...deps,
        webauthnCredentialId: credentialId,
        signedManifestHash,
        batchManifestHash: resolved.manifestHash,
        temporaryControlExpiresAt: temporaryApproval?.expiresAt,
        assertAuthorization: () => temporaryApprovalDelegation(options.approvalActor, 'approval.privileged.resolve'),
      },
    );
    if (stored) execResults.push(stored);
  }

  const queuedApprovals = await enqueuePrivilegedCategoryApprovalResponses(
    run.id,
    batch.batchId,
    normalizedCategory,
    resolved,
    execResults,
    requestId,
    { decisionSource: 'owner' },
  );

  return {
    changed: resolved?.duplicate !== true || missingResultOps.length > 0 || queuedApprovals.length > 0,
    resolved,
    execResults,
    queuedApprovals,
  };
}

async function executePasskeyOpAsStoredEvent(sessionId, run, batch, category, op, store, preflightError = null, deps = {}) {
  const batchId = trimString(batch?.batchId);
  // This pre-Phase-2B category bridge may only be exercised by an explicit
  // compatibility injection. Production execution must use the approved-action
  // route so facts, durable grants, and revalidation are present.
  const executeOpAsEvent = typeof deps.executeOpAsEvent === 'function'
    ? deps.executeOpAsEvent
    : null;
  let event = null;
  if (!preflightError && !executeOpAsEvent) {
    preflightError = new Error('legacy passkey execution is disabled until it is routed through the Phase 2B approved-action policy gate');
    preflightError.passkeyErrorMessage = preflightError.message;
  }
  if (preflightError) {
    event = privilegedExecResultEvent({
      opId: trimString(op?.opId),
      category,
      error: trimString(preflightError?.passkeyErrorMessage)
        || `Signing key load failed: ${preflightError?.message || preflightError}`,
    });
  } else {
    deps.assertAuthorization?.();
    try {
      event = await executeOpAsEvent(
        { ...op, batchManifestHash: trimString(deps.batchManifestHash) },
        {
          sessionId,
          runId: run?.id,
          turnId: trimString(batch?.turnId),
          authMode: isOwnerHostPasskeyRequired() ? PRIVILEGED_TOKEN_AUTH_MODE_PASSKEY : PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK,
          webauthnCredentialId: trimString(deps.webauthnCredentialId),
          signedManifestHash: trimString(deps.signedManifestHash),
          ...(deps.temporaryControlExpiresAt ? { temporaryControlExpiresAt: deps.temporaryControlExpiresAt } : {}),
          auditLabel: trimString(op?.description) || trimString(op?.command).slice(0, 300),
        },
      );
    } catch (error) {
      event = privilegedExecResultEvent({
        opId: trimString(op?.opId),
        category,
        error: error?.message || String(error),
      });
    }
  }
  if (!event) return null;
  return store.appendEvent({
    ...event,
    ...(batchId ? { batchId } : {}),
    runId: run?.id,
  });
}

// Private MCP ingress for the approved action channel. The MCP process only
// carries a run-scoped bearer token; this function re-binds every request to
// the current run manifest before the durable store sees it.
async function proposeApprovedActionsUnlocked({
  token = '',
  tokenMatches,
  requestKey = '',
  actions = [],
  sessionId = '',
  runId = '',
  turnId = '',
  cwd = '',
  projectRoot = '',
  autoInstallPreflight = false,
  autoInstallStatusOnly = false,
  autoInstallUserAuthorization = false,
  autoInstallUserClaim = false,
  autoInstallUserFinish = false,
  autoInstallUserCheck = false,
  userInstallCapability = null,
  userInstallResult = null,
} = {}) {
  const normalizedRunId = trimString(runId);
  if (!normalizedRunId) {
    const error = new Error('runId is required');
    error.code = 'APPROVED_ACTION_RUN_NOT_FOUND';
    throw error;
  }
  const run = await getRun(normalizedRunId);
  if (!run) {
    const error = new Error('Run not found');
    error.code = 'APPROVED_ACTION_RUN_NOT_FOUND';
    throw error;
  }
  const manifest = await getRunManifest(normalizedRunId);
  const session = await getSession(run.sessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.code = 'APPROVED_ACTION_SESSION_NOT_FOUND';
    throw error;
  }
  if (isTerminalRunState(run.state)) {
    const error = new Error('Run is no longer active');
    error.code = 'APPROVED_ACTION_RUN_TERMINAL';
    throw error;
  }
  const binding = manifest?.options?.approvedActionChannel;
  const sameSession = !!trimString(sessionId)
    && trimString(sessionId) === trimString(run.sessionId)
    && trimString(manifest?.sessionId) === trimString(run.sessionId);
  const sameTurn = !!trimString(turnId)
    && !!trimString(binding?.turnId)
    && trimString(turnId) === trimString(binding.turnId);
  if (!binding?.tokenHash || typeof tokenMatches !== 'function' || !tokenMatches(token, binding.tokenHash)) {
    const error = new Error('Approved action channel token is invalid');
    error.code = 'APPROVED_ACTION_TOKEN_INVALID';
    throw error;
  }
  if (!sameSession || !sameTurn) {
    const error = new Error('Approved action channel binding does not match this run');
    error.code = 'APPROVED_ACTION_BINDING_MISMATCH';
    throw error;
  }
  if (!isPrivilegeRoutingEnabled(session)) {
    const error = new Error('Approved action policy is disabled for this session');
    error.code = 'APPROVED_ACTION_POLICY_DISABLED';
    throw error;
  }

  const verifiedOwnerDevice = process.platform === 'win32' && binding?.authenticatedPrincipalKind === 'trusted_device' &&
    Boolean(binding.windowsOwnerDevice) && await validateWindowsOwnerDevice(binding.windowsOwnerDevice);
  if (process.platform === 'win32' && binding?.windowsOwnerDevice && !verifiedOwnerDevice) {
    throw Object.assign(new Error('The paired owner device is no longer authorized for this run'), { code: 'OWNER_DEVICE_AUTHORITY_REVOKED' });
  }

  const productActions = (Array.isArray(actions) ? actions : []).filter(isAgentCreateApprovedAction);
  if (productActions.length > 0) {
    if (!isAgentCreateApprovedActionEnabled()
      || binding?.productAgentCreate !== true
      || !isAgentCreateSessionEligible(session)
      || trimString(binding?.authenticatedPrincipalKind) !== 'owner') {
      const error = new Error('Managed Agent creation is not authorized for this session and run');
      error.code = 'AGENT_CREATE_NOT_AUTHORIZED';
      throw error;
    }
    if (productActions.length !== 1 || productActions.length !== (Array.isArray(actions) ? actions.length : 0)) {
      const error = new Error('Agent creation must be proposed as one exact product operation');
      error.code = 'AGENT_CREATE_BATCH_INVALID';
      throw error;
    }
  }

  // cwd/projectRoot are run facts. The MCP payload may carry those fields for
  // context, but it cannot choose the resource scope used for approval.
  const { cwd: trustedCwd, projectRoot: trustedProjectRoot } = resolveApprovedActionRunDirectories({ run, manifest, session });
  const trustedHome = TRUSTED_SERVER_HOME;
  const trustedTurnId = trimString(turnId) || trimString(binding?.turnId) || trimString(manifest?.turnId) || `turn:${run.requestId || normalizedRunId}`;
  const serverActions = (Array.isArray(actions) ? actions : []).map((input) => {
    const { cwd: _callerCwd, projectRoot: _callerProjectRoot, semanticProjection: _callerSemantic, ...rest } = input || {};
    return rest;
  });
  const riskMode = resolveSessionRiskMode(session);
  const userModes = [autoInstallUserAuthorization, autoInstallUserClaim, autoInstallUserFinish, autoInstallUserCheck].filter((value) => value === true).length;
  if (userModes > 1 || (userModes && (autoInstallPreflight === true || autoInstallStatusOnly === true))) {
    throw Object.assign(new Error('Conflicting installation request modes'), { code: 'AUTO_INSTALL_REQUEST_INVALID' });
  }
  if (autoInstallStatusOnly === true) {
    if (process.platform === 'win32' && serverActions.length === 1) {
      const action = buildOptionalApprovedAction(serverActions[0], { requestKey: trimString(requestKey), sessionId: run.sessionId,
        runId: normalizedRunId, turnId: trustedTurnId, cwd: trustedCwd, projectRoot: trustedProjectRoot, home: trustedHome, platform: 'win32' });
      const status = action && await queryWindowsServiceProposalFromCommand({ action, authenticatedPrincipalKind: binding.authenticatedPrincipalKind, verifiedOwnerDevice,
        trustedContext: { cwd: trustedCwd, projectRoot: trustedProjectRoot, home: trustedHome }, client: createWindowsPrivilegedBrokerClient() });
      if (status) return { ...status, kind: 'windows_service_control', requestKey: trimString(requestKey) };
    }
    const status = await getWindowsManagedAutoInstallStatus({ binding: { sessionId: run.sessionId, runId: normalizedRunId,
      turnId: trustedTurnId, requestKey: trimString(requestKey), authenticatedPrincipalKind: binding.authenticatedPrincipalKind, verifiedOwnerDevice } });
    return { ...status, kind: 'automatic_install' };
  }
  const assertInstallActive = async () => {
    const latestRun = await getRun(normalizedRunId);
    const latestSession = await getSession(run.sessionId);
    if (!latestRun || isTerminalRunState(latestRun.state) || latestRun.cancelRequested === true || !latestSession || resolveSessionRiskMode(latestSession) !== riskMode
        || (run.windowsExecutionSid && latestRun.windowsExecutionSid !== run.windowsExecutionSid)
        || (typeof run.windowsExecutionIsService === 'boolean' && latestRun.windowsExecutionIsService !== run.windowsExecutionIsService)
        || (binding?.windowsOwnerDevice && !await validateWindowsOwnerDevice(binding.windowsOwnerDevice))) {
      const error = new Error('Run or permission policy changed before installation');
      error.code = 'AUTO_INSTALL_RUN_CHANGED';
      throw error;
    }
  };
  const userInstallBinding = { sessionId: run.sessionId, runId: normalizedRunId, turnId: trustedTurnId, requestKey: trimString(requestKey) };
  if (autoInstallUserClaim === true || autoInstallUserFinish === true || autoInstallUserCheck === true) {
    const pinned = binding?.windowsUserInstallIdentity;
    const validationNow = autoInstallUserFinish === true ? Date.parse(userInstallCapability?.issuedAt || '') + 1 : Date.now();
    if ((binding?.authenticatedPrincipalKind !== 'owner' && !verifiedOwnerDevice) || !['recommended', 'full-auto'].includes(riskMode)
        || !Number.isFinite(validationNow)
        || !verifyWindowsManagedUserInstallAuthorization({ authorization: { capability: userInstallCapability, expectedExecutionSid: run.windowsExecutionSid },
          pinnedIdentity: pinned, binding: userInstallBinding, runExecutionSid: run.windowsExecutionSid, now: validationNow })) {
      throw Object.assign(new Error('User installation authorization is invalid'), { code: 'USER_INSTALL_AUTHORIZATION_INVALID' });
    }
    if (autoInstallUserFinish !== true) await assertInstallActive();
    const store = createWindowsUserInstallStore();
    if (autoInstallUserCheck === true) return { kind: 'automatic_user_install_check', ok: true };
    if (autoInstallUserClaim === true) {
      const result = await store.claim({ binding: userInstallBinding, nonce: userInstallCapability.nonce, operationFingerprint: windowsUserInstallOperationFingerprint(userInstallCapability) });
      return { kind: 'automatic_user_install_claim', ...result };
    }
    await store.finish({ binding: userInstallBinding, nonce: userInstallCapability.nonce, status: userInstallResult?.status, code: userInstallResult?.code || '' });
    return { kind: 'automatic_user_install_finish', ok: true };
  }
  const prepareUserAuthorization = async () => {
    const pinned = binding?.windowsUserInstallIdentity;
    if (!pinned?.kid || !pinned?.publicKey) return null;
    const authorization = await prepareWindowsManagedUserInstall({
      actions: serverActions, riskMode, runExecutionSid: run.windowsExecutionSid, runExecutionIsService: run.windowsExecutionIsService,
      binding: { ...userInstallBinding, authenticatedPrincipalKind: binding.authenticatedPrincipalKind, verifiedOwnerDevice },
      trustedContext: { cwd: trustedCwd, projectRoot: trustedProjectRoot, home: trustedHome },
    }, { assertActive: assertInstallActive });
    if (!verifyWindowsManagedUserInstallAuthorization({ authorization, pinnedIdentity: pinned,
      binding: userInstallBinding, runExecutionSid: run.windowsExecutionSid })) return null;
    return authorization;
  };
  if (autoInstallUserAuthorization === true) {
    if (!binding?.windowsUserInstallIdentity?.kid || !binding?.windowsUserInstallIdentity?.publicKey) throw Object.assign(new Error('User installation identity is unavailable'), { code: 'USER_INSTALL_IDENTITY_UNAVAILABLE' });
    const authorization = await prepareUserAuthorization();
    if (!authorization) throw Object.assign(new Error('User installation authorization is unavailable'), { code: 'USER_INSTALL_AUTHORIZATION_UNAVAILABLE' });
    return { kind: 'automatic_user_install_authorization', capability: authorization.capability };
  }
  const automaticInstall = await tryWindowsManagedAutoInstall({
    actions: serverActions, riskMode, runExecutionIsService: run.windowsExecutionIsService, preflight: autoInstallPreflight === true,
    binding: { sessionId: run.sessionId, runId: normalizedRunId, turnId: trustedTurnId, requestKey: trimString(requestKey), authenticatedPrincipalKind: binding.authenticatedPrincipalKind, verifiedOwnerDevice },
    trustedContext: { cwd: trustedCwd, projectRoot: trustedProjectRoot, home: trustedHome },
  }, { assertActive: assertInstallActive });
  if (autoInstallPreflight === true) {
    if (automaticInstall?.ready === true) return { kind: 'automatic_install_preflight', ready: true };
    return { kind: 'automatic_install_preflight', ready: Boolean(await prepareUserAuthorization()) };
  }
  if (automaticInstall) return { ...automaticInstall, kind: 'automatic_install' };
  const userAuthorization = await prepareUserAuthorization();
  if (userAuthorization) return { kind: 'automatic_user_install_authorization', capability: userAuthorization.capability };
  const preliminaryActions = serverActions.map((input) => buildApprovedAction(input, {
    requestKey: trimString(requestKey),
    sessionId: run.sessionId,
    runId: normalizedRunId,
    turnId: trustedTurnId,
    cwd: trustedCwd,
    projectRoot: trustedProjectRoot,
    home: trustedHome,
  }));
  // Resolve each agent.create tool binding once at proposal and thread the
  // server-computed fingerprint into the projection so the approved runtime
  // binding can be revalidated at execution time.
  const agentCreateRegistryByActionId = new Map();
  await Promise.all(preliminaryActions
    .filter(isAgentCreateApprovedAction)
    .map(async (action) => {
      const registry = await validateAgentCreatePayloadRegistries(action.agentPayload, {
        getToolDefinitionImpl: getToolDefinitionAsync,
      });
      agentCreateRegistryByActionId.set(action.actionId, registry);
    }));
  const semanticProjections = await Promise.all(preliminaryActions.map((action) => (
    isAgentCreateApprovedAction(action)
      ? prepareAgentCreateSemanticProjection({
          action,
          trustedContext: {
            session,
            run,
            manifest,
            platform: process.platform,
            toolFingerprint: trimString(agentCreateRegistryByActionId.get(action.actionId)?.toolFingerprint),
          },
        })
      : prepareApprovedActionSemanticProjection({
          action,
          trustedContext: {
            cwd: trustedCwd,
            projectRoot: trustedProjectRoot,
            home: trustedHome,
            platform: process.platform,
          },
        })
  )));

  // `approved-actions` is an owner-approval channel, not a generic command
  // dispatch path. The server must only publish complete, server-derived ASK
  // operations here. In particular, do not turn an ALLOW into a second,
  // broader authorization path or let a DENY reach a clickable client card.
  // The executor retains its independent capability/policy checks.
  for (let index = 0; index < preliminaryActions.length; index += 1) {
    const action = preliminaryActions[index];
    const projection = semanticProjections[index];
    const projectedAction = {
      ...action,
      semanticProjection: projection,
      semanticManifestHash: trimString(projection?.semanticManifestHash),
    };
    const decisions = Array.isArray(projection?.decisions) ? projection.decisions : [];
    const completeAskSet = decisions.length > 0
      && trimString(projection?.decision) === 'ASK'
      && decisions.every((entry) => (
        entry?.decision === 'ASK'
        && trimString(entry?.operationId)
        && entry?.operation
        && trimString(entry?.operationManifestHash)
        && trimString(entry?.resolverSnapshotIdentity)
      ));
    if (!isApprovedActionSemanticProjectionIntact(projectedAction) || !completeAskSet) {
      const hasDeny = trimString(projection?.decision) === 'DENY'
        || decisions.some((entry) => entry?.decision === 'DENY');
      const hasAllow = trimString(projection?.decision) === 'ALLOW'
        || decisions.some((entry) => entry?.decision === 'ALLOW');
      const error = new Error(hasDeny
        ? 'This operation is denied by the server policy and cannot be approved.'
        : hasAllow
          ? 'This operation does not require owner approval.'
          : 'This operation could not be verified for owner approval.');
      error.code = hasDeny
        ? 'APPROVED_ACTION_PROPOSAL_DENIED'
        : hasAllow
          ? 'APPROVED_ACTION_PROPOSAL_NOT_REQUIRED'
          : 'APPROVED_ACTION_PROPOSAL_POLICY_INVALID';
      throw error;
    }
  }

  // This channel contains only semantic ASK operations. Unattended profiles
  // cannot turn an ASK into an implicit grant, and must not leave the Run
  // paused waiting for a person who will never be prompted.
  const permissionProfile = resolveSessionRiskMode(session);
  if (permissionProfile === 'full-auto' || permissionProfile === 'conservative-auto') {
    for (let index = 0; index < preliminaryActions.length; index += 1) {
      await appendEvent(run.sessionId, buildApprovedActionAuditEvent({
        ...preliminaryActions[index],
        semanticManifestHash: trimString(semanticProjections[index]?.semanticManifestHash),
      }, 'auto_denied', { policyProfile: permissionProfile, decision: 'denied' }));
    }
    const error = new Error(`The ${permissionProfile} policy automatically denied this owner-approval action`);
    error.code = 'APPROVED_ACTION_AUTO_DENIED';
    error.statusCode = 403;
    throw error;
  }

  // A service request uses the enrolled device's exact-operation signature.
  // Keep the tool call alive while the phone reviews it, so the run remains
  // active and there is one owner decision instead of two separate prompts.
  if (process.platform === 'win32' && preliminaryActions.length === 1 &&
      semanticProjections[0]?.decisions?.length === 1 &&
      semanticProjections[0].decisions[0]?.operation?.target?.kind === 'windows_service') {
    const key = await loadWindowsAutoInstallSigningKey();
    if (!key?.kid || !key.privateKey) {
      throw Object.assign(new Error('Windows service broker signing identity is unavailable'), { code: 'SERVICE_BROKER_NOT_READY' });
    }
    const client = createWindowsPrivilegedBrokerClient();
    const serviceOptions = {
      action: preliminaryActions[0], projection: semanticProjections[0], riskMode,
      authenticatedPrincipalKind: binding?.authenticatedPrincipalKind,
      verifiedOwnerDevice,
      client, kid: key.kid, privateKey: key.privateKey, assertActive: assertInstallActive,
    };
    const proposal = await submitOrResumeWindowsServiceProposal(serviceOptions);
    const updateServiceActivity = async (status) => {
      const updated = await updateRun(normalizedRunId, (current) => {
        const existing = current.windowsServiceRequests && typeof current.windowsServiceRequests === 'object'
          ? current.windowsServiceRequests : {};
        if (isTerminalRunState(current.state) || current.cancelRequested === true) return current;
        if (status === null) {
          if (!existing[proposal.requestId]) return current;
          const next = { ...existing }; delete next[proposal.requestId];
          return { ...current, windowsServiceRequests: next };
        }
        if (!['awaiting_device', 'executing'].includes(status)) return current;
        const prior = existing[proposal.requestId];
        if (prior?.status === status) return current;
        return { ...current, windowsServiceRequests: { ...existing, [proposal.requestId]: {
          requestId: proposal.requestId, status, startedMs: prior?.startedMs || Date.now(), expiresMs: proposal.expiresMs,
        } } };
      });
      if (updated) broadcastSessionInvalidation(run.sessionId);
    };
    try {
      await updateServiceActivity(proposal.status).catch(() => {});
      const result = await waitWindowsServiceProposal({ ...serviceOptions, onStatus: updateServiceActivity });
      return { kind: 'windows_service_control', ...result, requestKey: trimString(requestKey), duplicate: proposal.duplicate === true };
    } finally {
      await updateServiceActivity(null).catch(() => {});
    }
  }

  const store = createApprovedActionStore({
    readEvents: async () => readApprovedActionEvents(run.sessionId),
    appendEvent: async (event) => appendEvent(run.sessionId, {
      ...event,
      runId: normalizedRunId,
      channel: 'approved_action',
    }),
    invalidate: async () => broadcastSessionInvalidation(run.sessionId),
  });
  const result = await store.propose(serverActions, {
    requestKey: trimString(requestKey),
    sessionId: run.sessionId,
    runId: normalizedRunId,
    turnId: trimString(turnId) || trimString(binding?.turnId) || trimString(manifest?.turnId) || `turn:${run.requestId || normalizedRunId}`,
    cwd: trustedCwd,
    projectRoot: trustedProjectRoot,
    home: trustedHome,
    semanticProjections,
  });
  const batch = result.batch;
  await updateRun(normalizedRunId, (current) => ({
    ...current,
    approvedActionPending: {
      batchId: batch.batchId,
      requestKey: batch.requestKey,
      actionIds: batch.actions.map((action) => action.actionId),
      state: 'waiting_user',
      createdAt: batch.createdAt,
      expiresAt: batch.actions
        .map((action) => Date.parse(action.expiresAt || ''))
        .filter(Number.isFinite)
        .sort((left, right) => left - right)
        .map((value) => new Date(value).toISOString())[0] || '',
    },
    actionPause: {
      kind: 'approved_action',
      batchId: batch.batchId,
      state: 'waiting_user',
    },
  }));
  return {
    status: 'awaiting_approval',
    duplicate: result.duplicate === true,
    batchId: batch.batchId,
    actions: batch.actions.map((action) => ({
      actionId: action.actionId,
      description: action.originalRequest?.description || '',
      summary: action.reviewSummary || '',
      category: action.category,
      executionClass: action.executionClass,
      risk: action.risk?.tier || '',
      needsPasskey: action.needsPasskey === true,
    })),
  };
}

export async function proposeApprovedActions(options = {}) {
  return dispatchApprovedActionProposal(options, { queue: approvedActionProposalQueue, execute: proposeApprovedActionsUnlocked });
}

function createApprovedActionSessionStore(run) {
  return createApprovedActionStore({
    readEvents: async () => readApprovedActionEvents(run.sessionId),
    appendEvent: async (event) => appendEvent(run.sessionId, {
      ...event,
      runId: run.id,
      channel: 'approved_action',
    }),
    invalidate: async () => broadcastSessionInvalidation(run.sessionId),
  });
}

function approvedActionClientAction(action) {
  return createApprovedActionClientProjection(action);
}

function permissionTargetFlagsForFacts(facts = {}) {
  const sources = [facts?.resource, facts?.selection]
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  return {
    recursive: sources.some((value) => value.recursive === true),
    force: sources.some((value) => value.force === true || value.forced === true),
    exact: sources.some((value) => value.exact === true),
  };
}

function approvedActionPermissionMode() {
  // A host approved-action is an explicit owner checkpoint. Keep its grant
  // envelope on the bounded STANDARD profile; FULL_AUTONOMY is a separate
  // product mode and must not silently widen a passkey approval.
  return PERMISSION_MODES.STANDARD;
}

async function buildApprovedActionCapabilityAuthorization(action, {
  credentialId = '',
  selectionManifestHash = '',
  approvalAudit = null,
  now = Date.now(),
} = {}) {
  const projection = action?.semanticProjection;
  const decisions = Array.isArray(projection?.decisions) ? projection.decisions : [];
  if (!['host', 'product'].includes(trimString(action?.executionClass)) || decisions.length === 0) {
    const error = new Error('capability-backed approved action has no server semantic decisions');
    error.code = 'APPROVED_ACTION_CAPABILITY_FACTS_REQUIRED';
    throw error;
  }
  const activeKey = getActivePrivilegedSigningKey();
  if (!activeKey) {
    const error = new Error('capability signing key is unavailable');
    error.code = 'APPROVED_ACTION_CAPABILITY_SIGNING_KEY_REQUIRED';
    throw error;
  }
  const mode = approvedActionPermissionMode();
  const ordinaryTtlMs = approvedActionCapabilityTtlMs(action?.executionClass);
  const ttlMs = approvalAudit?.expiresAt === undefined ? ordinaryTtlMs
    : Math.min(ordinaryTtlMs, approvalAudit.expiresAt - now);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    const error = new Error('Temporary control approval expired before capability signing');
    error.code = 'TEMPORARY_CONTROL_APPROVAL_DENIED';
    throw error;
  }
  const factsProofs = {};
  const capabilities = [];
  for (const entry of decisions) {
    const operation = entry?.operation;
    const operationId = trimString(operation?.operationId);
    if (!operationId || entry?.decision !== 'ASK') {
      const error = new Error('only server ASK decisions may receive an approved-action capability');
      error.code = 'APPROVED_ACTION_CAPABILITY_POLICY_INVALID';
      throw error;
    }
    const facts = buildHostPermissionFacts({ ...entry, factsProof: undefined });
    const signedFacts = createPermissionFactsProof({
      operation,
      facts,
      privateKey: activeKey.privateKey,
      kid: activeKey.kid,
      now,
      ttlMs,
    });
    factsProofs[operationId] = signedFacts.proof;
    const operationActions = [operation.primaryAction, ...(Array.isArray(operation.effects) ? operation.effects : [])]
      .map((value) => trimString(value));
    const requiresStrongAuth = operationActions.some((value) => STRONG_AUTH_ACTIONS.includes(value));
    // The ordinary approved-action owner proof is not a strong-auth proof.
    // Until a distinct transaction-level strong-auth credential is carried into
    // this builder, do not mint a STRONG_OWNER grant by inference.
    if (requiresStrongAuth) {
      const error = new Error('strong authorization is required for this host action');
      error.code = 'APPROVED_ACTION_STRONG_AUTH_REQUIRED';
      throw error;
    }
    const authorizationClass = CAPABILITY_AUTHORIZATION_CLASSES.OWNER;
    const grant = createCapabilityGrant({
      mode,
      issuedAtTurn: trimString(action.turnId),
      issuedAt: new Date(now),
      ttlMs,
      usageMax: 1,
      authorizationClass,
      workload: {
        scope: CAPABILITY_WORKLOAD_SCOPES.ONE_OPERATION,
        sessionId: trimString(operation.requestBinding?.sessionId),
        runId: trimString(operation.requestBinding?.runId),
        turnId: trimString(operation.requestBinding?.turnId),
        operationId,
        turnBinding: 'provenance',
      },
      constraints: {
        action: operation.primaryAction,
        scope: facts.scope,
        resourceSnapshotIdentity: facts.resourceSnapshotIdentity,
        executionClass: facts.executionClass,
        impact: {
          reversible: facts.impact.reversible,
          containsSensitiveMaterial: facts.impact.containsSensitiveMaterial,
          containsGitMetadata: facts.impact.containsGitMetadata,
        },
        target: operation.target,
        targetFlags: permissionTargetFlagsForFacts(facts),
        resource: facts.resource,
        selection: facts.selection,
        effects: { subset: operation.effects },
      },
    });
    capabilities.push(createCapabilityGrantProof({
      grant,
      privateKey: activeKey.privateKey,
      kid: activeKey.kid,
      now,
      ttlMs,
    }));
  }
  const useNonces = Object.fromEntries(capabilities.map((grant) => [
    trimString(grant.grantId), randomBytes(24).toString('base64url'),
  ]));
  return {
    source: approvalAudit?.source || 'owner',
    approvedAt: new Date(now).toISOString(),
    credentialId: trimString(credentialId),
    ...(approvalAudit?.grantId ? { temporaryControlGrantId: approvalAudit.grantId } : {}),
    ...(approvalAudit?.expiresAt ? { temporaryControlExpiresAt: approvalAudit.expiresAt } : {}),
    ...(selectionManifestHash ? { selectionManifestHash } : {}),
    permissionMode: mode,
    factsProofs,
    capabilities,
    useNonces,
  };
}

function temporaryApprovalDelegation(actor, operation) {
  if (!actor) return null;
  if (!isTemporaryControlApprovalActor(actor, operation)) {
    const error = new Error('Temporary control approval authority is invalid for this operation');
    error.code = 'TEMPORARY_CONTROL_APPROVAL_DENIED';
    throw error;
  }
  const audit = temporaryControlApprovalAudit(actor);
  if (!audit) {
    const error = new Error('Temporary control approval authority expired');
    error.code = 'TEMPORARY_CONTROL_APPROVAL_DENIED';
    throw error;
  }
  return audit;
}

function approvedActionSelection(batch, selectedActionIds = []) {
  const ids = new Set((Array.isArray(selectedActionIds) ? selectedActionIds : [])
    .map((id) => trimString(id))
    .filter(Boolean));
  return (Array.isArray(batch?.actions) ? batch.actions : [])
    .filter((action) => ids.has(trimString(action?.actionId)));
}

async function getApprovedActionBatchForRun(runId, batchId) {
  const run = await getRun(trimString(runId));
  if (!run) {
    const error = new Error('Run not found');
    error.code = 'APPROVED_ACTION_RUN_NOT_FOUND';
    throw error;
  }
  const store = createApprovedActionSessionStore(run);
  const batch = await store.get(batchId);
  if (!batch) {
    const error = new Error('Approved action batch not found');
    error.code = 'APPROVED_ACTION_BATCH_NOT_FOUND';
    throw error;
  }
  if (trimString(batch.runId) !== trimString(run.id)) {
    const error = new Error('Approved action batch does not belong to this run');
    error.code = 'APPROVED_ACTION_BATCH_RUN_MISMATCH';
    throw error;
  }
  if (trimString(batch.sessionId) !== trimString(run.sessionId)) {
    const error = new Error('Approved action batch session binding does not match');
    error.code = 'APPROVED_ACTION_BATCH_SESSION_MISMATCH';
    throw error;
  }
  return { run, store, batch };
}

export async function createApprovedActionWebAuthnChallenge(runId, batchId, options = {}) {
  const { run, batch } = await getApprovedActionBatchForRun(runId, batchId);
  const session = await getSession(run.sessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.code = 'APPROVED_ACTION_SESSION_NOT_FOUND';
    throw error;
  }
  if (!isPrivilegeRoutingEnabled(session)) {
    const error = new Error('Approved action policy is disabled for this session');
    error.code = 'APPROVED_ACTION_POLICY_DISABLED';
    throw error;
  }
  const selected = approvedActionSelection(batch, options.selectedActionIds);
  if (selected.length === 0) {
    const error = new Error('At least one host action must be selected for WebAuthn approval');
    error.code = 'APPROVED_ACTION_EMPTY_SELECTION';
    throw error;
  }
  if (selected.some((action) => !isHostExecutionClass(action.executionClass))) {
    const error = new Error('Approved action WebAuthn selection contains a non-host action');
    error.code = 'APPROVED_ACTION_PASSKEY_SCOPE_INVALID';
    throw error;
  }
  const manifestHash = computeApprovedActionSelectionHash(selected);
  return createOwnerWebAuthnAssertionOptions(options.request || {}, {
    purpose: 'approved-action-approval',
    sessionId: run.sessionId,
    requestId: trimString(options.requestId) || trimString(batch.batchId),
    manifestHash,
  });
}

function buildApprovedActionContinuationText(batch) {
  const lines = (Array.isArray(batch?.actions) ? batch.actions : []).map((action) => {
    const result = action?.resultRef && typeof action.resultRef === 'object' ? action.resultRef : {};
    const status = action?.state === APPROVED_ACTION_STATE.COMPLETED ? 'completed'
      : action?.state === APPROVED_ACTION_STATE.DENIED ? 'denied'
        : action?.state === APPROVED_ACTION_STATE.FAILED ? 'failed' : action?.state;
    const details = [
      result.error ? `error=${result.error}` : '',
      result.exitCode !== null && result.exitCode !== undefined ? `exitCode=${result.exitCode}` : '',
      result.stdout ? `stdout=${result.stdout}` : '',
      result.stderr ? `stderr=${result.stderr}` : '',
    ].filter(Boolean).join('; ');
    return `- ${action.actionId}: ${status}${details ? ` (${details})` : ''}`;
  });
  return [
    `Approved action batch ${trimString(batch?.batchId)} has been resolved by the owner.`,
    'Continue the original task using these authoritative results; do not repeat an approved action unless the owner asks:',
    ...lines,
  ].join('\n');
}

async function queueApprovedActionContinuation(session, run, batch) {
  const requestId = `approved_action_resume_${trimString(batch.batchId)}`;
  const events = await readApprovedActionContinuationEvents(session.id, batch.batchId);
  const alreadyRecorded = events.some((event) => (
    event?.type === 'message'
    && event?.source === 'approved_action'
    && trimString(event?.batchId) === trimString(batch.batchId)
  ));
  if (!alreadyRecorded) {
    await appendEvent(session.id, messageEvent('assistant', buildApprovedActionContinuationText(batch), undefined, {
      source: 'approved_action',
      batchId: trimString(batch.batchId),
      runId: trimString(run.id),
      requestId,
    }));
  }
  return submitHttpMessage(session.id, buildApprovedActionContinuationText(batch), [], {
    requestId,
    responseId: requestId,
    queueIfBusy: true,
    recordUserMessage: false,
    internalOperation: 'approved_action_resume',
    skipSessionContinuation: true,
    sourceContext: {
      kind: 'approved_action_resume',
      batchId: trimString(batch.batchId),
      sourceRunId: trimString(run.id),
    },
  });
}

async function submitApprovedActionApprovalUnlocked(runId, batchId, options = {}) {
  const assertApproval = () => temporaryApprovalDelegation(options.approvalActor, 'approval.approved_action.resolve');
  const temporaryApproval = assertApproval();
  const { run, store, batch } = await getApprovedActionBatchForRun(runId, batchId);
  const session = await getSession(run.sessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.code = 'APPROVED_ACTION_SESSION_NOT_FOUND';
    throw error;
  }
  if (!isPrivilegeRoutingEnabled(session)) {
    const error = new Error('Approved action policy is disabled for this session');
    error.code = 'APPROVED_ACTION_POLICY_DISABLED';
    throw error;
  }

  const decisions = options.decisions && typeof options.decisions === 'object' && !Array.isArray(options.decisions)
    ? Object.fromEntries(Object.entries(options.decisions).map(([id, decision]) => [
      trimString(id), trimString(decision).toLowerCase(),
    ]).filter(([id]) => id))
    : {};
  const waiting = batch.actions.filter((action) => action.state === APPROVED_ACTION_STATE.WAITING_USER);
  if (waiting.length === 0) {
    return {
      duplicate: true,
      batch,
      actions: batch.actions.map(approvedActionClientAction),
      session,
      run,
      continuation: null,
    };
  }
  // Expired entries are resolved durably below without requiring a fresh
  // owner proof. Active entries still require complete decisions and any
  // host proof for the exact active selection.
  const pending = waiting.filter((action) => !isApprovedActionExpired(action));
  if (Object.keys(decisions).length === 0) {
    const error = new Error('Approval decisions must select at least one action or explicitly deny the batch');
    error.code = 'APPROVED_ACTION_EMPTY_SELECTION';
    throw error;
  }
  const unknownDecision = Object.keys(decisions).find((actionId) => !batch.actions.some((action) => action.actionId === actionId));
  if (unknownDecision) {
    const error = new Error(`Unknown approved action ${unknownDecision}`);
    error.code = 'APPROVED_ACTION_DECISION_INVALID';
    throw error;
  }
  const selected = pending.filter((action) => decisions[action.actionId] === 'approve');
  const selectedHost = selected.filter((action) => isHostExecutionClass(action.executionClass));
  const selectedProduct = selected.filter((action) => isProductExecutionClass(action.executionClass));
  if (selectedProduct.length > 0 && trimString(options.authenticatedPrincipalKind) !== 'owner' && !temporaryApproval) {
    const error = new Error('Only the ordinary owner session may approve persistent product changes');
    error.code = 'AGENT_CREATE_OWNER_REQUIRED';
    throw error;
  }
  const selectedCapabilityActions = selected.filter((action) => (
    isHostExecutionClass(action.executionClass) || isProductExecutionClass(action.executionClass)
  ));
  if (trimString(options.approvalIntent) === 'approve' && selectedCapabilityActions.length === 0) {
    const error = new Error('At least one action must be selected for approval');
    error.code = 'APPROVED_ACTION_EMPTY_SELECTION';
    throw error;
  }
  const selectionManifestHash = computeApprovedActionSelectionHash(selected);
  const hostSelectionManifestHash = computeApprovedActionSelectionHash(selectedHost);
  let credentialId = '';
  // Owner-click approvals (passkey policy off) authorize host actions with the
  // explicit owner decision alone; the WebAuthn assertion is only demanded when
  // the owner passkey checkpoint is enabled. Everything downstream (selection
  // hash, one-shot capability, executor revalidation, audit) is unchanged, and
  // the stored authorization honestly records an empty credentialId.
  if (selectedHost.length > 0 && isOwnerHostPasskeyRequired() && !temporaryApproval) {
    let proof = options.webauthnProof && typeof options.webauthnProof === 'object'
      ? options.webauthnProof
      : null;
    // Browser callers submit the assertion returned by navigator.credentials.
    // Verify it here and consume the resulting one-shot server proof; trusted
    // internal callers may still provide the already-issued proof directly.
    if (proof && !trimString(proof.token) && proof.response) {
      const verified = await verifyOwnerWebAuthnAssertion(proof);
      proof = {
        ...proof,
        ...(verified?.proof || {}),
        ...(verified?.credentialId ? { credentialId: verified.credentialId } : {}),
      };
    }
    const valid = await consumeOwnerWebAuthnProof({
      token: trimString(proof?.token),
      purpose: 'approved-action-approval',
      sessionId: run.sessionId,
      requestId: trimString(options.requestId) || trimString(batch.batchId),
      manifestHash: hostSelectionManifestHash,
    });
    if (!valid) {
      const error = new Error('Passkey approval is required for the selected host actions');
      error.code = 'APPROVED_ACTION_PASSKEY_REQUIRED';
      throw error;
    }
    credentialId = trimString(proof?.credentialId);
  }

  const authorizationByActionId = {};
  const capabilityGrantStore = openCapabilityGrantStore({ dir: CAPABILITY_GRANT_USAGE_DIR });
  if (selectedCapabilityActions.length > 0) {
    await loadOrCreatePrivilegedSigningKeys();
    for (const action of selectedCapabilityActions) {
      assertApproval();
      const authorizationMaterial = await buildApprovedActionCapabilityAuthorization(action, {
        credentialId,
        selectionManifestHash,
        approvalAudit: temporaryApproval,
        now: Date.now(),
      });
      assertApproval();
      const storedAuthorization = await capabilityGrantStore.putAuthorization({
        actionId: action.actionId,
        sessionId: run.sessionId,
        runId: run.id,
        turnId: batch.turnId,
        authorization: authorizationMaterial,
      });
      if (!storedAuthorization?.ok) {
        const error = new Error(storedAuthorization?.error || 'unable to persist approved-action capability authorization');
        error.code = storedAuthorization?.code || 'APPROVED_ACTION_CAPABILITY_STORE_FAILED';
        throw error;
      }
      authorizationByActionId[action.actionId] = {
        source: authorizationMaterial.source,
        approvedAt: authorizationMaterial.approvedAt,
        permissionMode: authorizationMaterial.permissionMode,
        ...(authorizationMaterial.selectionManifestHash ? { selectionManifestHash: authorizationMaterial.selectionManifestHash } : {}),
        capabilityRef: storedAuthorization.capabilityRef,
      };
    }
  }

  assertApproval();
  const resolved = await store.resolveBatch(batch.batchId, decisions, {
    source: temporaryApproval?.source || 'owner',
    assertAuthorization: assertApproval,
    selectionManifestHash,
    authorization: {
      source: 'owner',
      approvedAt: nowIso(),
      credentialId,
      ...(temporaryApproval?.grantId ? { temporaryControlGrantId: temporaryApproval.grantId } : {}),
      ...(selectionManifestHash ? { selectionManifestHash } : {}),
    },
    authorizationByActionId,
  });
  if (resolved.duplicate) {
    return {
      duplicate: true,
      batch: resolved.batch,
      actions: resolved.actions.map(approvedActionClientAction),
      session,
      run,
      continuation: null,
    };
  }

  try {
    for (const action of resolved.actions.filter((candidate) => candidate.state === APPROVED_ACTION_STATE.AUTHORIZED)) {
      assertApproval();
      const executing = await store.transition(action.actionId, APPROVED_ACTION_STATE.EXECUTING, {
        authorization: action.authorization,
      });
      let executionAuthorization = executing.authorization;
      if (trimString(executing.authorization?.capabilityRef)) {
        const storedAuthorization = await capabilityGrantStore.getAuthorization({
          capabilityRef: executing.authorization.capabilityRef,
          actionId: executing.actionId,
          sessionId: run.sessionId,
          runId: run.id,
          turnId: batch.turnId,
        });
        if (!storedAuthorization?.ok) {
          await store.transition(action.actionId, APPROVED_ACTION_STATE.FAILED, {
            authorization: executing.authorization,
            resultRef: { error: storedAuthorization?.error || 'approved-action capability authorization is unavailable' },
            reason: storedAuthorization?.error || 'approved-action capability authorization is unavailable',
          });
          continue;
        }
        executionAuthorization = storedAuthorization.authorization;
      }
      assertApproval();
      const result = await executeApprovedAction(executing, {
        sessionId: run.sessionId,
        runId: run.id,
        turnId: batch.turnId,
        authorization: executionAuthorization,
        mode: executionAuthorization?.permissionMode || PERMISSION_MODES.STANDARD,
        capabilities: executionAuthorization?.capabilities || null,
        factsProofs: executionAuthorization?.factsProofs || null,
        useNonces: executionAuthorization?.useNonces || null,
        grantStore: capabilityGrantStore,
      });
      await store.transition(
        action.actionId,
        result.ok ? APPROVED_ACTION_STATE.COMPLETED : APPROVED_ACTION_STATE.FAILED,
        {
          authorization: executing.authorization,
          resultRef: result.resultRef,
          reason: result.resultRef?.error || '',
        },
      );
    }
  } finally {
    capabilityGrantStore.close();
  }

  const finalBatch = await store.get(batch.batchId);
  const allTerminal = finalBatch?.actions?.every((action) => [
    APPROVED_ACTION_STATE.DENIED,
    APPROVED_ACTION_STATE.COMPLETED,
    APPROVED_ACTION_STATE.FAILED,
    APPROVED_ACTION_STATE.EXPIRED,
  ].includes(action.state));
  let continuation = null;
  let finalRun = await getRun(run.id) || run;
  if (allTerminal) {
    const wasPausedForApprovedAction = hasPendingApprovedActionPause(finalRun);
    finalRun = await updateRun(run.id, (current) => {
      const next = { ...current };
      delete next.approvedActionPending;
      delete next.actionPause;
      if (wasPausedForApprovedAction) {
        const result = current.result && typeof current.result === 'object'
          ? current.result
          : { completedAt: nowIso(), exitCode: 0, signal: null, synthesized: true };
        next.result = result;
        next.completedAt = current.completedAt || result.completedAt || nowIso();
        next.state = result.cancelled === true || result.error || Number(result.exitCode ?? 0) !== 0
          ? 'failed'
          : 'completed';
      }
      return next;
    }) || finalRun;
    if (wasPausedForApprovedAction) {
      await syncDetachedRun(run.sessionId, run.id);
      finalRun = await getRun(run.id) || finalRun;
      if (!isTerminalRunState(finalRun.state)) {
        await resumeHarnessRunBudget(finalRun);
      }
    }
    // Real `agentoc-privileged` shim: a waiting shim process consumes the
    // per-op results off the run record as soon as the batch is terminal.
    const shimResolveUpdate = buildPrivilegedShimResolveUpdate(finalRun, finalBatch);
    if (shimResolveUpdate) {
      finalRun = await updateRun(run.id, shimResolveUpdate) || finalRun;
    }
    continuation = await queueApprovedActionContinuation(session, finalRun, finalBatch);
  }
  broadcastSessionInvalidation(run.sessionId);
  return {
    duplicate: false,
    batch: finalBatch,
    actions: finalBatch.actions.map(approvedActionClientAction),
    session: await getSession(run.sessionId) || session,
    run: finalRun,
    continuation,
  };
}

export async function submitApprovedActionApproval(runId, batchId, options = {}) {
  return approvedActionResolutionQueue(
    `${trimString(runId)}:${trimString(batchId)}`,
    () => submitApprovedActionApprovalUnlocked(runId, batchId, options),
  );
}

async function reconcileTerminalAgyCredential(run, manifest) {
  if (!run?.id) return null;
  let reconciliation;
  try {
    const identity = await loadOrCreateInstanceIdentity();
    reconciliation = await reconcileAgyRunCredential({
      run,
      manifest,
      configDir: CONFIG_DIR,
      providerHomesRoot: dirname(AGY_MANAGED_HOME_DIR),
      registry: createNativeProviderRegistry({ configDir: CONFIG_DIR }),
      secretStore: createSecretStore({ configDir: CONFIG_DIR }),
      credentialLedger: createCredentialMutationLedger({ configDir: CONFIG_DIR }),
      sourceInstanceId: identity.instanceId,
    });
  } catch (error) {
    reconciliation = { ok: false, status: 'failed', reason: 'agy-refresh-reconcile-threw' };
    console.error(`[runs] AgY credential reconciliation failed for ${run.id}: ${error?.message || String(error)}`);
  }
  if (!reconciliation || reconciliation.status === 'not-applicable') return reconciliation;
  await updateRun(run.id, (current) => {
    const next = {
      status: reconciliation.status,
      ...(reconciliation.reason ? { reason: reconciliation.reason } : {}),
      ...(reconciliation.fingerprint ? { fingerprint: reconciliation.fingerprint } : {}),
      ...(Number.isSafeInteger(reconciliation.credentialVersion)
        ? { credentialVersion: reconciliation.credentialVersion }
        : {}),
    };
    if (JSON.stringify(current?.agyCredentialSync || null) === JSON.stringify(next)) return current;
    return { ...current, agyCredentialSync: next };
  }).catch((error) => {
    console.error(`[runs] Failed to persist AgY credential reconciliation for ${run.id}: ${error?.message || String(error)}`);
  });
  return reconciliation;
}

function isAgyRunManifest(manifest, run = null) {
  const tool = trimString(run?.tool || manifest?.tool);
  const runtimeFamily = trimString(run?.runtimeFamily || manifest?.runtimeFamily || manifest?.options?.runtimeFamily);
  return tool === 'agy' || runtimeFamily === 'agy-json' || runtimeFamily === 'agy-stream-json';
}

async function resolveAgyRunProviderId(run, manifest) {
  if (!isAgyRunManifest(manifest, run)) return '';
  const explicit = trimString(run?.agyProviderProfileId)
    || trimString(run?.providerProfile)
    || trimString(manifest?.options?.providerProfile);
  if (explicit) return explicit;
  const modelProvider = parseScopedCodexModel(trimString(run?.model || manifest?.options?.model)).providerId;
  if (modelProvider) return modelProvider;
  // The normal path usually carries an explicit binding. This fallback keeps
  // implicit/default AgY runs serialized as well; preparation later resolves
  // the concrete profile inside the runner HOME.
  return 'agy-default';
}

function resolveHarnessRunPriority(run) {
  if (run?.internalOperation || run?.isInternal === true) return 'background';
  const source = trimString(run?.source || run?.triggerSource || run?.origin).toLowerCase();
  return source.includes('connector') || source.includes('webhook') ? 'connector' : 'interactive';
}

function harnessPriorityWeight(priority) {
  return {
    interactive: 100,
    connector: 80,
    normal: 50,
    background: 10,
  }[trimString(priority).toLowerCase()] || 50;
}

function resolveHarnessBudgetProvider(run, manifest = null) {
  const tool = trimString(run?.tool || manifest?.tool).toLowerCase();
  if (tool) return tool;
  const family = trimString(run?.runtimeFamily || manifest?.runtimeFamily || manifest?.options?.runtimeFamily).toLowerCase();
  if (family) return family.split('-')[0];
  return 'unknown';
}

function scheduleAdaptiveRunDrain(delayMs = 0) {
  if (adaptiveRunDrainTimer) return;
  adaptiveRunDrainTimer = setTimeout(() => {
    adaptiveRunDrainTimer = null;
    void drainAdaptiveRunQueue();
  }, Math.max(0, Math.min(Number(delayMs) || 0, 60_000)));
  adaptiveRunDrainTimer.unref?.();
}

function acquireHarnessRunBudget(run, manifest = null) {
  if (harnessRunLeases.has(run.id)) return harnessRunLeases.get(run.id);
  const priority = resolveHarnessRunPriority(run);
  const globalLease = harnessRunBudget.tryAcquire({ priority });
  if (!globalLease) return null;
  const providerBudget = getAdaptiveHarnessBudget(resolveHarnessBudgetProvider(run, manifest));
  const providerLease = providerBudget.tryAcquire({ priority });
  if (!providerLease) {
    globalLease.release({ outcome: 'cancelled', durationMs: 0 });
    return null;
  }
  const leases = { global: globalLease, provider: providerLease };
  harnessRunLeases.set(run.id, leases);
  return leases;
}

function adoptHarnessRunBudget(run, manifest = null) {
  if (!run?.id || harnessRunLeases.has(run.id)) return true;
  const priority = resolveHarnessRunPriority(run);
  const globalLease = harnessRunBudget.adopt({ priority });
  const providerLease = getAdaptiveHarnessBudget(resolveHarnessBudgetProvider(run, manifest)).adopt({ priority });
  if (!globalLease || !providerLease) {
    globalLease?.release({ outcome: 'cancelled', durationMs: 0 });
    providerLease?.release({ outcome: 'cancelled', durationMs: 0 });
    return false;
  }
  harnessRunLeases.set(run.id, { global: globalLease, provider: providerLease });
  return true;
}

function harnessOutcomeForRun(run, fallback = 'success') {
  const state = trimString(run?.state).toLowerCase();
  if (['failed', 'error'].includes(state)) return 'error';
  if (['cancelled', 'canceled', 'stopped'].includes(state)) return 'cancelled';
  return fallback;
}

function releaseHarnessRunBudget(runId, { outcome = 'success', schedule = true } = {}) {
  adaptiveQueuedRunIds.delete(runId);
  yieldedRunLeaseIds.delete(runId);
  const lease = harnessRunLeases.get(runId);
  if (!lease) return false;
  harnessRunLeases.delete(runId);
  lease.provider?.release({ outcome });
  lease.global?.release({ outcome });
  if (schedule) scheduleAdaptiveRunDrain(0);
  return true;
}

function hasPendingRunApproval(run) {
  if (!run || typeof run !== 'object') return false;
  if (isTerminalRunState(run.state)) return false;
  const state = trimString(run.state).toLowerCase();
  if (state === 'waiting_user' || state === 'awaiting_approval' || state === 'waiting_approval') return true;
  if (run.privilegedBatchPending) return true;
  if (hasPendingApprovedActionPause(run)) return true;
  if (Array.isArray(run.appServerPendingApprovals)
    && run.appServerPendingApprovals.some((entry) => entry && entry.state !== 'responded')) {
    return true;
  }
  return false;
}

function yieldHarnessRunBudget(runId) {
  const normalizedRunId = trimString(runId);
  if (!normalizedRunId) return false;
  const lease = harnessRunLeases.get(normalizedRunId);
  if (!lease) return false;
  releaseHarnessRunBudget(normalizedRunId, { outcome: 'success', schedule: true });
  yieldedRunLeaseIds.add(normalizedRunId);
  return true;
}

async function resumeHarnessRunBudget(run, manifest = null) {
  if (!run?.id) return false;
  yieldedRunLeaseIds.delete(run.id);
  if (harnessRunLeases.has(run.id)) return true;
  return adoptHarnessRunBudget(run, manifest);
}

async function drainAdaptiveRunQueue() {
  if (adaptiveRunDrainBusy) return;
  adaptiveRunDrainBusy = true;
  try {
    // The process-local set is only a hint; use the durable Run index to
    // order it without opening every status.json.  A large adaptive queue is
    // drained in bounded windows so the 1s retry timer cannot create an I/O
    // storm while capacity is unavailable.
    const indexedQueued = await listRunIndexEntries({ state: 'queued' });
    const indexedIds = new Set(indexedQueued.map((entry) => entry.id));
    for (const runId of [...adaptiveQueuedRunIds]) {
      if (!indexedIds.has(runId)) adaptiveQueuedRunIds.delete(runId);
    }
    const selected = indexedQueued
      .filter((entry) => adaptiveQueuedRunIds.has(entry.id))
      .sort((left, right) => {
        const priorityDelta = harnessPriorityWeight(right.adaptiveQueue?.priority)
          - harnessPriorityWeight(left.adaptiveQueue?.priority);
        if (priorityDelta !== 0) return priorityDelta;
        return String(left.adaptiveQueue?.queuedAt || '')
          .localeCompare(String(right.adaptiveQueue?.queuedAt || ''));
      })
      .slice(0, MAX_ADAPTIVE_DRAIN_CANDIDATES);
    const candidates = (await mapWithBoundedConcurrency(selected, async (indexed) => {
      const run = await getRun(indexed.id).catch(() => null);
      if (!run || run.state !== 'queued' || run.adaptiveQueue?.reason !== 'adaptive_capacity') {
        adaptiveQueuedRunIds.delete(indexed.id);
        return null;
      }
      const manifest = await getRunManifest(indexed.id).catch(() => null);
      return manifest ? { run, manifest } : null;
    })).filter(Boolean);
    let blockedByAdaptiveCapacity = false;
    for (const { run, manifest } of candidates) {
      const result = await launchDetachedRunWithAgySlot(run.sessionId, run, manifest);
      if (result?.queued === true && result?.adaptiveCapacity === true) {
        blockedByAdaptiveCapacity = true;
        break;
      }
      if (result?.queued !== true) adaptiveQueuedRunIds.delete(run.id);
    }
    // A controller increase does not necessarily coincide with a lease
    // release. Poll only while a durable adaptive queue is blocked; the timer
    // is unref'd and is cancelled as soon as the queue drains.
    if (blockedByAdaptiveCapacity) scheduleAdaptiveRunDrain(1_000);
  } catch (error) {
    console.error(`[runs] adaptive launch drain failed: ${error?.message || error}`);
  } finally {
    adaptiveRunDrainBusy = false;
  }
}

async function releaseAgyRunSlot(runId, { schedule = true, outcome = 'success' } = {}) {
  const entry = agyRunLocks.get(runId);
  const releasedBudget = releaseHarnessRunBudget(runId, { schedule, outcome });
  if (!entry) return releasedBudget;
  agyRunLocks.delete(runId);
  await entry.lock.release().catch(() => {});
  if (schedule) {
    void launchNextQueuedAgyRun(entry.providerId);
    scheduleAdaptiveRunDrain(0);
  }
  return true;
}

function scheduleAgyQueueDrain(delayMs = AGY_QUEUE_DRAIN_RETRY_MS) {
  if (agyQueueDrainTimer) return;
  agyQueueDrainTimer = setTimeout(() => {
    agyQueueDrainTimer = null;
    void drainQueuedAgyRuns().catch((error) => {
      console.error(`[runs] queued AgY drain failed: ${error?.message || error}`);
    });
  }, Math.max(0, Number(delayMs) || 0));
  if (typeof agyQueueDrainTimer.unref === 'function') agyQueueDrainTimer.unref();
}

async function recoverAgyAccountLock(providerId, owner = null) {
  const normalizedProviderId = trimString(providerId);
  if (!normalizedProviderId) return false;
  const inFlight = agyLockRecoveryPromises.get(normalizedProviderId);
  if (inFlight) return inFlight;
  const promise = (async () => {
    const ownerRunId = trimString(owner?.runId);
    const ownerRun = ownerRunId ? await getRun(ownerRunId).catch(() => null) : null;
    if (!isRecoverableAgyAccountLockOwner(ownerRun, isTerminalRunState)) return false;
    const ownerProviderId = trimString(owner?.providerId);
    const released = await releaseAgyAccountLock(CONFIG_DIR, normalizedProviderId, {
      ...(ownerRunId ? { expectedRunId: ownerRunId } : {}),
      ...(ownerProviderId === normalizedProviderId ? { expectedProviderId: normalizedProviderId } : {}),
    });
    if (released) {
      console.info(`[runs] reclaimed stale AgY account lock for ${normalizedProviderId}${ownerRunId ? ` (owner ${ownerRunId})` : ''}`);
    }
    return released;
  })().finally(() => {
    if (agyLockRecoveryPromises.get(normalizedProviderId) === promise) {
      agyLockRecoveryPromises.delete(normalizedProviderId);
    }
  });
  agyLockRecoveryPromises.set(normalizedProviderId, promise);
  return promise;
}

async function acquireAgyRunSlot(run, manifest) {
  const providerId = await resolveAgyRunProviderId(run, manifest);
  if (!providerId) return { providerId: '', acquired: { ok: true } };
  const existing = agyRunLocks.get(run.id);
  let acquired = existing?.providerId === providerId
    ? { ok: true, adopted: true, existing: true, lock: existing.lock }
    : await acquireAgyAccountLock({
      configDir: CONFIG_DIR,
      providerId,
      runId: run.id,
    });
  if (!acquired.ok && acquired.reason === 'agy-account-busy') {
    const reclaimed = await recoverAgyAccountLock(providerId, acquired.owner);
    if (reclaimed) {
      acquired = await acquireAgyAccountLock({ configDir: CONFIG_DIR, providerId, runId: run.id });
    }
  }
  if (acquired.ok && !acquired.existing) {
    agyRunLocks.set(run.id, { providerId, lock: acquired });
  }
  return { providerId, acquired };
}

async function adoptAgyRunSlot(run, manifest) {
  const { acquired } = await acquireAgyRunSlot(run, manifest);
  if (!acquired.ok) return false;
  return true;
}

async function drainQueuedAgyRuns() {
  const indexedQueued = await listRunIndexEntries({ state: 'queued' });
  const providerIds = new Set();
  for (const indexed of indexedQueued.slice(0, MAX_AGY_QUEUE_DRAIN_CANDIDATES)) {
    const run = await getRun(indexed.id).catch(() => null);
    if (!run || run.state !== 'queued') continue;
    const manifest = await getRunManifest(run.id).catch(() => null);
    if (!isAgyRunManifest(manifest, run)) continue;
    const providerId = await resolveAgyRunProviderId(run, manifest);
    if (providerId) providerIds.add(providerId);
  }
  for (const providerId of providerIds) {
    await launchNextQueuedAgyRun(providerId);
  }
  if (providerIds.size > 0) scheduleAgyQueueDrain();
}

async function reclaimTerminalAgyAccountLocksAtStartup() {
  const locks = await listAgyAccountLocks({ configDir: CONFIG_DIR });
  for (const { owner } of locks) {
    const providerId = trimString(owner?.providerId);
    if (!providerId) continue;
    await recoverAgyAccountLock(providerId, owner);
  }
}

async function launchNextQueuedAgyRun(providerId) {
  const normalizedProviderId = trimString(providerId);
  if (!normalizedProviderId || agyLaunchesInFlight.has(normalizedProviderId)) return;
  agyLaunchesInFlight.add(normalizedProviderId);
  try {
    const candidates = [];
    for (const indexed of await listRunIndexEntries({
      state: 'queued',
      providerId: normalizedProviderId,
    })) {
      // The index is intentionally a hint: legacy entries may not yet carry
      // an AGY provider id, so hydrate the authoritative status before launch.
      const candidate = await getRun(indexed.id).catch(() => null);
      if (!candidate || candidate.state !== 'queued') continue;
      const manifest = await getRunManifest(indexed.id).catch(() => null);
      const queuedProvider = trimString(
        candidate.agyQueue?.providerId || candidate.agyProviderProfileId || candidate.providerProfile,
      );
      if (queuedProvider !== normalizedProviderId) continue;
      candidates.push({ candidate, manifest });
    }
    for (const { candidate, manifest } of sortAgyQueuedRuns(candidates)) {
      const started = await launchDetachedRunWithAgySlot(candidate.sessionId, candidate, manifest);
      if (started?.queued !== true) break;
    }
  } catch (error) {
    console.error(`[runs] queued AgY launch failed for ${normalizedProviderId}: ${error?.message || error}`);
  } finally {
    agyLaunchesInFlight.delete(normalizedProviderId);
  }
}

async function launchDetachedRunWithAgySlot(sessionId, run, manifest) {
  if (detachedRunLaunchPromises.has(run.id)) return detachedRunLaunchPromises.get(run.id);
  const promise = launchDetachedRunWithAgySlotUnlocked(sessionId, run, manifest)
    .finally(() => {
      if (detachedRunLaunchPromises.get(run.id) === promise) detachedRunLaunchPromises.delete(run.id);
    });
  detachedRunLaunchPromises.set(run.id, promise);
  return promise;
}

async function launchDetachedRunWithAgySlotUnlocked(sessionId, run, manifest) {
  // Persist the hand-off boundary before competing for capacity.  A delayed
  // runner used to leave only `runnerStartedAt`, making it impossible to tell
  // whether the provider stalled or the scheduler/lifecycle broker never got
  // the Run.  These fields are harness-neutral and survive a control-plane
  // restart.
  if (!trimString(run.runnerLaunchRequestedAt)) {
    const launchRequestedAt = nowIso();
    run = await updateRun(run.id, (current) => ({
      ...current,
      runnerLaunchRequestedAt: current.runnerLaunchRequestedAt || launchRequestedAt,
      runnerLaunchState: current.runnerLaunchState || 'capacity_check',
    })) || run;
  }
  const adaptiveLease = acquireHarnessRunBudget(run, manifest);
  if (!adaptiveLease) {
    const queuedAt = trimString(run.adaptiveQueue?.queuedAt) || nowIso();
    await updateRun(run.id, (current) => ({
      ...current,
      state: 'queued',
      adaptiveQueue: {
        reason: 'adaptive_capacity',
        queuedAt,
        priority: resolveHarnessRunPriority(current),
      },
      runnerLaunchState: 'adaptive_capacity',
      runnerLaunchQueuedAt: current.runnerLaunchQueuedAt || queuedAt,
    }));
    adaptiveQueuedRunIds.add(run.id);
    broadcastSessionInvalidation(sessionId);
    scheduleAdaptiveRunDrain(1_000);
    return { queued: true, adaptiveCapacity: true };
  }
  let providerId = '';
  try {
    const slot = await acquireAgyRunSlot(run, manifest);
    providerId = slot.providerId;
    if (providerId) {
      if (!slot.acquired.ok) {
        releaseHarnessRunBudget(run.id, { schedule: false, outcome: 'cancelled' });
        adaptiveQueuedRunIds.delete(run.id);
        const queuedAt = trimString(run.agyQueue?.queuedAt) || nowIso();
        await updateRun(run.id, (current) => ({
          ...current,
          state: 'queued',
          agyQueue: {
            providerId,
            reason: slot.acquired.reason,
            queuedAt,
            ...(trimString(slot.acquired.owner?.runId) ? { ownerRunId: trimString(slot.acquired.owner.runId) } : {}),
          },
          adaptiveQueue: undefined,
          runnerLaunchState: 'provider_slot_wait',
          runnerLaunchQueuedAt: current.runnerLaunchQueuedAt || queuedAt,
        }));
        broadcastSessionInvalidation(sessionId);
        scheduleAgyQueueDrain();
        return { queued: true, providerId };
      }
    }
  } catch (error) {
    await releaseAgyRunSlot(run.id, { outcome: 'error' }).catch(() => {});
    throw error;
  }

  let spawned;
  try {
    if (run.appApiMessageVersion === 1) await admitScopedMessageLaunch(run.id);
    await updateRun(run.id, (current) => ({
      ...current,
      runnerLaunchState: 'lifecycle_submitting',
      runnerLifecycleSubmittedAt: current.runnerLifecycleSubmittedAt || nowIso(),
    }));
    if (!observeDetachedRun(sessionId, run.id)) {
      throw new Error('Unable to observe detached Run before launch');
    }
    spawned = await spawnDetachedRunner(run.id, {
      launchAttempt: Number.isSafeInteger(run.runnerLaunchAttempt) ? run.runnerLaunchAttempt : 0,
    });
  } catch (error) {
    const completedAt = nowIso();
    const failureReason = `Runner launch failed: ${error?.message || String(error)}`;
    await writeRunResult(run.id, { exitCode: 1, signal: null, error: failureReason, completedAt });
    await updateRun(run.id, (current) => ({ ...current, state: 'failed', failureReason, completedAt }));
    await syncDetachedRun(sessionId, run.id);
    await releaseAgyRunSlot(run.id, { outcome: 'error' });
    releaseHarnessRunBudget(run.id, { schedule: true, outcome: 'error' });
    if (run.appApiMessageVersion === 1) await updateRun(run.id, {
      messageFailureCode: ['REVISION_CONFLICT', 'REQUEST_EXPIRED', 'REQUEST_CANCELLED', 'RESTRICTED_EXECUTION_UNAVAILABLE',
        'RUN_EXECUTION_INPUT_UNAVAILABLE'].includes(error.code)
        ? error.code : 'LAUNCH_FAILED',
    });
    throw error;
  }
  const runnerStartedAt = nowIso();
  const startedRun = await updateRun(run.id, (current) => ({
    ...current,
    state: current.state === 'queued' ? 'accepted' : current.state,
    agyQueue: undefined,
    adaptiveQueue: undefined,
    runnerProcessId: spawned?.pid || current.runnerProcessId || null,
    runnerUnitName: spawned?.unitName || current.runnerUnitName || null,
    runnerUnitScope: spawned?.unitScope || current.runnerUnitScope || null,
    runnerLaunchMode: spawned?.launchMode || current.runnerLaunchMode || null,
    runnerSupervisorSocket: spawned?.supervisorSocket || current.runnerSupervisorSocket || null,
    runnerLaunchAttempt: Number.isSafeInteger(spawned?.launchAttempt)
      ? spawned.launchAttempt
      : (Number.isSafeInteger(current.runnerLaunchAttempt) ? current.runnerLaunchAttempt : 0),
    runnerStartedAt: current.runnerStartedAt || runnerStartedAt,
    runnerLaunchState: 'started',
    runnerLifecycleAcceptedAt: current.runnerLifecycleAcceptedAt || runnerStartedAt,
  }));
  const promptReadyToRunnerMs = isoDurationMs(startedRun?.promptReadyAt, startedRun?.runnerStartedAt || runnerStartedAt);
  if (promptReadyToRunnerMs !== null && !run.runnerStartedAt) {
    recordApiRequestPhase('send.prompt_ready_to_runner_started', promptReadyToRunnerMs, {
      requestId: run.requestId,
      sessionId,
      runId: run.id,
    });
  }
  adaptiveQueuedRunIds.delete(run.id);
  broadcastSessionInvalidation(sessionId);
  return { queued: false, spawned, providerId };
}

function runAuthRecoveryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveRunNativeProviderId(run, manifest) {
  return trimString(
    run?.providerProfile
      || run?.resolvedProviderId
      || run?.agyProviderProfileId
      || manifest?.options?.providerProfile
      || manifest?.nativeRuntimeSnapshot?.providerProfileId,
  );
}

function resolveRunNativeAgentType(run, manifest) {
  const tool = trimString(run?.tool || manifest?.tool).toLowerCase();
  const family = trimString(run?.runtimeFamily || manifest?.runtimeFamily || manifest?.options?.runtimeFamily).toLowerCase();
  if (tool === 'agy' || family === 'agy-json' || family === 'agy-stream-json') return 'agy';
  if (tool === 'codex' || tool === 'codex-cli' || family.startsWith('codex-')) return 'codex';
  if (tool === 'claude' || tool === 'claude-bidi' || family.startsWith('claude-')) return 'claude';
  return '';
}

async function resolveRunCredentialContext(run, manifest, credentialLedger) {
  const agentType = resolveRunNativeAgentType(run, manifest);
  const providerId = resolveRunNativeProviderId(run, manifest);
  if (!agentType || !providerId) return null;
  const registry = createNativeProviderRegistry({ configDir: CONFIG_DIR });
  const provider = await registry.getProviderProfile(providerId).catch(() => null);
  if (!provider || provider.agentType !== agentType) return null;
  const authProfile = await registry.getAuthProfile(provider.authProfileId).catch(() => null);
  if (!authProfile || authProfile.agentType !== agentType) return null;
  const metadata = authProfile.accountMetadata && typeof authProfile.accountMetadata === 'object'
    ? authProfile.accountMetadata
    : {};
  const accountId = trimString(metadata.accountId);
  const accountKey = trimString(metadata.accountKey)
    || (accountId ? `account:${agentType}:${accountId}` : '')
    || `provider:${agentType}:${trimString(provider.syncId || provider.id)}`;
  return {
    agentType,
    providerId,
    provider,
    authProfile,
    accountKey,
    registry,
    latestCredential: await credentialLedger.getRecord(accountKey).catch(() => null),
  };
}

function containsRunSideEffectEvidence(value, depth = 0, seen = new Set()) {
  if (!value || depth > 8) return false;
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsRunSideEffectEvidence(entry, depth + 1, seen));
  const type = trimString(value.type || value.method).toLowerCase();
  if (type === 'tool_use'
      || type === 'tool_result'
      || type === 'tool_call'
      || type === 'file_change'
      || type === 'command_execution'
      || type === 'approval_request'
      || type === 'approval_response'
      || type === 'privileged_batch_request'
      || type === 'privileged_batch_response'
      || type.includes('commandexecution')
      || type.includes('approval')
      || type.includes('tool')) return true;
  return Object.values(value).some((entry) => containsRunSideEffectEvidence(entry, depth + 1, seen));
}

async function runHasSideEffectEvidence(runId) {
  let found = false;
  await scanRunSpoolRecords(runId, async (record) => {
    if (containsRunSideEffectEvidence(record?.json)) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

async function runHasSuccessfulTerminalEvidence(run, manifest) {
  const fileResult = await getRunResult(run?.id).catch((error) => {
    if (error?.code === 'LINUX_RUN_RESULT_UNAVAILABLE') throw error;
    return null;
  });
  const persistedResults = [run?.result, fileResult]
    .filter((result) => result && typeof result === 'object');
  if (persistedResults.some((result) => (
    Number(result.exitCode) === 0
      && result.cancelled !== true
      && result.error == null
      && result.providerTerminalSeen === true
  ))) {
    return true;
  }
  const runtimeFamily = trimString(
    run?.runtimeFamily || manifest?.runtimeFamily || manifest?.options?.runtimeFamily,
  );
  if (!runtimeFamily || !run?.id) return false;
  let found = false;
  await scanRunSpoolRecords(run.id, async (record) => {
    if (isProviderSuccessfulTerminalPayload(
      record?.json,
      runtimeFamily,
      trimString(run?.appServerTurnId),
    )) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

function scheduleRunAuthRecoveryLaunch(runId) {
  const normalizedRunId = trimString(runId);
  if (!normalizedRunId) return null;
  if (runAuthRecoveryLaunchPromises.has(normalizedRunId)) {
    return runAuthRecoveryLaunchPromises.get(normalizedRunId);
  }
  const promise = (async () => {
    let run = await getRun(normalizedRunId);
    let manifest = await getRunManifest(normalizedRunId);
    if (!run || !manifest) return null;
    const recovery = normalizeRunAuthRecovery(run.authRecovery);
    if (recovery.authRetryState !== 'auth_retrying'
        || !RESUMABLE_AUTH_RECOVERY_LAUNCH_STATES.has(trimString(run.runnerLaunchState))) {
      return run;
    }

    // The failing sidecar is awaiting the HTTP acknowledgement that schedules
    // this work. Launching synchronously deadlocks that hand-off and reuses its
    // still-loaded systemd unit. Wait for the predecessor process to consume
    // the acknowledgement and exit; the next lifecycle attempt has its own
    // deterministic unit/access identity as a second line of defence.
    const predecessorPid = Number.isInteger(run.authRecoveryRequesterProcessId)
      ? run.authRecoveryRequesterProcessId
      : Number.isInteger(run.runnerProcessId)
        ? run.runnerProcessId
        : null;
    const deadline = Date.now() + 30_000;
    while (predecessorPid && isRecordedProcessAlive(predecessorPid) && Date.now() < deadline) {
      await sleep(50);
    }
    if (predecessorPid && isRecordedProcessAlive(predecessorPid)) {
      const error = new Error('Previous runner did not exit before the authentication recovery deadline');
      error.code = 'RUN_AUTH_RECOVERY_PREDECESSOR_ACTIVE';
      throw error;
    }

    run = await getRun(normalizedRunId) || run;
    manifest = await getRunManifest(normalizedRunId) || manifest;
    const latestRecovery = normalizeRunAuthRecovery(run.authRecovery);
    if (latestRecovery.authRetryState !== 'auth_retrying'
        || latestRecovery.resumeAttempt !== recovery.resumeAttempt) {
      return run;
    }
    if (await runHasSuccessfulTerminalEvidence(run, manifest)) {
      return updateRun(normalizedRunId, (current) => ({
        ...current,
        state: 'completed',
        failureReason: '',
        runnerLaunchState: 'completed',
        authRecoveryRequesterProcessId: null,
      }));
    }

    const launchAttempt = latestRecovery.resumeAttempt;
    manifest = await updateRunManifest(normalizedRunId, (current) => ({
      ...current,
      runnerLaunchAttempt: launchAttempt,
    })) || manifest;
    await clearRunResult(normalizedRunId);
    run = await updateRun(normalizedRunId, (current) => ({
      ...current,
      state: 'accepted',
      runnerLaunchAttempt: launchAttempt,
      runnerLaunchState: 'auth_retry_launching',
      runnerLaunchRequestedAt: nowIso(),
      authRecoveryRequesterProcessId: null,
      __clearTerminalData: true,
      __clearRunnerBinding: true,
    })) || run;
    const launch = await launchDetachedRunWithAgySlot(run.sessionId, run, manifest);
    broadcastSessionInvalidation(run.sessionId);
    return launch;
  })().catch(async (error) => {
    if (error?.code === 'LINUX_RUN_RESULT_UNAVAILABLE') {
      const retry = setTimeout(() => {
        void getRun(normalizedRunId).then((current) => {
          if (current && !current.cancelRequested &&
              normalizeRunAuthRecovery(current.authRecovery).authRetryState === 'auth_retrying' &&
              RESUMABLE_AUTH_RECOVERY_LAUNCH_STATES.has(trimString(current.runnerLaunchState))) {
            scheduleRunAuthRecoveryLaunch(normalizedRunId);
          }
        }).catch(() => {});
      }, 1000);
      retry.unref?.();
      return null;
    }
    const run = await getRun(normalizedRunId).catch(() => null);
    const failureReason = `Run auth recovery launch failed: ${error?.message || String(error)}`;
    await updateRun(normalizedRunId, (current) => ({
      ...current,
      state: 'failed',
      failureReason: trimString(current?.failureReason) || failureReason,
      authRecovery: {
        ...normalizeRunAuthRecovery(current?.authRecovery),
        authRetryState: 'reauth_required',
        lastAuthFailureClass: 'auth-expired',
      },
      authRecoveryRequesterProcessId: null,
    })).catch(() => {});
    if (run?.sessionId) broadcastSessionInvalidation(run.sessionId);
    console.error(`[runs] ${failureReason}`);
    return null;
  }).finally(() => {
    if (runAuthRecoveryLaunchPromises.get(normalizedRunId) === promise) {
      runAuthRecoveryLaunchPromises.delete(normalizedRunId);
    }
  });
  runAuthRecoveryLaunchPromises.set(normalizedRunId, promise);
  return promise;
}

function buildRecoveryResumeManifest(manifest, run, launchAttempt = 0) {
  const options = { ...(manifest?.options || {}) };
  const resumeFields = {
    claudeSessionId: trimString(run?.claudeSessionId),
    codexThreadId: trimString(run?.codexThreadId),
    agyConversationId: trimString(run?.agyConversationId),
    providerResumeId: trimString(
      run?.providerResumeId
        || run?.codexThreadId
        || run?.claudeSessionId
        || run?.agyConversationId,
    ),
  };
  for (const [key, value] of Object.entries(resumeFields)) {
    if (value) options[key] = value;
  }
  if (resumeFields.codexThreadId) options.codexResume = true;
  if (resumeFields.agyConversationId) options.agyResume = true;
  return { ...manifest, runnerLaunchAttempt: launchAttempt, options };
}

/**
 * Handle an explicit auth-expired signal from the detached sidecar.  The
 * operation is serialized per Run so duplicate observer/sidecar signals
 * cannot consume two retry slots or launch two providers.
 */
export async function recoverRunAuthFailure({
  runId,
  sessionId,
  turnId,
  failureClass = '',
  failureAttempt = 0,
  sideEffectsConfirmed = false,
  requesterProcessId = null,
} = {}) {
  const normalizedRunId = trimString(runId);
  return runAuthRecoveryQueue(normalizedRunId, async () => {
    let run = await getRun(normalizedRunId);
    let manifest = await getRunManifest(normalizedRunId);
    if (!run || !manifest) throw runAuthRecoveryError('RUN_AUTH_RECOVERY_NOT_FOUND', 'Run recovery context is unavailable');
    if (trimString(run.sessionId) !== trimString(sessionId)
        || trimString(manifest.sessionId) !== trimString(sessionId)
        || trimString(manifest.requestId) !== trimString(turnId)) {
      throw runAuthRecoveryError('RUN_AUTH_RECOVERY_CONFLICT', 'Run recovery binding does not match');
    }
    const normalizedRequesterPid = Number.isSafeInteger(Number(requesterProcessId))
      && Number(requesterProcessId) > 0
      ? Number(requesterProcessId)
      : null;
    if (normalizedRequesterPid
        && Number.isInteger(run.runnerProcessId)
        && run.runnerProcessId !== normalizedRequesterPid) {
      throw runAuthRecoveryError('RUN_AUTH_RECOVERY_CONFLICT', 'Run recovery process binding does not match');
    }
    if (isTerminalRunState(run.state) && run.finalizedAt) {
      throw runAuthRecoveryError('RUN_AUTH_RECOVERY_FINALIZED', 'Run has already been finalized');
    }
    if (['completed', 'cancelled'].includes(run.state)
        || await runHasSuccessfulTerminalEvidence(run, manifest)) {
      throw runAuthRecoveryError('RUN_AUTH_RECOVERY_ALREADY_SUCCEEDED', 'Run already has terminal provider evidence');
    }
    if (trimString(failureClass) !== 'auth-expired'
        || !Number.isSafeInteger(Number(failureAttempt))
        || Number(failureAttempt) < 0) {
      throw runAuthRecoveryError('RUN_AUTH_RECOVERY_REQUEST_INVALID', 'Only an explicit auth-expired signal is recoverable');
    }

    const currentRecovery = normalizeRunAuthRecovery(run.authRecovery);
    const attempt = Math.floor(Number(failureAttempt));
    if (attempt < currentRecovery.resumeAttempt) {
      return {
        ok: true,
        retry: true,
        status: 'already-retrying',
        authRecovery: currentRecovery,
      };
    }
    if (attempt > currentRecovery.resumeAttempt) {
      throw runAuthRecoveryError('RUN_AUTH_RECOVERY_CONFLICT', 'Run auth recovery attempt is ahead of the persisted state');
    }
    if (currentRecovery.authRetryState === 'auth_retry_exhausted'
        || currentRecovery.authRetryState === 'reauth_required') {
      return {
        ok: false,
        retry: false,
        status: 'stopped',
        reason: currentRecovery.authRetryState,
        authRecovery: currentRecovery,
      };
    }

    const credentialLedger = createCredentialMutationLedger({ configDir: CONFIG_DIR });
    const credentialContext = await resolveRunCredentialContext(run, manifest, credentialLedger);
    if (!credentialContext) {
      const next = { ...currentRecovery, authRetryState: 'reauth_required', lastAuthFailureClass: 'auth-expired' };
      run = await updateRun(normalizedRunId, (current) => ({ ...current, authRecovery: next })) || run;
      return { ok: false, retry: false, status: 'stopped', reason: 'credential-unavailable', authRecovery: next };
    }

    if (credentialContext.agentType === 'agy') {
      let reconciliation = null;
      try {
        const identity = await loadOrCreateInstanceIdentity();
        reconciliation = await reconcileAgyRunCredential({
          run,
          manifest,
          configDir: CONFIG_DIR,
          providerHomesRoot: dirname(AGY_MANAGED_HOME_DIR),
          registry: credentialContext.registry,
          secretStore: createSecretStore({ configDir: CONFIG_DIR }),
          credentialLedger,
          sourceInstanceId: identity.instanceId,
        });
      } catch {
        reconciliation = { status: 'failed', reason: 'agy-refresh-reconcile-threw' };
      }
      if (reconciliation?.status && reconciliation.status !== 'not-applicable') {
        await updateRun(normalizedRunId, (current) => ({
          ...current,
          agyCredentialSync: {
            status: reconciliation.status,
            ...(reconciliation.reason ? { reason: reconciliation.reason } : {}),
            ...(Number.isSafeInteger(reconciliation.credentialVersion)
              ? { credentialVersion: reconciliation.credentialVersion }
              : {}),
          },
        })).catch(() => {});
        run = await getRun(normalizedRunId) || run;
      }
    }

    const latestCredential = await credentialLedger.getRecord(credentialContext.accountKey).catch(() => null);
    const sideEffects = sideEffectsConfirmed === true || await runHasSideEffectEvidence(normalizedRunId);
    const plan = planRunAuthRecovery({
      run,
      failureClass,
      latestCredential,
      sideEffectsConfirmed: sideEffects,
    });

    if (plan.decision !== 'retry') {
      const nextRun = await updateRun(normalizedRunId, (current) => ({
        ...current,
        authRecovery: {
          ...plan.next,
          lastAuthFailureClass: trimString(plan.next.lastAuthFailureClass) || 'auth-expired',
        },
      })) || run;
      return {
        ok: false,
        retry: false,
        status: plan.decision === 'exhausted' ? 'exhausted' : 'stopped',
        reason: plan.reason || 'auth-recovery-stopped',
        authRecovery: nextRun.authRecovery,
      };
    }

    const nextManifest = buildRecoveryResumeManifest(manifest, run, plan.next.resumeAttempt);
    await updateRunManifest(normalizedRunId, () => nextManifest);
    run = await updateRun(normalizedRunId, (current) => ({
      ...current,
      authRecovery: plan.next,
      runnerLaunchAttempt: plan.next.resumeAttempt,
      runnerLaunchState: 'auth_retry_pending',
      authRecoveryRequestedAt: nowIso(),
      authRecoveryRequesterProcessId: normalizedRequesterPid || current.runnerProcessId || null,
    })) || run;
    scheduleRunAuthRecoveryLaunch(normalizedRunId);
    broadcastSessionInvalidation(run.sessionId);
    return {
      ok: true,
      retry: true,
      status: 'retrying',
      queued: true,
      authRecovery: (await getRun(normalizedRunId) || run).authRecovery,
    };
  });
}

async function repairDetachedRunRuntimeBinding(sessionId, run, manifest) {
  const session = await findSessionMeta(sessionId).catch(() => null);
  const requestedTool = trimString(manifest?.tool || run?.tool || session?.tool);
  const binding = await resolveSessionRuntimeTool(session || { tool: requestedTool }, {
    requestedTool,
    fallbackToTemplate: !requestedTool,
  });
  const storedRuntimeFamily = trimString(
    run?.runtimeFamily
      || manifest?.runtimeFamily
      || manifest?.options?.runtimeFamily
  );
  const runtimeFamily = storedRuntimeFamily || trimString(binding.definition?.runtimeFamily);
  if (!runtimeFamily) {
    return {
      run,
      manifest,
      binding,
      runtimeFamily: '',
      missingRuntimeFamily: true,
      repaired: false,
    };
  }

  const providerContract = buildProviderContractFields(runtimeFamily, {
    provider: run?.provider || manifest?.provider,
    runtimeFamily,
    providerCapabilities: run?.providerCapabilities
      || manifest?.providerCapabilities
      || manifest?.options?.providerCapabilities,
  });
  let nextManifest = manifest;
  const nextManifestOptions = { ...(manifest?.options || {}) };
  let manifestChanged = false;
  const setManifestField = (field, value) => {
    if (value === undefined || value === null || value === '') return;
    if (nextManifest[field] === value) return;
    nextManifest = { ...nextManifest, [field]: value };
    manifestChanged = true;
  };

  if (binding.definition && binding.tool) setManifestField('tool', binding.tool);
  if (!trimString(manifest?.runtimeFamily)) setManifestField('runtimeFamily', runtimeFamily);
  if (!trimString(nextManifestOptions.runtimeFamily)) {
    nextManifestOptions.runtimeFamily = runtimeFamily;
    manifestChanged = true;
  }
  if (!trimString(manifest?.provider) && providerContract.provider) {
    setManifestField('provider', providerContract.provider);
  }
  if (!manifest?.providerCapabilities && providerContract.providerCapabilities) {
    setManifestField('providerCapabilities', providerContract.providerCapabilities);
  }
  if (!trimString(nextManifestOptions.toolCommand) && trimString(binding.definition?.command)) {
    nextManifestOptions.toolCommand = trimString(binding.definition.command);
    manifestChanged = true;
  }
  if (manifestChanged) {
    nextManifest = { ...nextManifest, options: nextManifestOptions };
    nextManifest = await updateRunManifest(run.id, () => nextManifest) || nextManifest;
  }

  const runNeedsRepair = (
    (binding.definition && binding.tool && trimString(run?.tool) !== binding.tool)
      || !trimString(run?.runtimeFamily)
      || (!trimString(run?.provider) && !!providerContract.provider)
      || (!run?.providerCapabilities && !!providerContract.providerCapabilities)
  );
  const repairedRun = runNeedsRepair
    ? await updateRun(run.id, (current) => ({
        ...current,
        ...(binding.definition && binding.tool ? { tool: binding.tool } : {}),
        ...(trimString(current?.runtimeFamily) ? {} : { runtimeFamily }),
        ...(!trimString(current?.provider) && providerContract.provider
          ? { provider: providerContract.provider }
          : {}),
        ...(!current?.providerCapabilities && providerContract.providerCapabilities
          ? { providerCapabilities: providerContract.providerCapabilities }
          : {}),
      })) || run
    : run;

  return {
    run: repairedRun,
    manifest: nextManifest,
    binding,
    runtimeFamily,
    missingRuntimeFamily: !storedRuntimeFamily,
    repaired: manifestChanged || repairedRun !== run,
  };
}

function hasRegisteredDetachedRunner(run) {
  return Number.isInteger(run?.runnerProcessId)
    || Number.isInteger(run?.toolProcessId)
    || !!trimString(run?.runnerUnitName);
}

async function finalizeUnrecoverableDetachedRun(sessionId, run, manifest, reason) {
  const completedAt = nowIso();
  const cancelled = run?.cancelRequested === true;
  const terminalState = isTerminalRunState(run?.state)
    ? run.state
    : (cancelled ? 'cancelled' : 'failed');
  const result = {
    completedAt,
    exitCode: 1,
    signal: null,
    ...(cancelled ? { cancelled: true } : { error: reason }),
    synthesized: true,
    reconciliation: 'unrecoverable-detached-run',
  };
  await writeRunResult(run.id, result);
  run = await updateRun(run.id, (current) => ({
    ...current,
    state: terminalState,
    completedAt: current.completedAt || completedAt,
    result,
    ...(terminalState === 'failed' ? { failureReason: reason } : {}),
  })) || run;

  const fallbackManifest = manifest || {
    id: run.id,
    sessionId,
    requestId: run.requestId || '',
    responseId: run.responseId || '',
    tool: run.tool || '',
    options: {},
  };
  try {
    const finalized = await finalizeDetachedRun(sessionId, run, fallbackManifest, []);
    if (finalized.historyChanged || finalized.sessionChanged) {
      broadcastSessionInvalidation(sessionId);
    }
  } catch (error) {
    // The terminal status is already durable. Clear the stale Session pointer
    // even if continuity finalization is blocked by an unrelated history gap.
    console.error(`[runs] malformed Run finalization failed for ${run.id}: ${error?.message || error}`);
    const cleared = await mutateSessionMeta(sessionId, (session) => {
      if (session.activeRunId !== run.id) return false;
      delete session.activeRunId;
      session.updatedAt = nowIso();
      return true;
    });
    if (cleared.changed) broadcastSessionInvalidation(sessionId);
  }
  await releaseAgyRunSlot(run.id, { outcome: harnessOutcomeForRun(run) });
  stopObservedRun(run.id);
  return await getRun(run.id) || run;
}

async function syncDetachedRunUnlocked(sessionId, runId) {
  let run = await getRun(runId);
  if (!run) {
    await releaseAgyRunSlot(runId, { outcome: 'cancelled' });
    stopObservedRun(runId);
    return null;
  }
  let manifest = await getRunManifest(runId);
  if (!manifest) {
    if (isTerminalRunState(run.state) && run.finalizedAt) return run;
    // A live Runner may still be able to finish and write its result even if
    // the control-plane manifest was lost. Do not clear its Session pointer
    // until the normal Runner observation path can reconcile it.
    if (hasRegisteredDetachedRunner(run)) return run;
    // The status and manifest are written separately. During the short window
    // between accepting a Run and registering its detached runner, a restart
    // can observe the status without its manifest. Keep that accepted Run
    // cancellable until the same launch grace used by the orphan sweep ends.
    if (run.state === 'accepted' && run.cancelRequested !== true) {
      const anchorMs = parseTimestampMs(
        run.runnerHeartbeatAt || run.updatedAt || run.createdAt,
      );
      if (!Number.isFinite(anchorMs) || (Date.now() - anchorMs) < DETACHED_RUN_LAUNCH_GRACE_MS) {
        return run;
      }
    }
    return finalizeUnrecoverableDetachedRun(
      sessionId,
      run,
      null,
      'Run manifest is missing; the detached Run cannot be recovered',
    );
  }

  if (run.appApiMessageVersion === 1 && !hasRegisteredDetachedRunner(run) &&
      (run.appApiMessageQueue || ['preparing', 'accepted'].includes(run.state))) {
    scheduleScopedMessageRun(sessionId, run.id);
    return run;
  }

  // Preparation Runs have no detached process yet. Requeue their durable
  // continuation instead of asking the normal observer to synthesize a
  // missing-runner failure while Prompt construction is still pending.
  if (manifest.preparation
    && !isTerminalRunState(run.state)
    && !hasRegisteredDetachedRunner(run)) {
    schedulePreparingRun(sessionId, runId);
    return run;
  }

  const repairedBinding = await repairDetachedRunRuntimeBinding(sessionId, run, manifest);
  run = repairedBinding.run;
  manifest = repairedBinding.manifest;
  if (!repairedBinding.runtimeFamily || (repairedBinding.missingRuntimeFamily && !hasRegisteredDetachedRunner(run))) {
    return finalizeUnrecoverableDetachedRun(
      sessionId,
      run,
      manifest,
      'Run runtimeFamily is missing and no registered Runtime tool could repair it',
    );
  }

  if (hasPendingRunApproval(run) && harnessRunLeases.has(run.id)) {
    yieldHarnessRunBudget(run.id);
  }

  let historyChanged = false;
  let sessionChanged = false;

  // The provider-facing shim returns as soon as its request is accepted, so a
  // sidecar may exit before its background watcher reaches the deadline. Keep
  // timeout/cancellation cleanup durable in the control plane as a fallback.
  const shimPending = run.privilegedShimPending;
  const shimExpiresAtMs = Date.parse(shimPending?.expiresAt || '');
  const shimHasTerminalResult = run.privilegedShimResult?.batchId === shimPending?.batchId;
  if (shimPending?.batchId
    && !shimHasTerminalResult
    && Number.isFinite(shimExpiresAtMs)
    && shimExpiresAtMs <= Date.now()) {
    const terminalStatus = run.cancelRequested === true || isTerminalRunState(run.state)
      ? 'cancelled'
      : 'timeout';
    const terminalUpdater = buildPrivilegedShimTerminalUpdate(
      run,
      { batchId: shimPending.batchId },
      { status: terminalStatus },
    );
    if (terminalUpdater) run = await updateRun(runId, terminalUpdater) || run;
  }

  // P1c-5 (design §13.7): surface a privileged batch into the session store.
  // run.privilegedBatchPending is set only by the sidecar quiescence-debounce drain
  // under privilegedMode (§13.6), so its mere presence implies privileged mode was
  // on; session.privilegedMode is re-checked here as defense-in-depth. Persist
  // exactly one privileged_batch_request event (idempotent), then clear the pending
  // flag so the next observer tick does not re-read history. The pending flag is
  // only produced by a gated run. No privilege gain: the request event is inert
  // data; actual root execution is P3.
  if (run.privilegedBatchPending) {
    // Normalize even persisted pre-upgrade batches before their first event is
    // surfaced. Safe Windows installs use the separately verified managed
    // channel; legacy install labels alone cannot authorize them.
    run = { ...run, privilegedBatchPending: deferWindowsLegacyInstallBatch(run.privilegedBatchPending) };
    const session = await getSession(sessionId).catch(() => null);
    const realStore = {
      // Privileged helpers only need the request/response/exec records for
      // this batch. Never hydrate the complete session transcript here.
      readEvents: async () => readPrivilegedBatchEvents(sessionId, run.privilegedBatchPending?.batchId),
      appendEvent: async (event) => appendEvent(sessionId, { ...event, runId }),
      invalidate: async () => { broadcastSessionInvalidation(sessionId); },
    };
    const privilegedRouting = isPrivilegeRoutingEnabled(session);
    const surface = await surfacePrivilegedBatchRequest(
      run.privilegedBatchPending,
      privilegedRouting,
      realStore,
    );
    if (surface.changed) sessionChanged = true;
    if (privilegedRouting && !surface.error) {
      const mode = resolveSessionRiskMode(session);
      const policy = resolvePrivilegedBatchPolicy(mode);
      if (policy.install === 'execute') {
        const installAuto = await executePrivilegedInstallAutoBatch(
          sessionId, run, run.privilegedBatchPending, realStore,
        );
        if (installAuto.changed) sessionChanged = true;
        const shimInstallUpdate = buildPrivilegedShimInstallAutoUpdate(run, run.privilegedBatchPending, installAuto.execResults);
        if (shimInstallUpdate) run = await updateRun(runId, shimInstallUpdate) || run;
      }
      if (policy.install === 'deny' || policy.other === 'deny' || policy.delete === 'deny') {
        const batch = run.privilegedBatchPending;
        const denied = await denyPrivilegedBatchCategories(run, batch, realStore, [
          ...(policy.install === 'deny' ? [[CATEGORY_INSTALL, batch.installAuto]] : []),
          ...(policy.other === 'deny' ? [[CATEGORY_OTHER, batch.other]] : []),
          ...(policy.delete === 'deny' ? [[CATEGORY_DELETE, batch.delete]] : []),
        ]);
        if (denied) sessionChanged = true;
        if (policy.install === 'deny' || batch.other?.length || batch.delete?.length) {
          const shimDenyUpdate = buildPrivilegedShimPolicyDenialUpdate(
            run, batch, policy.install === 'deny'
              ? 'privileged execution is unavailable in this unattended mode on this host'
              : 'unattended privilege policy denied this operation',
          );
          if (shimDenyUpdate) run = await updateRun(runId, shimDenyUpdate) || run;
        }
      }
    } else if (privilegedRouting !== true) {
      // Routing disabled: give a waiting shim an explicit decline instead of
      // leaving it to time out. (Transient surface failures keep routing on
      // and are retried on the next sync tick — never declined here.)
      const shimDeclineUpdate = buildPrivilegedShimDeclineUpdate(run, run.privilegedBatchPending, privilegedRouting);
      if (shimDeclineUpdate) {
        run = await updateRun(runId, shimDeclineUpdate) || run;
      }
    }
    if (surface.error) {
      console.error(`[privileged] surface batch for run ${runId}: ${surface.error?.message || surface.error}`);
    }
    if (surface.clear) {
      run = await updateRun(runId, (current) => {
        if (!current?.privilegedBatchPending) return current;
        const next = { ...current };
        next.privilegedBatchPending = undefined;
        return next;
      }) || run;
    }
  }


  const projection = await collectNormalizedRunEventDelta(run, manifest);
  const messageTimeline = await prepareLiveMessageTimeline(sessionId, projection.normalizedEvents);
  const normalizedEvents = messageTimeline.events;
  if (!run.firstTextDeltaAt && normalizedEvents.some((event) => (
    event?.type === 'text_delta'
    && typeof event.text === 'string'
    && event.text.length > 0
  ))) {
    const firstTextDeltaAt = nowIso();
    const firstDeltaRun = await updateRun(runId, (current) => ({
      ...current,
      firstTextDeltaAt: current.firstTextDeltaAt || firstTextDeltaAt,
    })) || run;
    const runnerToFirstDeltaMs = isoDurationMs(
      firstDeltaRun.runnerStartedAt || run.runnerStartedAt,
      firstDeltaRun.firstTextDeltaAt || firstTextDeltaAt,
    );
    if (runnerToFirstDeltaMs !== null && !run.firstTextDeltaAt) {
      recordApiRequestPhase('send.runner_first_text_delta', runnerToFirstDeltaMs, {
        requestId: run.requestId,
        sessionId,
        runId,
      });
    }
    run = firstDeltaRun;
  }
  // Persist user-visible and recovery-relevant events, then reconstruct the
  // WebSocket push in normalized order. Finalized reasoning blocks are retained
  // once so historical timelines can restore their original position.
  const eventPolicy = getHarnessEventPolicy(run.runtimeFamily || manifest?.runtimeFamily);
  const durableEvents = limitHarnessDurableEvents(
    normalizedEvents.filter(isDurableChatHistoryEvent),
    eventPolicy,
  );
  let uniqueDurableEvents = [];
  let deltaStoredEvents = [];
  if (durableEvents.length > 0) {
    // Structured runtimes (Claude/Codex) re-emit the same tool_use/reasoning/
    // assistant-message snapshot across multiple spool lines during streaming.
    // Each delta tick faithfully normalizes those new lines, so before appending
    // we dedup against already-persisted history — mirroring the terminal-tail
    // filter below — to keep durable history free of provider-id duplicates.
    // This only reduces what is *persisted*; normalizedEventCount/offset still
    // track the full normalized event count, so the terminal slice stays aligned.
    // Skip the history load entirely when no event carries any durable replay
    // identity. Such events produce empty dedup keys and pass through unchanged
    // anyway, so the load (per delta tick) is pure overhead for line-based tools.
    const hasDedupKey = durableEvents.some((event) => Boolean(getProviderEventReplayKey(event)));
    if (hasDedupKey && PERF_OBSERVER_ENABLED) {
      const knownSet = getKnownDedupKeySet(sessionId);
      if (knownSet) {
        // Seeded set is authoritative (see filterUnknownProviderEvents): a
        // candidate with an unknown key was never persisted → persist it
        // without re-loading the whole history. This is what lets ACTIVE
        // streaming runs stop paying a full-history load per tick — the
        // mixed batches (re-emissions + new events) no longer need history.
        uniqueDurableEvents = filterUnknownHarnessEvents(durableEvents, knownSet);
      } else {
        // First touch for this session (boot or set eviction): seed from the
        // authoritative event index. Do not materialize the history array;
        // the scan retains only compact dedup keys and falls back to the
        // current candidate keys when the per-session cap is exceeded.
        const scan = await scanProviderDedupKeys(sessionId, durableEvents);
        uniqueDurableEvents = filterProviderEventsAgainstScan(durableEvents, scan);
        if (scan.keys instanceof Set && !scan.capped) {
          rememberDedupKeySet(sessionId, scan.keys);
        }
      }
    } else if (hasDedupKey) {
      // AGENTOC_PERF_OBSERVER=off: still verify against storage, but scan one
      // event at a time so the compatibility mode does not reintroduce a full
      // in-memory transcript.
      const scan = await scanProviderDedupKeys(sessionId, durableEvents, { retainAllKeys: false });
      uniqueDurableEvents = filterProviderEventsAgainstScan(durableEvents, scan);
    } else {
      uniqueDurableEvents = durableEvents;
    }
    if (uniqueDurableEvents.length > 0) {
      deltaStoredEvents = await appendEvents(sessionId, uniqueDurableEvents);
      historyChanged = true;
      noteDedupKeysSeen(sessionId, deltaStoredEvents);
    }
  }
  const deltaPushEvents = buildDetachedRunPushEvents(normalizedEvents, uniqueDurableEvents, deltaStoredEvents);
  const projectionObservedAt = nowIso();
  const reasoningEvents = normalizedEvents.filter((event) => event?.type === 'reasoning');
  const semanticEvents = normalizedEvents.filter((event) => PROVIDER_SEMANTIC_EVENT_TYPES.has(event?.type));
  const providerLastReasoningAt = reasoningEvents.length > 0
    ? latestHarnessEventIso(reasoningEvents, () => true, projectionObservedAt)
    : null;
  const providerLastSemanticEventAt = semanticEvents.length > 0
    ? latestHarnessEventIso(semanticEvents, () => true, projectionObservedAt)
    : null;
  const visibleActivityObserved = deltaPushEvents.length > 0;

  // Detect if the adapter emitted a "completed" status in this delta — meaning
  // the model has finished outputting content even though the process may still
  // be alive (cleanup, background tasks, etc.).  Persisted on the run record so
  // the signal survives across observer ticks.
  const hasSpoolCompletion = normalizedEvents.some((event) => (
    isProviderRunCompletionEvent(event, run.runtimeFamily, run.appServerTurnId)
  ));

  const currentNormalizedLineCount = Number.isInteger(run.normalizedLineCount) ? run.normalizedLineCount : 0;
  const currentNormalizedEventCount = Number.isInteger(run.normalizedEventCount) ? run.normalizedEventCount : 0;
  const archivedLineBase = projection.skippedLineCount > 0
    ? projection.skippedLineCount
    : currentNormalizedLineCount;
  const nextNormalizedLineCount = archivedLineBase + projection.processedLineCount;
  const nextNormalizedEventCount = currentNormalizedEventCount + (Number.isInteger(projection.normalizedEventCount)
    ? projection.normalizedEventCount : normalizedEvents.length);
  // Only durable history proves that the group leader can already be shown
  // to the owner. A pending record alone may precede its spool/history write.
  const newlyPresentedApprovalIds = new Set(deltaStoredEvents.filter(event => event?.type === 'approval_request'
    && event?.runId === runId).map(event => normalizeRuntimeApprovalId(event?.approvalId)).filter(Boolean));
  const approvalSuppressionIds = [...new Set([
    ...(Array.isArray(run.approvalSuppressionIds) ? run.approvalSuppressionIds : []),
    ...(Array.isArray(projection.autoApprovedIds) ? projection.autoApprovedIds : []),
  ].filter((id) => typeof id === 'string' && id.trim()))].slice(-2048);
  const latestUsage = [...normalizedEvents].reverse().find((event) => event.type === 'usage');
  const contextInputTokens = Number.isInteger(latestUsage?.contextTokens)
    ? latestUsage.contextTokens
    : null;
  const contextWindowTokens = Number.isInteger(latestUsage?.contextWindowTokens)
    ? latestUsage.contextWindowTokens
    : null;

  run = await updateRun(runId, (current) => {
    // Perf: on a tick that normalized nothing new, return the draft unchanged
    // so updateRun's reference-identity fast path skips the status.json
    // rewrite. Writing every 250ms-1s tick kept the run dir watcher
    // self-triggering (watch → sync → write → watch); returning `current`
    // breaks that loop. lastNormalizedAt then means "last tick that changed
    // run state" instead of "last sync tick" — a diagnostic-only shift.
    const countsChanged = nextNormalizedLineCount !== current.normalizedLineCount
      || nextNormalizedEventCount !== current.normalizedEventCount
      || projection.nextOffset !== current.normalizedByteOffset;
    const tokenChanged = (Number.isInteger(contextInputTokens) && contextInputTokens !== current.contextInputTokens)
      || (Number.isInteger(contextWindowTokens) && contextWindowTokens !== current.contextWindowTokens);
    const hasNewCompletion = hasSpoolCompletion && !current.spoolCompletionDetectedAt;
    const suppressionSeedChanged = current.approvalSuppressionSeeded !== true;
    if (!countsChanged && !tokenChanged && !hasNewCompletion && !suppressionSeedChanged && PERF_OBSERVER_ENABLED) {
      return current;
    }
    return {
      ...current,
      ...(newlyPresentedApprovalIds.size && Array.isArray(current.appServerPendingApprovals) ? {
        appServerPendingApprovals: current.appServerPendingApprovals.map(entry => newlyPresentedApprovalIds.has(normalizeRuntimeApprovalId(entry?.approvalId))
          ? { ...entry, approvalPresented: true } : entry),
      } : {}),
      normalizedLineCount: nextNormalizedLineCount,
      normalizedByteOffset: projection.nextOffset,
      normalizedEventCount: nextNormalizedEventCount,
      spoolCursors: {
        normalized: {
          byteOffset: projection.nextOffset,
          lineCount: nextNormalizedLineCount,
        },
        historyPersisted: {
          byteOffset: projection.nextOffset,
          lineCount: nextNormalizedLineCount,
        },
      },
      approvalSuppressionIds,
      approvalSuppressionSeeded: true,
      lastNormalizedAt: nowIso(),
      ...(providerLastReasoningAt ? {
        firstProviderReasoningAt: current.firstProviderReasoningAt || providerLastReasoningAt,
        providerLastReasoningAt,
      } : {}),
      ...(providerLastSemanticEventAt ? {
        firstProviderSemanticEventAt: current.firstProviderSemanticEventAt || providerLastSemanticEventAt,
        providerLastSemanticEventAt,
      } : {}),
      ...(visibleActivityObserved ? {
        firstVisibleActivityAt: current.firstVisibleActivityAt || projectionObservedAt,
        lastVisibleActivityAt: projectionObservedAt,
      } : {}),
      ...(Number.isInteger(contextInputTokens) ? { contextInputTokens } : {}),
      ...(Number.isInteger(contextWindowTokens) ? { contextWindowTokens } : {}),
      ...(hasSpoolCompletion && !current.spoolCompletionDetectedAt
        ? { spoolCompletionDetectedAt: nowIso() }
        : {}),
    };
  }) || run;

  const runProviderKey = resolveProviderContextKey(run.tool || manifest?.tool, {
    runtimeFamily: run.runtimeFamily || manifest?.runtimeFamily || manifest?.options?.runtimeFamily,
  });
  const agyProviderBinding = runProviderKey === 'agy'
    ? (run.agyProviderProfileId || run.providerProfile || manifest?.options?.providerProfile)
    : '';
  if (shouldPersistProviderContextForRun(manifest)
    && (run.claudeSessionId || run.codexThreadId || run.agyConversationId || agyProviderBinding)) {
    sessionChanged = await persistResumeIds(
      sessionId,
      run.claudeSessionId,
      run.codexThreadId,
      run.agyConversationId,
      agyProviderBinding,
      run.model || manifest?.options?.model,
      run.effort || manifest?.options?.effort,
      run.serviceTier || manifest?.serviceTier || manifest?.options?.serviceTier,
    ) || sessionChanged;
  }

  const isStructuredRuntime = projection.runtimeInvocation.isClaudeFamily || projection.runtimeInvocation.isCodexFamily;
  const approvedActionPaused = hasPendingApprovedActionPause(run);
  let result = await getRunResult(runId);
  // Provider-native delegation owns its own terminal barrier.  A provider
  // terminal frame is only a candidate; replay the canonical delegation
  // evidence before any synthetic result or finalization path can mark the
  // parent Run completed.  The same function is also used by the sidecar and
  // therefore remains deterministic after server restart.
  if (
    (run.providerNativeDelegation
      || run.spoolCompletionDetectedAt
      || result
      || normalizedEvents.some((event) => (
        event?.type === 'tool_use'
        && /task|subagent|collab|agent/i.test(String(event.toolName || ''))
      )))
    && (run.provider || run.runtimeFamily)
  ) {
    const providerTerminalCandidate = run.providerNativeDelegation?.terminalCandidate
      || (result
        ? {
          outcome: run.cancelRequested === true || result.cancelled === true
            ? 'cancelled'
            : run.state === 'failed' || result.error || Number(result.exitCode ?? 0) !== 0
              ? 'failed'
              : 'completed',
          ...(run.failureReason ? { reason: run.failureReason } : {}),
        }
        : null);
    const delegationReconciliation = await reconcileProviderNativeDelegationRun({
      runId,
      result,
      terminalCandidate: providerTerminalCandidate,
      providerExited: Boolean(
        run.providerExitedAt
        || run.providerNativeDelegation?.providerExited === true
        || (result && isTerminalRunState(run.state)),
      ),
      providerExitedAtMs: run.providerNativeDelegation?.providerExitedAtMs || null,
      getRun,
      readRunSpoolRecords,
      streamRunSpoolRecords,
      appendRunSpoolRecord,
      updateRun,
      writeRunResult,
    });
    if (delegationReconciliation.handled) {
      run = delegationReconciliation.run || await getRun(runId) || run;
      result = await getRunResult(runId);
    }
  }
  // A reconciliation transition writes its synthetic result into status.json
  // before result.json. After a server restart, let the reconciler repair that
  // narrow interrupted-write window even though the durable state is already
  // terminal; ordinary terminal runs still remain untouched.
  if (!result && !approvedActionPaused) {
    const reconciled = await synthesizeDetachedRunTermination(runId, run);
    if (reconciled) {
      run = reconciled;
      result = await getRunResult(runId);
    }
  }
  // Plain-text runtimes have no portable terminal frame, so an adapter-level
  // completion is the only signal available while process cleanup is pending.
  // Structured/ACP runtimes are deliberately excluded: their explicit
  // terminal frame is only a candidate until the sidecar persists result.json.
  // This prevents a sidecar crash or provider exit during finalization from
  // being turned into a silent successful Run.
  const maySynthesizeProviderCompletion = (
    !run.providerNativeDelegation
    && !isStructuredRuntime
    && !providerRequiresTerminalEvidence(run.runtimeFamily, {
      acp: projection.runtimeInvocation.acp === true,
    })
  );
  if (
    !result
    && !isTerminalRunState(run.state)
    && !approvedActionPaused
    && run.spoolCompletionDetectedAt
    && maySynthesizeProviderCompletion
  ) {
    // `maySynthesizeProviderCompletion` has already excluded provider-native,
    // structured, and explicit-terminal runtimes above.
    const completedAt = run.spoolCompletionDetectedAt;
    const syntheticResult = { completedAt, exitCode: 0, signal: null, synthesized: true };
    await writeRunResult(runId, syntheticResult);
    run = await updateRun(runId, (current) => ({
      ...current,
      state: 'completed',
      completedAt,
      result: syntheticResult,
    })) || run;
    result = syntheticResult;
  }
  const inferredState = approvedActionPaused ? null : deriveRunStateFromResult(run, result);
  const completedAt = typeof result?.completedAt === 'string' && result.completedAt
    ? result.completedAt
    : null;
  const needsTerminalProjection = !run.finalizedAt && (
    isTerminalRunState(run.state)
    || (!!inferredState && !!completedAt)
  );
  let terminalStoredEvents = [];
  let terminalStreamed = false;
  const terminalPendingEvents = [];
  let terminalDedupInitialized = false;
  let terminalDedupKeys = null;
  let terminalDedupNeedsScan = false;
  const flushTerminalPendingEvents = async () => {
    if (terminalPendingEvents.length === 0) return;
    const pending = terminalPendingEvents.splice(0, terminalPendingEvents.length);
    const terminalMessages = await prepareLiveMessageTimeline(sessionId, pending);
    const stored = await appendEvents(sessionId, terminalMessages.events);
    if (stored.length > 0) {
      historyChanged = true;
      // A terminal Run can legitimately produce thousands of durable events,
      // but broadcasting all of them in one invalidation stalls slow clients.
      terminalStoredEvents.push(...stored);
      if (terminalStoredEvents.length > MAX_TERMINAL_PUSH_EVENTS) {
        terminalStoredEvents.splice(0, terminalStoredEvents.length - MAX_TERMINAL_PUSH_EVENTS);
      }
      noteDedupKeysSeen(sessionId, stored);
    }
  };
  const queueTerminalNormalizedEvents = async (normalizedBatch = []) => {
    const durable = limitHarnessDurableEvents(
      normalizedBatch.filter(isDurableChatHistoryEvent),
      eventPolicy,
    );
    if (durable.length === 0) return;
    const hasDedupKey = durable.some((event) => Boolean(getProviderEventReplayKey(event)));
    let unique = durable;
    if (hasDedupKey) {
      if (!terminalDedupInitialized) {
        terminalDedupInitialized = true;
        const seeded = getKnownDedupKeySet(sessionId);
        if (seeded) {
          terminalDedupKeys = seeded;
        } else {
          const scan = await scanProviderDedupKeys(sessionId, durable, {
            retainAllKeys: PERF_OBSERVER_ENABLED,
          });
          terminalDedupKeys = scan.keys instanceof Set ? scan.keys : scan.candidateKeys;
          terminalDedupNeedsScan = !(scan.keys instanceof Set);
          if (scan.keys instanceof Set && !scan.capped) rememberDedupKeySet(sessionId, scan.keys);
        }
      }
      if (terminalDedupNeedsScan) {
        const scan = await scanProviderDedupKeys(sessionId, durable, { retainAllKeys: false });
        unique = filterProviderEventsAgainstScan(durable, scan);
      } else {
        unique = filterUnknownHarnessEvents(durable, terminalDedupKeys || new Set());
      }
    }
    if (unique.length > 0) {
      terminalPendingEvents.push(...unique);
      // Reserve keys immediately as the bounded pending buffer grows; a
      // provider may emit the same snapshot on adjacent spool lines before
      // the next 512-event flush reaches durable history.
      noteDedupKeysSeen(sessionId, unique);
      if (terminalPendingEvents.length >= MAX_TERMINAL_PENDING_EVENTS) {
        await flushTerminalPendingEvents();
      }
    }
  };
  const terminalProjection = needsTerminalProjection
    ? await collectNormalizedRunEvents(run, manifest, {
      skipNormalizedEvents: nextNormalizedEventCount,
      retainNormalizedEvents: MAX_TERMINAL_RETAINED_EVENTS,
      retainSkippedNormalizedEvents: true,
      onNormalizedEvents: async (batch) => {
        terminalStreamed = true;
        await queueTerminalNormalizedEvents(batch);
      },
    })
    : null;
  await flushTerminalPendingEvents();
  const terminalNormalizedEventCount = Number.isInteger(terminalProjection?.normalizedEventCount)
    ? terminalProjection.normalizedEventCount
    : (terminalProjection?.normalizedEvents?.length || nextNormalizedEventCount);
  const terminalTailEvents = terminalProjection && !terminalStreamed
    && terminalProjection.normalizedEvents.length > nextNormalizedEventCount
    ? limitHarnessDurableEvents(
      terminalProjection.normalizedEvents
        .filter(isDurableChatHistoryEvent),
      eventPolicy,
    )
    : [];
  const terminalLatestUsage = terminalProjection?.latestUsage
    || (terminalProjection?.normalizedEvents?.length > 0
      ? [...terminalProjection.normalizedEvents].reverse().find((event) => event.type === 'usage')
      : null);
  const terminalContextInputTokens = Number.isInteger(terminalLatestUsage?.contextTokens)
    ? terminalLatestUsage.contextTokens
    : contextInputTokens;
  const terminalContextWindowTokens = Number.isInteger(terminalLatestUsage?.contextWindowTokens)
    ? terminalLatestUsage.contextWindowTokens
    : contextWindowTokens;

  if (terminalTailEvents.length > 0) {
    // Same gates as the delta path: no durable replay identity → the dedup filter is a
    // no-op → skip the load; seeded known set → unknown keys are new by
    // construction, persist without re-loading history (tail events past the
    // delta cap were never seen by the delta path, so their keys are absent
    // from the set and they flow through as new — correct).
    const tailHasDedupKey = terminalTailEvents.some((event) => Boolean(getProviderEventReplayKey(event)));
    if (tailHasDedupKey) {
      const knownSet = getKnownDedupKeySet(sessionId);
      let uniqueTerminalTailEvents;
      if (PERF_OBSERVER_ENABLED && knownSet) {
        uniqueTerminalTailEvents = filterUnknownHarnessEvents(terminalTailEvents, knownSet);
      } else {
        const scan = await scanProviderDedupKeys(sessionId, terminalTailEvents, {
          retainAllKeys: PERF_OBSERVER_ENABLED,
        });
        uniqueTerminalTailEvents = filterProviderEventsAgainstScan(terminalTailEvents, scan);
        if (scan.keys instanceof Set && !scan.capped) {
          rememberDedupKeySet(sessionId, scan.keys);
        }
      }
      if (uniqueTerminalTailEvents.length > 0) {
        const terminalMessages = await prepareLiveMessageTimeline(sessionId, uniqueTerminalTailEvents);
        terminalStoredEvents = await appendEvents(sessionId, terminalMessages.events);
        historyChanged = true;
        noteDedupKeysSeen(sessionId, uniqueTerminalTailEvents);
      }
    }
  }
  // A terminal projection can stream its newly normalized events through
  // `onNormalizedEvents` (the common path when the active delta observer did
  // not see the final spool frames). In that case `terminalTailEvents` is
  // empty because the events were already queued and flushed above, but the
  // normalized counters still need to be committed. Leaving the update tied
  // to the tail branch made a Run durable/visible as completed with
  // normalizedEventCount=0 even though its final assistant event was already
  // persisted, causing clients and recovery checks to wait forever.
  if (terminalProjection) {
    run = await updateRun(runId, (current) => ({
      ...current,
      normalizedEventCount: Math.max(
        Number.isInteger(current.normalizedEventCount) ? current.normalizedEventCount : 0,
        terminalNormalizedEventCount,
      ),
      lastNormalizedAt: nowIso(),
      ...(Number.isInteger(terminalContextInputTokens) ? { contextInputTokens: terminalContextInputTokens } : {}),
      ...(Number.isInteger(terminalContextWindowTokens) ? { contextWindowTokens: terminalContextWindowTokens } : {}),
    })) || run;
  }
  const zeroStructuredOutputReason = (
    isStructuredRuntime
    && inferredState === 'completed'
    && terminalNormalizedEventCount === 0
  )
    ? await deriveStructuredRuntimeFailureReason(runId, terminalProjection?.preview || projection.preview)
    : null;
  const providerErrorReason = (
    isStructuredRuntime
    && inferredState === 'completed'
  )
    ? deriveStructuredRuntimeProviderErrorReason(
      terminalProjection?.normalizedEvents || [],
      terminalProjection?.preview || projection.preview,
    )
    : null;
  const structuredRuntimeFailureReason = zeroStructuredOutputReason || providerErrorReason;

  // Classify terminal failures for the auth-recovery state machine. Only
  // explicit auth classes annotate the run; everything else stays untouched.
  const terminalFailureText = structuredRuntimeFailureReason
    || (inferredState === 'failed' ? deriveRunFailureReasonFromResult(run, result) : '')
    || run?.failureReason
    || '';
  const runAuthFailureClass = classifyRunAuthFailure({ preview: terminalFailureText });

  if (structuredRuntimeFailureReason) {
    run = await updateRun(runId, (current) => ({
      ...current,
      state: 'failed',
      completedAt,
      result,
      failureReason: structuredRuntimeFailureReason,
      __overrideSuccessfulTerminal: true,
      ...(runAuthFailureClass ? { authRecovery: { ...normalizeRunAuthRecovery(current?.authRecovery), authFailureClass: undefined, lastAuthFailureClass: runAuthFailureClass } } : {}),
    })) || run;
  } else if (runAuthFailureClass) {
    run = await updateRun(runId, (current) => ({
      ...current,
      ...(current?.state !== 'completed' && current?.state !== 'cancelled'
        ? { authRecovery: { ...normalizeRunAuthRecovery(current?.authRecovery), lastAuthFailureClass: runAuthFailureClass } }
        : {}),
    })) || run;
  }

  if (!isTerminalRunState(run.state)) {
    if (inferredState && completedAt) {
      run = await updateRun(runId, (current) => ({
        ...current,
        state: inferredState,
        completedAt,
        result,
        failureReason: inferredState === 'failed'
          ? deriveRunFailureReasonFromResult(current, result)
          : null,
      })) || run;
    }
  }

  if (isTerminalRunState(run.state) && !run.finalizedAt) {
    await reconcileTerminalAgyCredential(run, manifest);
    run = await getRun(runId) || run;
    const finalized = await finalizeDetachedRun(sessionId, run, manifest, terminalProjection?.normalizedEvents || []);
    historyChanged = historyChanged || finalized.historyChanged;
    sessionChanged = sessionChanged || finalized.sessionChanged;
    run = await getRun(runId) || run;
  }

  // Push events even when history hasn't changed — text_delta events are
  // ephemeral (not persisted) so historyChanged stays false, but they still
  // need to reach the frontend for typewriter streaming.
  const pushableEvents = filterSessionDisplayPushEvents([
    ...messageTimeline.starts,
    ...deltaPushEvents,
    ...(terminalStoredEvents || []),
  ]);
  const pushedLatestSeq = pushableEvents.reduce(
    (latest, event) => Math.max(
      latest,
      Number.isInteger(event?.endSeq) ? event.endSeq : 0,
      Number.isInteger(event?.seq) ? event.seq : 0,
    ),
    0,
  );
  if (pushableEvents.length > 0) {
    broadcastSessionEvents(sessionId, pushableEvents, { latestSeq: pushedLatestSeq || null });
  }
  if (historyChanged || sessionChanged) {
    broadcastSessionInvalidation(sessionId, {
      eventsPushed: pushedLatestSeq > 0,
      latestSeq: pushedLatestSeq || null,
    });
  }
  if (isTerminalRunState(run.state)) {
    await releaseAgyRunSlot(runId, { outcome: harnessOutcomeForRun(run) });
    stopObservedRun(runId);
  } else if (hasPendingRunApproval(run) && harnessRunLeases.has(run.id)) {
    yieldHarnessRunBudget(run.id);
  }
  return run;
}

export { resolveSavedAttachments, saveAttachments } from './session-attachments.mjs';

export const AGENT_MESSAGE_PROMPT_KEY = 'agent.perMessageSystemPrompt';

// Resolves the per-message system prompt configured on the session's app
// (template), localized for the session's UI language. Empty string when the
// session's app has no perMessageSystemPrompt catalog.
export async function resolveAgentMessagePrompt(session) {
  const templateId = typeof session?.templateId === 'string' ? session.templateId.trim() : '';
  if (!templateId) return '';
  const execution = currentMessageExecution();
  let catalog;
  if (execution && session.id === execution.scope.sessionId && templateId === execution.configuration.templateId) {
    catalog = execution.configuration.templatePerMessageSystemPrompt;
  } else {
    try { catalog = (await getApp(templateId))?.perMessageSystemPrompt; }
    catch { return ''; }
  }
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return '';
  return pickLocalizedText(catalog, typeof session?.uiLanguage === 'string' ? session.uiLanguage : '');
}

export async function appendAssistantMessage(sessionId, text = '', images = [], options = {}) {
  let session = await getSession(sessionId);
  if (!session) throw new Error('Session not found');
  const normalizedText = typeof text === 'string' ? text.trim() : '';
  const savedImages = options.preSavedAttachments?.length > 0
    ? sanitizeQueuedFollowUpAttachments(options.preSavedAttachments)
    : await saveAttachments(images);
  if (!normalizedText && savedImages.length === 0) {
    const error = new Error('text or attachments are required');
    error.code = 'MESSAGE_EMPTY';
    throw error;
  }

  const event = await appendEvent(sessionId, messageEvent('assistant', normalizedText, buildMessageAttachmentRefs(savedImages), {
    ...(typeof options.canonicalMessageId === 'string' && options.canonicalMessageId.trim()
      ? { canonicalMessageId: options.canonicalMessageId.trim(), textMode: options.textMode || 'snapshot' } : {}),
    ...(typeof options.source === 'string' && options.source.trim() ? { source: options.source.trim() } : {}),
    ...(typeof options.requestId === 'string' && options.requestId.trim() ? { requestId: options.requestId.trim() } : {}),
    ...(typeof options.responseId === 'string' && options.responseId.trim() ? { responseId: options.responseId.trim() } : {}),
    ...(typeof options.runId === 'string' && options.runId.trim() ? { runId: options.runId.trim() } : {}),
    ...(typeof options.resultRunId === 'string' && options.resultRunId.trim() ? { resultRunId: options.resultRunId.trim() } : {}),
    ...(Array.isArray(options.localMarkdownImageRewrites) && options.localMarkdownImageRewrites.length > 0
      ? { localMarkdownImageRewrites: options.localMarkdownImageRewrites }
      : {}),
    ...(Array.isArray(options.localResultFileRewrites) && options.localResultFileRewrites.length > 0
      ? { localResultFileRewrites: options.localResultFileRewrites }
      : {}),
  }));

  const touchedSession = await touchSessionMeta(sessionId);
  if (touchedSession) {
    session = await enrichSessionMeta(touchedSession);
  }
  broadcastSessionInvalidation(sessionId);
  return {
    event: stripEventAttachmentSavedPaths(event),
    session: await getSession(sessionId) || session,
  };
}

async function touchSessionMeta(sessionId, extra = {}) {
  return (await mutateSessionMeta(sessionId, (session) => {
    session.updatedAt = nowIso();
    Object.assign(session, extra);
    return true;
  })).meta;
}

// Explicit S21 provisioning command. The Root Leader ingress only freezes a
// revision; turning that frozen plan into live managed Sessions is a separate
// command so a plan can be reviewed before any internal Session starts. Gated
// on ORG_AUTONOMOUS_PROVISIONING_ENABLED (default off); the real factory is the
// only implementation that knows how a node becomes a Session.
export async function provisionOrganizationRevision({
  organizationId,
  revision,
  idempotencyKey = '',
} = {}) {
  return provisionRootLeadershipRevision({
    organizationId,
    revision,
    createManagedSession: createManagedSessionForNode,
    idempotencyKey,
  });
}

const {
  maybePublishRunResultAssets,
  maybeRunReplySelfCheck,
  maybeSendSessionCompletionPush,
  prepareReplySelfCheck,
  queueSessionCompletionTargets,
  resumePendingCompletionTargets,
  runSessionTurnCompletionEffects,
  scheduleSessionWorkflowStateSuggestion,
} = createSessionTurnCompletionHelpers({
  REPLY_SELF_CHECK_ACCEPT_STATUS,
  REPLY_SELF_CHECK_DEFAULT_REASON,
  REPLY_SELF_CHECK_REVIEWING_STATUS,
  REPLY_SELF_REPAIR_INTERNAL_OPERATION,
  allowsSessionTurnCompletionEffects,
  applyAssistantSessionLabels,
  appendAssistantMessage,
  appendEvent,
  broadcastSessionInvalidation,
  buildReplySelfCheckPrompt,
  buildReplySelfRepairPrompt,
  collectAssistantLocalMarkdownImageRewrites,
  collectAssistantLocalResultFileRewrites,
  collectGeneratedResultFilesFromRun,
  collectUnresolvedAssistantFileReferences,
  contextOperationEvent,
  dispatchSessionEmailCompletionTargets,
  dispatchSessionConnectorActions,
  sanitizeAllCompletionTargets,
  findAssistantAttachmentMessageForRun,
  findResultAssetMessageForRun,
  getCompactionServices,
  getRun,
  getRunManifest,
  getSession,
  getSessionQueueCount,
  getTaskCardFollowupServices,
  getToolDefinitionAsync,
  isInternalSession,
  isReplySelfCheckClearlyComplete,
  isReplySelfCheckWaitingForUser,
  isReplySelfRepairOperation,
  isSessionRunning,
  isTerminalRunState,
  listRunIndexEntries,
  listRunIds,
  loadHistory,
  loadRecentTurnHistory,
  loadReplySelfCheckTurnContext,
  maybeApplyAssistantSessionLabels,
  maybeApplyAssistantTaskCard,
  maybeApplyContextBudget,
  publishDelegatedResult: async ({ session, finalizedRun }) => {
    const parentId = trimString(session?.delegatedFromSessionId);
    if (!parentId || !finalizedRun?.id) return null;
    const parent = await getSession(parentId);
    if (!parent) return null;
    const identity = `${session.id}:${finalizedRun.id}`;
    const alreadyPublished = Boolean(await findLatestStoredEvent(
      parentId,
      (event) => event?.type === 'context_operation'
        && event.operation === 'delegation_result'
        && `${trimString(event.childSessionId)}:${trimString(event.runId)}` === identity,
    ).catch(() => null));
    if (alreadyPublished) return null;
    const result = await getRunResult(finalizedRun.id).catch((error) => {
      if (error?.code === 'LINUX_RUN_RESULT_UNAVAILABLE') throw error;
      return null;
    });
    const history = await loadRunScopedHistory(session.id, finalizedRun.id, {
      includeBodies: true,
      includeAssistantControlBlocks: true,
    });
    const packet = buildDelegationResultFromRun({
      session,
      run: finalizedRun,
      result,
      history,
    });
    await appendEvent(parentId, contextOperationEvent({
      operation: 'delegation_result',
      phase: 'applied',
      trigger: 'delegation',
      title: 'Delegated result received',
      summary: packet.summary || `Delegated task finished with state ${packet.state}.`,
      reason: packet.summary || packet.state,
      childSessionId: session.id,
      runId: finalizedRun.id,
      resultPacketId: identity,
      resultPacket: packet,
    }));
    broadcastSessionInvalidation(parentId);
    return normalizeDelegationResult(packet);
  },
  processCollaborationPlan,
  processRootLeadershipProposal,
  normalizeAttachmentSizeBytes,
  normalizePublishedResultAssetAttachments,
  normalizeSessionWorkflowPriority,
  normalizeSessionWorkflowState,
  nowIso,
  parseReplySelfCheckDecision,
  publishLocalFileAssetFromPath,
  runDetachedAssistantPrompt,
  sanitizeEmailCompletionTargets,
  scheduleQueuedFollowUpDispatch,
  scheduleSessionTaskCardSuggestion,
  sendCompletionPush,
  sendUserAttentionPush,
  sendMessage,
  statusEvent,
  summarizeReplySelfCheckReason,
  triggerSessionWorkflowStateSuggestion,
  updateRun,
  updateSessionWorkflowClassification,
});

async function persistResumeIds(
  sessionId,
  claudeSessionId,
  codexThreadId,
  agyConversationId,
  agyProviderProfileId,
  codexThreadModel,
  codexThreadEffort,
  codexThreadServiceTier,
) {
  return (await mutateSessionMeta(sessionId, (session) => {
    let changed = false;
    if (claudeSessionId && session.claudeSessionId !== claudeSessionId) {
      session.claudeSessionId = claudeSessionId;
      changed = true;
    }
    if (codexThreadId && session.codexThreadId !== codexThreadId) {
      session.codexThreadId = codexThreadId;
      changed = true;
    }
    if (codexThreadId) {
      const normalizedThreadModel = typeof codexThreadModel === 'string' ? codexThreadModel.trim() : '';
      if (normalizedThreadModel && session.codexThreadModel !== normalizedThreadModel) {
        session.codexThreadModel = normalizedThreadModel;
        changed = true;
      }
      const normalizedThreadEffort = typeof codexThreadEffort === 'string' ? codexThreadEffort.trim() : '';
      if (normalizedThreadEffort && session.codexThreadEffort !== normalizedThreadEffort) {
        session.codexThreadEffort = normalizedThreadEffort;
        changed = true;
      }
      const normalizedThreadServiceTier = typeof codexThreadServiceTier === 'string'
        ? codexThreadServiceTier.trim()
        : '';
      if (normalizedThreadServiceTier && session.codexThreadServiceTier !== normalizedThreadServiceTier) {
        session.codexThreadServiceTier = normalizedThreadServiceTier;
        changed = true;
      }
    } else {
      for (const field of ['codexThreadModel', 'codexThreadEffort', 'codexThreadServiceTier']) {
        if (session[field]) {
          delete session[field];
          changed = true;
        }
      }
    }
    if (agyProviderProfileId) {
      if (session.agyProviderProfileId !== agyProviderProfileId) {
        session.agyProviderProfileId = agyProviderProfileId;
        changed = true;
      }
      // A new account starts without the previous account's conversation. If
      // that Run fails before AgY returns a new id, keep the session explicitly
      // bound to the selected account rather than silently falling back to the
      // old account/conversation on the next turn.
      if (!agyConversationId && session.agyConversationId) {
        delete session.agyConversationId;
        changed = true;
      }
    }
    if (agyConversationId && session.agyConversationId !== agyConversationId) {
      session.agyConversationId = agyConversationId;
      changed = true;
    }
    if (changed) {
      session.updatedAt = nowIso();
    }
    return changed;
  })).changed;
}

async function clearPersistedResumeIds(sessionId) {
  return (await mutateSessionMeta(sessionId, (session) => {
    let changed = false;
    if (session.claudeSessionId) {
      delete session.claudeSessionId;
      changed = true;
    }
    if (session.codexThreadId) {
      delete session.codexThreadId;
      changed = true;
    }
    if (session.codexThreadModel) {
      delete session.codexThreadModel;
      changed = true;
    }
    if (session.codexThreadEffort) {
      delete session.codexThreadEffort;
      changed = true;
    }
    if (session.codexThreadServiceTier) {
      delete session.codexThreadServiceTier;
      changed = true;
    }
    if (session.agyConversationId) {
      delete session.agyConversationId;
      changed = true;
    }
    if (session.agyProviderProfileId) {
      delete session.agyProviderProfileId;
      changed = true;
    }
    if (session.providerContext) {
      delete session.providerContext;
      changed = true;
    }
    if (changed) {
      session.updatedAt = nowIso();
    }
    return changed;
  })).changed;
}

function getSessionSortTime(meta) {
  const stamp = Object.prototype.hasOwnProperty.call(meta || {}, 'lastActivityAt')
    ? (meta.lastActivityAt ?? meta?.updatedAt ?? meta?.created ?? '')
    : (meta?.lastEventAt || meta?.updatedAt || meta?.created || '');
  const time = new Date(stamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

function getSessionPinSortRank(meta) {
  return meta?.pinned === true ? 1 : 0;
}

function compareSessionListOrder(a, b) {
  const pinRankA = getSessionPinSortRank(a);
  const pinRankB = getSessionPinSortRank(b);
  const pinDiff = pinRankB - pinRankA;
  if (pinDiff) return pinDiff;

  const sidebarOrderA = normalizeSessionSidebarOrder(a?.sidebarOrder);
  const sidebarOrderB = normalizeSessionSidebarOrder(b?.sidebarOrder);
  if (pinRankA && pinRankB && sidebarOrderA && sidebarOrderB && sidebarOrderA !== sidebarOrderB) {
    return sidebarOrderA - sidebarOrderB;
  }

  const sortTimeDiff = getSessionSortTime(b) - getSessionSortTime(a);
  if (sortTimeDiff) return sortTimeDiff;

  if (sidebarOrderA && sidebarOrderB && sidebarOrderA !== sidebarOrderB) {
    return sidebarOrderA - sidebarOrderB;
  }

  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

function normalizeSessionReviewedAt(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  const time = Date.parse(trimmed);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

// Compatibility selection for concurrent Runs: retain a live pointer; if it
// is absent or terminal, select the newest live Run (id breaks timestamp ties).
// Run status is authoritative; the Session pointer is only a projection.
async function reconcileSessionActiveRuns(meta) {
  if (!meta?.id) return { meta, runs: [] };
  const entries = await listDurableSessionRunIndexEntries(meta.id);
  // Failed Runs can reopen during auth recovery; status can reach disk just
  // before its index append, so hydrate failed summaries as well.
  const ids = new Set(entries.filter(entry =>
    !isTerminalRunState(entry.state) || entry.state === 'failed').map(entry => entry.id));
  if (meta.activeRunId) ids.add(meta.activeRunId);
  const runs = (await Promise.all([...ids].map(id => getRun(id)))).filter(run =>
    run && run.sessionId === meta.id && !isTerminalRunState(run.state) &&
    !(run.appApiMessageQueue && run.state === 'queued'));
  runs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    || String(b.id).localeCompare(String(a.id)));
  const result = await withSessionsMetaMutation(async (rows, save) => {
    const index = rows.findIndex(row => row.id === meta.id);
    if (index < 0) return null;
    const current = rows[index];
    const pointed = current.activeRunId ? await getRun(current.activeRunId) : null;
    if (pointed && pointed.sessionId === meta.id && !isTerminalRunState(pointed.state) &&
        !(pointed.appApiMessageQueue && pointed.state === 'queued')) {
      if (!runs.some(run => run.id === pointed.id)) runs.push(pointed);
      return current;
    }
    let replacement = null;
    for (const candidate of runs) {
      const latest = await getRun(candidate.id);
      if (latest && latest.sessionId === meta.id && !isTerminalRunState(latest.state) &&
          !(latest.appApiMessageQueue && latest.state === 'queued')) {
        replacement = latest.id;
        break;
      }
    }
    if ((current.activeRunId || null) === replacement) return current;
    const draft = { ...current, updatedAt: nowIso() };
    if (replacement) draft.activeRunId = replacement;
    else delete draft.activeRunId;
    rows[index] = draft;
    await save(rows, { immediate: true, durable: true });
    return draft;
  });
  return { meta: result || meta, runs };
}

async function enrichSessionMeta(meta, options = {}) {
  const active = await reconcileSessionActiveRuns(meta);
  meta = active.meta;
  const runtimeState = sessionRuntimeStateById.get(meta.id);
  const hierarchy = buildSessionHierarchyProjection(meta, options.hierarchyIndex);
  const listSummary = options.listSummary === true;
  const snapshot = await getHistorySnapshot(meta.id, {
    ...(listSummary ? { summaryOnly: true } : {}),
    ...(options.strictHistory === true ? { strict: true } : {}),
  });
  const queuedCount = getFollowUpQueueCount(meta);
  const runActivity = await resolveSessionRunActivity(meta);
  const { managerState, workState } = buildSessionControlState(meta);
  const {
    followUpQueue,
    recentFollowUpRequestIds,
    activeRunId,
    activeRun,
    lastAuthRecovery,
    agentId,
    appApiRevision,
    appApiScopeRevision,
    appApiMutationReceipts,
    managerState: _managerState,
    workState: _workState,
    ...rest
  } = meta;
  const sourceId = resolveSessionSourceId(meta);
  const sourceName = resolveSessionSourceName(meta, sourceId);
  const templateId = resolveSessionTemplateId(meta);
  const templateName = resolveSessionTemplateName(meta);
  const scopedAgentId = meta?.visitorId ? resolveSessionAgentId(meta) : '';
  const parentSessionId = hierarchy.parentSessionId
    || (typeof meta?.delegatedFromSessionId === 'string' ? meta.delegatedFromSessionId.trim() : '');
  const parentSession = parentSessionId ? findSessionMetaCached(parentSessionId) : null;
  const parentSessionName = typeof parentSession?.name === 'string' ? parentSession.name.trim() : '';
  let delegationProjection = null;
  if (!listSummary && Number(meta?.delegatedChildCount) > 0) {
    const delegationEvents = await loadRecentDelegationResultEvents(
      meta.id,
      Number(meta.delegatedChildCount),
    );
    delegationProjection = projectDelegationResults(
      delegationEvents,
      meta.delegatedChildCount,
    );
  }
  const rootSessionId = hierarchy.rootSessionId || '';
  const session = {
    ...rest,
    entryMode: resolveSessionEntryMode(meta.entryMode),
    sourceId,
    sourceName,
    ...(scopedAgentId ? { agentId: scopedAgentId } : {}),
    ...(templateId ? { templateId } : {}),
    ...(templateName ? { templateName } : {}),
    ...(rootSessionId ? { rootSessionId } : {}),
    sessionHierarchy: hierarchy,
    sessionLevel: hierarchy.level,
    sessionCategory: hierarchy.category,
    isRootSession: hierarchy.isRoot,
    latestSeq: snapshot.latestSeq,
    lastEventAt: snapshot.lastEventAt,
    lastActivityAt: snapshot.lastActivityAt,
    lastAssistantMessageAt: snapshot.lastAssistantMessageAt,
    messageCount: snapshot.messageCount,
    activeMessageCount: snapshot.activeMessageCount,
    historyStatsState: snapshot.historyStatsState,
    hasVisibleHistory: snapshot.hasVisibleHistory,
    contextMode: snapshot.contextMode,
    activeFromSeq: snapshot.activeFromSeq,
    compactedThroughSeq: snapshot.compactedThroughSeq,
    contextTokenEstimate: snapshot.contextTokenEstimate,
    isInternalSession: isInternalSession(meta),
    ...(parentSessionId ? {
      isDelegatedSession: true,
      parentSessionId,
      ...(parentSessionName ? { parentSessionName } : {}),
    } : {}),
    managerState,
    workState,
    activity: buildSessionActivity(meta, runtimeState, {
      runState: runActivity.state,
      run: runActivity.run,
      queuedCount,
      authRecovery: runActivity.authRecovery,
    }),
    activeRuns: active.runs.map(run => ({ id: run.id, state: run.state, createdAt: run.createdAt || null })),
    ...(delegationProjection ? {
      delegationSummary: {
        total: delegationProjection.total,
        active: delegationProjection.active,
        completed: delegationProjection.completed,
        failed: delegationProjection.failed,
        blocked: delegationProjection.blocked,
        waiting: delegationProjection.waiting,
      },
      delegationResults: delegationProjection.results,
    } : {}),
  };
  const resolvedSessionClass = resolveSessionClass(meta);
  if (resolvedSessionClass) session.sessionClass = resolvedSessionClass;
  if (resolvedSessionClass === 'ROOT_LEADERSHIP') {
    session.userAddressable = meta.userAddressable !== false;
  } else if (isManagedSessionClass(resolvedSessionClass) || meta.sessionPlane === 'organization') {
    session.userAddressable = false;
  }
  const connectors = listSummary ? null : await buildSessionConnectorSurface(session);
  const localBridge = listSummary ? null : await getSessionLocalBridgeSurface(session);
  return {
    ...session,
    ...(connectors ? { connectors } : {}),
    ...(localBridge ? { localBridge } : {}),
  };
}

async function enrichSessionMetaForClient(meta, options = {}) {
  if (!meta) return null;
  const session = await enrichSessionMeta(meta, options);
  if (options.includeQueuedMessages) {
    session.queuedMessages = getFollowUpQueue(meta).map(serializeQueuedFollowUp);
  }
  return session;
}

async function flushDetachedRunIfNeeded(sessionId, runId) {
  if (!sessionId || !runId) return null;
  const run = await getRun(runId);
  if (!run) return null;
  if (!run.finalizedAt || !isTerminalRunState(run.state)) {
    return await syncDetachedRun(sessionId, runId) || await getRun(runId);
  }
  return run;
}

/**
 * Reconcile the durable state that can block a fork before projecting the
 * session for a client.  In particular, an old Run may still be referenced by
 * activeRunId even though its detached runner can no longer be interpreted.
 */
export async function prepareSessionForFork(sessionId) {
  let source = await findSessionMeta(sessionId);
  if (!source) return null;

  const repaired = await repairSessionRuntimeTool(sessionId, source, {
    riskMode: resolveSessionRiskMode(source),
  });
  source = repaired.session || source;

  const activeRunId = trimString(source.activeRunId);
  if (activeRunId) {
    await flushDetachedRunIfNeeded(sessionId, activeRunId);
    source = await findSessionMeta(sessionId) || source;
  }

  const activeRun = trimString(source.activeRunId)
    ? await getRun(source.activeRunId)
    : null;
  return {
    source,
    runtimeBinding: await resolveSessionRuntimeTool(source, {
      riskMode: resolveSessionRiskMode(source),
    }),
    activeRun,
    running: !!activeRun && !isTerminalRunState(activeRun.state),
  };
}

async function reconcileSessionMeta(meta) {
  if (!meta?.activeRunId) return meta;
  await syncDetachedRun(meta.id, meta.activeRunId);
  return await findSessionMeta(meta.id) || meta;
}

async function reconcileSessionsMetaList(list) {
  let changed = false;
  for (const meta of list) {
    if (!meta?.activeRunId) continue;
    await syncDetachedRun(meta.id, meta.activeRunId);
    changed = true;
  }
  return changed ? loadSessionsMeta() : list;
}

function clearRenameState(sessionId, { broadcast = false } = {}) {
  const runtimeState = sessionRuntimeStateById.get(sessionId);
  if (!runtimeState) return false;
  const hadState = !!runtimeState.renameState || !!runtimeState.renameError;
  delete runtimeState.renameState;
  delete runtimeState.renameError;
  if (hadState && broadcast) {
    broadcastSessionInvalidation(sessionId);
  }
  return hadState;
}

async function applyAssistantSessionLabels(sessionId, value, { runId = '' } = {}) {
  const result = await mutateSessionMeta(sessionId, (session) => {
    return applyAssistantSessionLabelsToSession(session, value, {
      runId,
      now: nowIso(),
    });
  });

  if (!result.meta || !result.changed) return null;
  clearRenameState(sessionId);
  broadcastSessionInvalidation(sessionId);
  return enrichSessionMeta(result.meta);
}

function sendToClients(clients, msg) {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    sendWithBackpressure(client, data);
  }
}

function broadcastSessionsInvalidation() {
  broadcastOwners({ type: 'sessions_invalidated' });
}

export function notifyCommittedSessionApiMutation(receipt) {
  if (receipt.kind === 'rename') clearRenameState(receipt.sessionId);
  broadcastSessionInvalidation(receipt.sessionId);
  const meta = findSessionMetaCached(receipt.sessionId);
  if (meta) broadcastScopedSessionsInvalidation(meta);
}

function getAuthPrincipalId(authSession) {
  return resolveAuthSessionPrincipalId(authSession);
}

function getAuthAgentId(authSession) {
  return resolveAuthSessionAgentId(authSession);
}

function getSessionScopedAgentId(session) {
  return resolveSessionAgentId(session);
}

function getSessionScopedPrincipalId(session) {
  return resolveSessionPrincipalId(session);
}

function isAgentScopedAuthSession(authSession) {
  return !!(
    authSession
    && authSession.role === 'visitor'
    && String(authSession?.surfaceMode || '').trim() === 'agent_scoped'
    && getAuthAgentId(authSession)
    && getAuthPrincipalId(authSession)
  );
}

function isSessionVisibleToAuthSession(authSession, sessionId, session) {
  if (!authSession) return false;
  if (authSession.role === 'owner') {
    return shouldExposeSession(session);
  }
  if (isAgentScopedAuthSession(authSession)) {
    return getSessionScopedAgentId(session) === getAuthAgentId(authSession)
      && getSessionScopedPrincipalId(session) === getAuthPrincipalId(authSession);
  }
  return typeof authSession?.sessionId === 'string' && authSession.sessionId === sessionId;
}

function broadcastScopedSessionsInvalidation(session) {
  const clients = getClientsMatching((client) => {
    const authSession = client._authSession;
    if (!authSession) return false;
    if (authSession.role === 'owner') {
      return shouldExposeSession(session);
    }
    return isSessionVisibleToAuthSession(authSession, session?.id, session);
  });
  sendToClients(clients, { type: 'sessions_invalidated' });
}

// Exported so tests and diagnostics can drive the invalidation contract
// directly (DS-10: the invalidation scenarios — operation update, approval,
// compact — all funnel through this generation bump).
export function broadcastSessionInvalidation(sessionId, {
  eventsPushed = false,
  latestSeq = null,
} = {}) {
  // Bump the timeline-bundle generation so any invalidation invalidates the
  // memoized timeline even if latestSeq/run fingerprint did not move. The
  // value carries a timestamp so the DS-07 sweep can retire generation-only
  // entries of long-idle sessions; the bundle key reads `.gen` only.
  const prevGeneration = timelineInvalidationGeneration.get(sessionId)?.gen || 0;
  timelineInvalidationGeneration.set(sessionId, { gen: prevGeneration + 1, at: Date.now() });
  touchSessionRuntimeState(sessionId);
  const session = findSessionMetaCached(sessionId);
  const clients = getClientsMatching((client) => {
    const authSession = client._authSession;
    return isSessionVisibleToAuthSession(authSession, sessionId, session);
  });
  sendToClients(clients, {
    type: 'session_invalidated',
    sessionId,
    ...(eventsPushed === true ? { eventsPushed: true } : {}),
    ...(Number.isInteger(latestSeq) && latestSeq > 0 ? { latestSeq } : {}),
  });
}

async function resolveAppTemplateFreshness(app) {
  const templateContext = app?.templateContext || null;
  const sourceSessionId = typeof templateContext?.sourceSessionId === 'string'
    ? templateContext.sourceSessionId.trim()
    : '';
  const templateUpdatedAt = typeof templateContext?.updatedAt === 'string'
    ? templateContext.updatedAt.trim()
    : '';
  const savedFromSourceUpdatedAt = typeof templateContext?.sourceSessionUpdatedAt === 'string'
    ? templateContext.sourceSessionUpdatedAt.trim()
    : '';

  if (!sourceSessionId) {
    return {
      templateFreshness: 'unknown',
      sourceSessionId: '',
      sourceSessionName: typeof templateContext?.sourceSessionName === 'string'
        ? templateContext.sourceSessionName.trim()
        : '',
      templateUpdatedAt,
      savedFromSourceUpdatedAt,
      currentSourceUpdatedAt: '',
    };
  }

  const sourceSession = await findSessionMeta(sourceSessionId);
  if (!sourceSession) {
    return {
      templateFreshness: 'source_missing',
      sourceSessionId,
      sourceSessionName: typeof templateContext?.sourceSessionName === 'string'
        ? templateContext.sourceSessionName.trim()
        : '',
      templateUpdatedAt,
      savedFromSourceUpdatedAt,
      currentSourceUpdatedAt: '',
    };
  }

  const currentSourceUpdatedAt = typeof sourceSession.updatedAt === 'string' && sourceSession.updatedAt.trim()
    ? sourceSession.updatedAt.trim()
    : (typeof sourceSession.created === 'string' ? sourceSession.created.trim() : '');
  const baselineMs = parseTimestampMs(savedFromSourceUpdatedAt || templateUpdatedAt);
  const currentMs = parseTimestampMs(currentSourceUpdatedAt);

  return {
    templateFreshness: baselineMs > 0 && currentMs > baselineMs ? 'stale' : 'current',
    sourceSessionId,
    sourceSessionName: sourceSession.name || (typeof templateContext?.sourceSessionName === 'string'
      ? templateContext.sourceSessionName.trim()
      : ''),
    templateUpdatedAt,
    savedFromSourceUpdatedAt,
    currentSourceUpdatedAt,
  };
}

async function sessionHasTemplateContextEvent(sessionId) {
  const meta = await loadMeta(sessionId).catch(() => null);
  const indexedCount = Number(meta?.counts?.template_context);
  if (Number.isInteger(indexedCount) && indexedCount >= 0) return indexedCount > 0;
  // Legacy sessions may predate per-type counts. Preserve correctness with a
  // reverse metadata-only lookup, which avoids hydrating the full transcript
  // and usually finds the template marker near the newest context boundary.
  return Boolean(await findLatestStoredEvent(
    sessionId,
    (event) => event?.type === 'template_context',
  ).catch(() => null));
}

function isPreparedForkContextCurrent(prepared, snapshot, contextHead) {
  if (!prepared) return false;

  const summary = typeof contextHead?.summary === 'string' ? contextHead.summary.trim() : '';
  const activeFromSeq = Number.isInteger(contextHead?.activeFromSeq) ? contextHead.activeFromSeq : 0;
  const expectedMode = summary ? 'summary' : 'history';

  return (prepared.mode || 'history') === expectedMode
    && (prepared.summary || '') === summary
    && (prepared.activeFromSeq || 0) === activeFromSeq
    && (prepared.preparedThroughSeq || 0) === (snapshot?.latestSeq || 0);
}

async function prepareForkContextSnapshot(sessionId, snapshot, contextHead) {
  const summary = typeof contextHead?.summary === 'string' ? contextHead.summary.trim() : '';
  const activeFromSeq = Number.isInteger(contextHead?.activeFromSeq) ? contextHead.activeFromSeq : 0;
  const preparedThroughSeq = snapshot?.latestSeq || 0;

  if (summary) {
    const summaryHistoryFromSeq = Math.max(
      activeFromSeq + 1,
      preparedThroughSeq - MAX_FORK_HISTORY_EVENTS + 1,
    );
    const recentEvents = preparedThroughSeq >= summaryHistoryFromSeq
      ? await loadHistory(sessionId, {
          fromSeq: Math.max(1, summaryHistoryFromSeq),
          toSeq: preparedThroughSeq,
          includeBodies: true,
        })
      : [];
    let continuationBody = prepareSessionContinuationBody(recentEvents);
    if (summaryHistoryFromSeq > Math.max(1, activeFromSeq + 1)) {
      continuationBody = `[Ragent note: this handoff includes only the most recent ${recentEvents.length} events (seq ${summaryHistoryFromSeq}–${preparedThroughSeq}) after the active context boundary. Earlier events were omitted to keep context current.]\n\n${continuationBody}`;
    }
    return {
      mode: 'summary',
      summary,
      continuationBody,
      activeFromSeq,
      preparedThroughSeq,
      contextUpdatedAt: contextHead?.updatedAt || null,
      updatedAt: nowIso(),
      source: contextHead?.source || 'context_head',
    };
  }

  if (preparedThroughSeq <= 0) {
    return null;
  }

  // No compaction head: bound to a recent window instead of loading the whole
  // transcript from seq 1 (which re-injects the oldest turns as current context
  // and is the heap/OOM driver for very long sessions).
  const forkHistoryFromSeq = Math.max(1, preparedThroughSeq - MAX_FORK_HISTORY_EVENTS + 1);
  const priorHistory = await loadHistory(sessionId, {
    fromSeq: forkHistoryFromSeq,
    toSeq: preparedThroughSeq,
    includeBodies: true,
  });
  let continuationBody = prepareSessionContinuationBody(priorHistory);
  if (!continuationBody) {
    return null;
  }
  if (forkHistoryFromSeq > 1) {
    continuationBody = `[Ragent note: this handoff includes only the most recent ${priorHistory.length} events (seq ${forkHistoryFromSeq}–${preparedThroughSeq} of the session). Earlier history was omitted to keep context current — re-open the transcript or run a context compaction if you need it.]\n\n${continuationBody}`;
  }

  return {
    mode: 'history',
    summary: '',
    continuationBody,
    activeFromSeq: 0,
    preparedThroughSeq,
    contextUpdatedAt: null,
    updatedAt: nowIso(),
    source: 'history',
  };
}

async function getOrPrepareForkContext(sessionId, snapshot, contextHead) {
  const prepared = await getForkContext(sessionId);
  if (isPreparedForkContextCurrent(prepared, snapshot, contextHead)) {
    return prepared;
  }

  const next = await prepareForkContextSnapshot(sessionId, snapshot, contextHead);
  if (next) {
    await setForkContext(sessionId, next);
    return next;
  }

  await clearForkContext(sessionId);
  return null;
}

async function findResultAssetMessageForRun(sessionId, runId) {
  return findLatestStoredEvent(sessionId, (event) => event?.type === 'message'
    && event.role === 'assistant'
    && event.source === 'result_file_assets'
    && event.resultRunId === runId);
}

async function findAssistantAttachmentMessageForRun(sessionId, runId) {
  return findLatestStoredEvent(sessionId, (event) => event?.type === 'message'
    && event.role === 'assistant'
    && event.runId === runId
    && getMessageAttachments(event).length > 0);
}

async function buildManagerTurnContextText(session, _text = '') {
  return buildTurnContextHook(session);
}

function resolveProviderContextKey(toolId, options = {}) {
  const tool = typeof toolId === 'string' ? toolId.trim() : '';
  const runtimeFamily = trimString(options.runtimeFamily);
  if (tool === 'claude' || tool === 'claude-bidi' || runtimeFamily === 'claude-stream-json-bidi') {
    return 'claude';
  }
  if (tool === 'codex' || tool === 'codex-cli' || ['codex-json', 'codex-app-server-json'].includes(runtimeFamily)) {
    return 'codex';
  }
  if (tool === 'agy' || ['agy-json', 'agy-stream-json'].includes(runtimeFamily)) {
    return 'agy';
  }
  if (tool === 'copilot' || runtimeFamily === 'copilot-json') {
    return 'copilot';
  }
  if (tool === 'hermes' || runtimeFamily === 'hermes-acp') {
    return 'hermes';
  }
  if (tool === 'cline' || runtimeFamily === 'cline-json') {
    return 'cline';
  }
  if (tool === 'kilo' || tool === 'kilo-code' || runtimeFamily === 'kilo-json') {
    return 'kilo';
  }
  return '';
}

function normalizeCoveredThroughSeq(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

const MAX_CONTINUITY_CHECKPOINT_PROMPT_CHARS = 12_000;

function stableFingerprintJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableFingerprintJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableFingerprintJson(value[key])}`).join(',')}}`;
}

function buildContinuityCheckpointPrompt(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return '';
  const payload = {
    schemaVersion: checkpoint.schemaVersion,
    sessionId: checkpoint.sessionId,
    revision: checkpoint.revision,
    coverage: checkpoint.coverage,
    task: checkpoint.task,
    execution: checkpoint.execution,
    bindings: checkpoint.bindings,
    objective: checkpoint.objective,
    status: checkpoint.status,
    completion: checkpoint.completion,
    decisions: checkpoint.decisions,
    files: checkpoint.files,
    validations: checkpoint.validations,
    blockers: checkpoint.blockers,
    nextAction: checkpoint.nextAction,
    requiredUserInput: checkpoint.requiredUserInput,
  };
  let serialized = JSON.stringify(payload);
  if (serialized.length > MAX_CONTINUITY_CHECKPOINT_PROMPT_CHARS) {
    const bounded = {
      ...payload,
      task: payload.task ? {
        ...payload.task,
        decisions: Array.isArray(payload.task.decisions) ? payload.task.decisions.slice(-20) : [],
        completedWork: Array.isArray(payload.task.completedWork) ? payload.task.completedWork.slice(-20) : [],
        failedAttempts: Array.isArray(payload.task.failedAttempts) ? payload.task.failedAttempts.slice(-20) : [],
        blockers: Array.isArray(payload.task.blockers) ? payload.task.blockers.slice(-20) : [],
      } : null,
      execution: payload.execution ? {
        ...payload.execution,
        files: Array.isArray(payload.execution.files) ? payload.execution.files.slice(-40) : [],
        validations: Array.isArray(payload.execution.validations) ? payload.execution.validations.slice(-20) : [],
        approvals: Array.isArray(payload.execution.approvals) ? payload.execution.approvals.slice(-20) : [],
        artifacts: Array.isArray(payload.execution.artifacts) ? payload.execution.artifacts.slice(-20) : [],
      } : null,
      bindings: Array.isArray(payload.bindings) ? payload.bindings.slice(-8) : [],
      decisions: Array.isArray(payload.decisions) ? payload.decisions.slice(-20) : [],
      files: Array.isArray(payload.files) ? payload.files.slice(-40) : [],
      validations: Array.isArray(payload.validations) ? payload.validations.slice(-20) : [],
      blockers: Array.isArray(payload.blockers) ? payload.blockers.slice(-20) : [],
    };
    serialized = JSON.stringify(bounded);
  }
  return `[Ragent continuity checkpoint]\nThis deterministic checkpoint is authoritative for the current Session state. It is not a provider summary.\n${serialized.slice(0, MAX_CONTINUITY_CHECKPOINT_PROMPT_CHARS)}`;
}

export function buildProviderRuntimeFingerprint({ run = null, manifest = null, folder = '' } = {}) {
  const options = manifest?.options && typeof manifest.options === 'object' ? manifest.options : {};
  const capabilities = run?.providerCapabilities || manifest?.providerCapabilities || null;
  const value = [
    run?.runtimeFamily || manifest?.runtimeFamily || manifest?.options?.runtimeFamily || '',
    run?.provider || manifest?.provider || '',
    run?.model || manifest?.options?.model || '',
    run?.effort || manifest?.options?.effort || '',
    run?.serviceTier || manifest?.options?.serviceTier || '',
    run?.providerProfile || manifest?.providerProfile || options.providerProfile || '',
    capabilities ? stableFingerprintJson(capabilities) : '',
    folder || '',
  ].join('\u0000');
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function buildInstructionRevision({ manifest = null } = {}) {
  if (trimString(manifest?.instructionRevision)) return trimString(manifest.instructionRevision);
  const value = [manifest?.developerInstructions || '', manifest?.systemPrefix || '', manifest?.contextRendererVersion || ''].join('\u0000');
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function buildTargetInstructionRevision({ session = null, runtimeFamily = '' } = {}) {
  const value = [
    session?.systemPrompt || '',
    session?.templateId || '',
    runtimeFamily || '',
    CONTEXT_RENDERER_VERSION,
  ].join('\u0000');
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function getProviderContextEntry(session, providerKey) {
  if (!providerKey || !session?.providerContext || typeof session.providerContext !== 'object' || Array.isArray(session.providerContext)) {
    return null;
  }
  const entry = session.providerContext[providerKey];
  return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
}

function getProviderContextCoveredThroughSeq(session, providerKey, resumeId) {
  const entry = getProviderContextEntry(session, providerKey);
  if (!entry) return 0;
  const entryResumeId = trimString(entry.resumeId);
  if (resumeId && entryResumeId && entryResumeId !== resumeId) return 0;
  return normalizeCoveredThroughSeq(entry.coveredThroughSeq);
}

function applyProviderContextUpdate(session, update) {
  const providerKey = trimString(update?.providerKey);
  const resumeId = trimString(update?.resumeId);
  const coveredThroughSeq = normalizeCoveredThroughSeq(update?.coveredThroughSeq);
  if (!providerKey || !resumeId || coveredThroughSeq <= 0) return false;

  const currentContext = session.providerContext && typeof session.providerContext === 'object' && !Array.isArray(session.providerContext)
    ? session.providerContext
    : {};
  const currentEntry = currentContext[providerKey] && typeof currentContext[providerKey] === 'object' && !Array.isArray(currentContext[providerKey])
    ? currentContext[providerKey]
    : {};
  if (trimString(currentEntry.resumeId) === resumeId
    && normalizeCoveredThroughSeq(currentEntry.coveredThroughSeq) === coveredThroughSeq
    && currentEntry.runtimeFingerprint === update.runtimeFingerprint
    && currentEntry.instructionRevision === update.instructionRevision
    && Number(currentEntry.checkpointRevision || 0) === Number(update.checkpointRevision || 0)
    && currentEntry.trustState === update.trustState) {
    return false;
  }

  session.providerContext = {
    ...currentContext,
    [providerKey]: {
      resumeId,
      coveredThroughSeq,
      updatedAt: nowIso(),
      ...(update.runtimeFingerprint ? { runtimeFingerprint: update.runtimeFingerprint } : {}),
      ...(update.instructionRevision ? { instructionRevision: update.instructionRevision } : {}),
      ...(Number.isInteger(update.checkpointRevision) ? { checkpointRevision: update.checkpointRevision } : {}),
      ...(update.trustState ? { trustState: update.trustState } : {}),
      lastValidatedAt: update.lastValidatedAt || nowIso(),
    },
  };
  return true;
}

function clearProviderContextEntry(session, providerKey) {
  const normalizedProviderKey = trimString(providerKey);
  if (!normalizedProviderKey || !session?.providerContext || typeof session.providerContext !== 'object' || Array.isArray(session.providerContext)) {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(session.providerContext, normalizedProviderKey)) {
    return false;
  }
  delete session.providerContext[normalizedProviderKey];
  if (Object.keys(session.providerContext).length === 0) {
    delete session.providerContext;
  }
  return true;
}

function clearStaleClaudeResumeFromSession(session) {
  if (!session || typeof session !== 'object') return false;
  let changed = false;
  if (session.claudeSessionId) {
    delete session.claudeSessionId;
    changed = true;
  }
  changed = clearProviderContextEntry(session, 'claude') || changed;
  return changed;
}

export function resolveResumeState(toolId, session, options = {}) {
  if (options.freshThread === true) {
    return {
      hasResume: false,
      providerKey: '',
      providerResumeId: null,
      claudeSessionId: null,
      codexThreadId: null,
      agyConversationId: null,
      reason: 'FRESH_THREAD_REQUESTED',
    };
  }

  const tool = typeof toolId === 'string' ? toolId.trim() : '';
  const runtimeFamily = trimString(options.runtimeFamily);
  const bindingMismatch = (providerKey, resumeId) => {
    const entry = getProviderContextEntry(session, providerKey);
    if (!entry || !resumeId) return '';
    if (entry.trustState === 'invalidated') return 'BINDING_INVALIDATED';
    if (entry.runtimeFingerprint && options.runtimeFingerprint
      && entry.runtimeFingerprint !== options.runtimeFingerprint) {
      return 'RUNTIME_FINGERPRINT_MISMATCH';
    }
    if (entry.instructionRevision && options.instructionRevision
      && entry.instructionRevision !== options.instructionRevision) {
      return 'INSTRUCTION_REVISION_MISMATCH';
    }
    return '';
  };
  const noResume = (providerKey, reason) => ({
    hasResume: false,
    providerKey,
    providerResumeId: null,
    claudeSessionId: null,
    codexThreadId: null,
    agyConversationId: null,
    reason,
  });
  if (tool === 'claude' || tool === 'claude-bidi' || runtimeFamily === 'claude-stream-json-bidi') {
    const claudeSessionId = session?.claudeSessionId || null;
    if (!claudeSessionId) return noResume('claude', 'NO_NATIVE_SESSION_ID');
    const mismatch = bindingMismatch('claude', claudeSessionId);
    if (mismatch) return noResume('claude', mismatch);
    return {
      hasResume: true,
      providerKey: 'claude',
      providerResumeId: claudeSessionId,
      claudeSessionId,
      codexThreadId: null,
      agyConversationId: null,
      reason: 'BINDING_MATCHED',
    };
  }

  if (tool === 'codex' || tool === 'codex-cli' || ['codex-json', 'codex-app-server-json'].includes(runtimeFamily)) {
    const codexResumeEnabled = options.codexResume === true
      || /^(1|true|yes|on)$/i.test(String(process.env.AGENTOC_CODEX_RESUME_ENABLED || '').trim());
    const codexThreadId = codexResumeEnabled ? (session?.codexThreadId || null) : null;
    if (!codexResumeEnabled) return noResume('codex', 'NATIVE_RESUME_DISABLED');
    if (!codexThreadId) return noResume('codex', 'NO_NATIVE_THREAD_ID');
    const threadModel = trimString(session?.codexThreadModel);
    const desiredModel = trimString(options.model || session?.model);
    if (codexThreadId && threadModel && desiredModel && threadModel !== desiredModel) {
      return noResume('codex', 'MODEL_MISMATCH');
    }
    const mismatch = bindingMismatch('codex', codexThreadId);
    if (mismatch) return noResume('codex', mismatch);
    return {
      hasResume: true,
      providerKey: 'codex',
      providerResumeId: codexThreadId,
      claudeSessionId: null,
      codexThreadId,
      agyConversationId: null,
      reason: 'BINDING_MATCHED',
    };
  }

  if (tool === 'agy' || ['agy-json', 'agy-stream-json'].includes(runtimeFamily)) {
    const conversationId = trimString(session?.agyConversationId);
    if (!conversationId) return noResume('agy', 'NO_NATIVE_CONVERSATION_ID');
    const requestedProvider = trimString(options.providerProfile);
    const boundProvider = trimString(session?.agyProviderProfileId);
    if (requestedProvider && boundProvider && requestedProvider !== boundProvider) {
      return noResume('agy', 'PROVIDER_ACCOUNT_SWITCHED');
    }
    const mismatch = bindingMismatch('agy', conversationId);
    if (mismatch) return noResume('agy', mismatch);
    return {
      hasResume: true,
      providerKey: 'agy',
      providerResumeId: conversationId,
      claudeSessionId: null,
      codexThreadId: null,
      agyConversationId: conversationId,
      reason: 'BINDING_MATCHED',
    };
  }

  const genericProviderKey = resolveProviderContextKey(tool, { runtimeFamily });
  if (['copilot', 'hermes', 'cline', 'kilo'].includes(genericProviderKey)) {
    const entry = getProviderContextEntry(session, genericProviderKey);
    const providerResumeId = trimString(entry?.resumeId);
    if (!providerResumeId) return noResume(genericProviderKey, 'NO_NATIVE_SESSION_ID');
    const mismatch = bindingMismatch(genericProviderKey, providerResumeId);
    if (mismatch) return noResume(genericProviderKey, mismatch);
    return {
      hasResume: true,
      providerKey: genericProviderKey,
      providerResumeId,
      claudeSessionId: null,
      codexThreadId: null,
      agyConversationId: null,
      reason: 'BINDING_MATCHED',
    };
  }

  return noResume('', 'UNSUPPORTED_RUNTIME');
}

function runMatchesProviderContext(run, providerKey, resumeId) {
  if (!run || !providerKey) return false;
  const runProviderKey = resolveProviderContextKey(run.tool, { runtimeFamily: run.runtimeFamily });
  if (runProviderKey !== providerKey) return false;
  const runResumeId = providerKey === 'claude'
    ? trimString(run.claudeSessionId || run.providerResumeId)
    : providerKey === 'agy'
      ? trimString(run.agyConversationId || run.providerResumeId)
      : ['copilot', 'hermes', 'cline', 'kilo'].includes(providerKey)
        ? trimString(run.providerResumeId)
        : trimString(run.codexThreadId || run.providerResumeId);
  return !resumeId || !runResumeId || runResumeId === resumeId;
}

async function inferProviderCoveredThroughSeqFromHistory(sessionId, providerKey, resumeId, latestSeq) {
  if (!providerKey || latestSeq <= 0) return 0;
  const fromSeq = Math.max(1, latestSeq - MAX_PROVIDER_RESUME_DELTA_EVENTS + 1);
  const events = await loadHistory(sessionId, {
    fromSeq,
    includeBodies: false,
  });
  const runCache = new Map();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!Number.isInteger(event?.seq) || event.seq > latestSeq) continue;
    const runId = trimString(event.runId);
    if (!runId) continue;
    if (!runCache.has(runId)) {
      runCache.set(runId, await getRun(runId));
    }
    if (runMatchesProviderContext(runCache.get(runId), providerKey, resumeId)) {
      return event.seq;
    }
  }
  return 0;
}

async function resolveProviderResumeCoveredThroughSeq(sessionId, session, resumeState, snapshot) {
  if (!resumeState?.hasResume) return 0;
  const providerKey = trimString(resumeState.providerKey);
  const resumeId = trimString(resumeState.providerResumeId);
  const stored = getProviderContextCoveredThroughSeq(session, providerKey, resumeId);
  if (stored > 0) return stored;
  return inferProviderCoveredThroughSeqFromHistory(
    sessionId,
    providerKey,
    resumeId,
    normalizeCoveredThroughSeq(snapshot?.latestSeq),
  );
}

async function buildProviderResumeDeltaContinuation(sessionId, snapshot, coveredThroughSeq, previousTool, effectiveTool, binding = {}) {
  const latestSeq = normalizeCoveredThroughSeq(snapshot?.latestSeq);
  if (latestSeq <= 0 || coveredThroughSeq >= latestSeq) return { text: '', receipt: null };
  const continuityCheckpoint = await defaultContinuityStore.read(sessionId).catch(() => null);
  const checkpointCoversLatest = continuityCheckpoint?.coverage?.coveredThroughSeq >= latestSeq
    && Array.isArray(continuityCheckpoint?.coverage?.omittedRanges)
    && continuityCheckpoint.coverage.omittedRanges.length === 0;
  const missingFromSeq = Math.max(1, coveredThroughSeq + 1);
  const fromSeq = Math.max(1, missingFromSeq, latestSeq - MAX_PROVIDER_RESUME_DELTA_EVENTS + 1);
  const events = (await loadHistory(sessionId, {
    fromSeq,
    includeBodies: true,
  })).filter((event) => Number.isInteger(event?.seq) && event.seq <= latestSeq);
  let continuationBody = prepareSessionContinuationBody(events);
  if (!continuationBody) return { text: '', receipt: null };
  const omittedRanges = !checkpointCoversLatest && fromSeq > missingFromSeq
    ? [{ from: missingFromSeq, to: fromSeq - 1 }]
    : [];
  if (!checkpointCoversLatest && fromSeq > missingFromSeq) {
    continuationBody = `[Ragent note: this provider resume thread was behind the canonical Session history. This handoff includes only the most recent ${events.length} missing events (seq ${fromSeq}-${latestSeq}); earlier missing events were omitted to keep context current.]\n\n${continuationBody}`;
  }
  return {
    text: buildSessionContinuationContextFromBody(continuationBody, {
      fromTool: previousTool,
      toTool: effectiveTool,
    }),
    receipt: createContextReceipt({
      sessionId,
      provider: resolveProviderContextKey(effectiveTool, { runtimeFamily: binding.runtimeFamily || '' }),
      resumeId: '',
      checkpointRevision: latestSeq,
      previousCoveredThroughSeq: coveredThroughSeq,
      includedFromSeq: fromSeq,
      includedThroughSeq: latestSeq,
      omittedRanges,
      sourceRevision: latestSeq,
      workspaceRevision: binding.workspaceRevision || '',
      runtimeFingerprint: binding.runtimeFingerprint || '',
      instructionRevision: binding.instructionRevision || '',
      includedSourceRefs: events.map((event) => ({
        ...(Number.isInteger(event?.seq) ? { seq: event.seq } : {}),
        ...(trimString(event?.runId) ? { runId: trimString(event.runId) } : {}),
        ...(trimString(event?.id) ? { eventId: trimString(event.id) } : {}),
      })).filter((ref) => Object.keys(ref).length > 0),
    }),
  };
}

async function buildProviderContextUpdateForFinalizedRun(sessionId, run, manifest = null) {
  const providerKey = resolveProviderContextKey(run?.tool || manifest?.tool, {
    runtimeFamily: run?.runtimeFamily || manifest?.runtimeFamily || manifest?.options?.runtimeFamily,
  });
  if (!providerKey) return null;
  const resumeId = providerKey === 'claude'
    ? trimString(run?.claudeSessionId || manifest?.options?.claudeSessionId || run?.providerResumeId)
    : providerKey === 'agy'
      ? trimString(run?.agyConversationId || manifest?.options?.agyConversationId || run?.providerResumeId)
      : ['copilot', 'hermes', 'cline', 'kilo'].includes(providerKey)
        ? trimString(run?.providerResumeId || manifest?.options?.providerResumeId)
        : trimString(run?.codexThreadId || manifest?.options?.codexThreadId || run?.providerResumeId);
  if (!resumeId) return null;
  const snapshot = await getHistorySnapshot(sessionId);
  const receipt = manifest?.contextReceipt || manifest?.contextRenderer?.contextReceipt || null;
  if (receipt) validateContextReceipt(receipt);
  const coveredThroughSeq = receipt
    ? normalizeCoveredThroughSeq(receipt.coverage?.coveredThroughSeq)
    : normalizeCoveredThroughSeq(manifest?.contextRenderer?.sourceSeq || snapshot?.latestSeq);
  if (coveredThroughSeq <= 0) return null;
  const checkpoint = await defaultContinuityStore.read(sessionId);
  const bindingSession = providerKey === 'codex' ? await getSession(sessionId) : null;
  const fingerprintRun = providerKey === 'codex'
    ? {
      ...run,
      ...(trimString(run?.model) || !trimString(bindingSession?.codexThreadModel)
        ? {}
        : { model: bindingSession.codexThreadModel }),
      ...(trimString(run?.effort) || !trimString(bindingSession?.codexThreadEffort)
        ? {}
        : { effort: bindingSession.codexThreadEffort }),
    }
    : run;
  return {
    providerKey,
    resumeId,
    coveredThroughSeq,
    checkpointRevision: checkpoint?.revision || 0,
    runtimeFingerprint: buildProviderRuntimeFingerprint({ run: fingerprintRun, manifest, folder: manifest?.folder || '' }),
    instructionRevision: buildInstructionRevision({ manifest }),
    trustState: receipt?.coverage?.omittedRanges?.length ? 'bounded-gap' : 'validated',
    lastValidatedAt: nowIso(),
  };
}

function shouldPersistProviderContextForRun(manifest = null) {
  return manifest?.transientProviderContext !== true
    && manifest?.options?.transientProviderContext !== true;
}

function isCodexAppServerRunManifest(manifest) {
  const runtimeFamily = trimString(manifest?.runtimeFamily || manifest?.options?.runtimeFamily);
  return runtimeFamily === 'codex-app-server-json';
}

function isCodexAppServerRunLike(run, manifest = null) {
  const runtimeFamily = trimString(
    manifest?.runtimeFamily
      || manifest?.options?.runtimeFamily
      || run?.runtimeFamily
      || run?.providerCapabilities?.runtimeFamily,
  );
  return runtimeFamily === 'codex-app-server-json';
}

function isClaudeBidiRunManifest(manifest) {
  const runtimeFamily = trimString(manifest?.runtimeFamily || manifest?.options?.runtimeFamily);
  return runtimeFamily === 'claude-stream-json-bidi';
}

function isClaudeBidiRunLike(run, manifest = null) {
  const runtimeFamily = trimString(
    manifest?.runtimeFamily
      || manifest?.options?.runtimeFamily
      || run?.runtimeFamily
      || run?.providerCapabilities?.runtimeFamily,
  );
  return runtimeFamily === 'claude-stream-json-bidi';
}

async function trySteerActiveBidirectionalRun({
  sessionId,
  session,
  activeRun,
  requestId,
  responseId,
  text,
  images,
  options,
} = {}) {
  if (!activeRun) return null;
  if (normalizePlanAction(options?.planAction)) return null;
  if (options?.freshThread === true) return null;
  if ((Array.isArray(images) && images.length > 0) || (Array.isArray(options?.preSavedAttachments) && options.preSavedAttachments.length > 0)) {
    return null;
  }
  const manifest = await getRunManifest(activeRun.id);
  const supportsQueuedSteer = (isCodexAppServerRunLike(activeRun, manifest) && isCodexAppServerRunManifest(manifest))
    || (isClaudeBidiRunLike(activeRun, manifest) && isClaudeBidiRunManifest(manifest));
  if (!supportsQueuedSteer) return null;
  const requestedTool = trimString(options?.tool);
  const activeTool = trimString(manifest?.tool || activeRun?.tool);
  if (requestedTool && activeTool && requestedTool !== activeTool) return null;

  const existingQueue = Array.isArray(activeRun.appServerSteerQueue)
    ? activeRun.appServerSteerQueue
    : [];
  if (existingQueue.some((entry) => trimString(entry?.requestId) === requestId)) {
    return {
      requestId,
      duplicate: true,
      queued: false,
      steered: true,
      run: activeRun,
      session: await getSession(sessionId) || session,
      response: buildReplyPublicationSummary({
        id: responseId,
        responseIds: [responseId],
        state: 'running',
      }),
    };
  }

  const sourceContext = normalizeSourceContext(options?.sourceContext);
  const steerId = generateId();
  await updateRun(activeRun.id, (current) => ({
    ...current,
    appServerSteerQueue: [
      ...(Array.isArray(current?.appServerSteerQueue) ? current.appServerSteerQueue : []),
      {
        id: steerId,
        requestId,
        responseId,
        text,
        state: 'pending',
        createdAt: nowIso(),
      },
    ],
  }));
  const steerSource = isClaudeBidiRunLike(activeRun, manifest)
    ? 'claude-bidi-steer'
    : 'codex-app-server-steer';
  await appendEvent(sessionId, messageEvent('user', text, undefined, {
    requestId,
    responseId,
    runId: activeRun.id,
    source: steerSource,
    ...(sourceContext ? { sourceContext } : {}),
  }));
  broadcastSessionInvalidation(sessionId);
  return {
    requestId,
    duplicate: false,
    queued: false,
    steered: true,
    run: await getRun(activeRun.id) || activeRun,
    session: await getSession(sessionId) || session,
    response: buildReplyPublicationSummary({
      id: responseId,
      responseIds: [responseId],
      state: 'running',
    }),
  };
}

export async function buildPromptEnvelope(sessionId, session, text, previousTool, effectiveTool, snapshot = null, options = {}) {
  const toolDefinition = await getToolDefinitionAsync(effectiveTool);
  const promptMode = toolDefinition?.promptMode === 'bare-user'
    ? 'bare-user'
    : 'default';
  const flattenPrompt = toolDefinition?.flattenPrompt === true;
  const resumeState = resolveResumeState(effectiveTool, session, options);
  const { hasResume } = resumeState;
  let continuationContext = '';
  let providerContextReceipt = null;
  let sourceSeq = null;
  let contextEvents = [];
  let toolResultDescriptors = [];
  let contextPlan = null;
  let contextPlanError = null;
  // `skipSessionContinuation` is used by fresh/transient turns and other
  // intentionally fresh/transient turns.  The checkpoint is another carrier
  // of prior session state, so including it here would defeat the option even
  // when the history handoff below is skipped.
  const continuityCheckpoint = options.skipSessionContinuation === true
    ? null
    : await defaultContinuityStore.read(sessionId).catch(() => null);
  const continuityCheckpointContext = buildContinuityCheckpointPrompt(continuityCheckpoint);

  if (options.skipSessionContinuation !== true) {
    const effectiveSnapshot = snapshot || await getHistorySnapshot(sessionId);
    sourceSeq = effectiveSnapshot?.latestSeq || null;
    if (Number.isInteger(sourceSeq) && sourceSeq > 0) {
      const fromSeq = Math.max(1, sourceSeq - 255);
      contextEvents = await loadHistory(sessionId, {
        fromSeq,
        toSeq: sourceSeq,
        includeBodies: false,
        priority: 'interactive',
      }).catch(() => []);
      toolResultDescriptors = buildToolResultDescriptors(contextEvents, { sessionId });
    }
    if (hasResume) {
      const coveredThroughSeq = await resolveProviderResumeCoveredThroughSeq(
        sessionId,
        session,
        resumeState,
        effectiveSnapshot,
      );
      const delta = await buildProviderResumeDeltaContinuation(
        sessionId,
        effectiveSnapshot,
        coveredThroughSeq,
        previousTool,
        effectiveTool,
        {
          runtimeFingerprint: options.runtimeFingerprint,
          instructionRevision: options.instructionRevision,
          workspaceRevision: options.workspaceRevision,
          runtimeFamily: options.runtimeFamily,
        },
      );
      continuationContext = delta.text;
      providerContextReceipt = delta.receipt;
    } else {
      const contextHead = await getContextHead(sessionId);
      const prepared = await getOrPrepareForkContext(
        sessionId,
        effectiveSnapshot,
        contextHead,
      );
      const workState = buildSessionWorkState(session, {
        contextHead,
        forkContext: prepared,
      });
      continuationContext = buildPreparedContinuationPromptFromWorkState(workState, previousTool, effectiveTool);
    }
  }
  continuationContext = [continuityCheckpointContext, continuationContext].filter(Boolean).join('\n\n---\n\n');

  const managerTurnContext = promptMode === 'default'
    ? await buildManagerTurnContextText(session, text)
    : '';
  const perMessageInstruction = [
    await resolveAgentMessagePrompt(session),
    typeof options.harnessInstructions === 'string' ? options.harnessInstructions.trim() : '',
  ].filter(Boolean).join('\n\n---\n\n');
  let systemContext = '';
  let sourceRuntimePrompt = '';
  let templateInstructions = '';

  if (promptMode === 'default') {
    const isDelegatedChild = typeof session.delegationDepth === 'number' && session.delegationDepth > 0;
    systemContext = await buildSystemContext({
      sessionId,
      ...(isDelegatedChild ? { includeSessionSpawn: false } : {}),
      productAgentCreateEligible: options.productAgentCreateEligible === true,
    });
    sourceRuntimePrompt = buildSourceRuntimePrompt(session);
    if (shouldIncludeSessionTemplateInstructions(session)) {
      templateInstructions = session.systemPrompt;
    }
  }

  // The prompt is the compatibility carrier for every runtime that can run
  // Goal chasing. Codex app-server may also use threadGoal/*, but older Codex
  // servers reject that extension; the prompt must remain sufficient on its
  // own instead of making Goal mode version-dependent.
  const goalInstructions = (isPromptGoalRuntimeFamily(options.runtimeFamily)
    || options.runtimeFamily === 'codex-app-server-json')
    ? buildPromptGoalSection(session?.goal)
    : '';

  const projectMemoryContext = promptMode === 'default' && !isInternalSession(session)
    ? await buildProjectMemoryContext(session).catch((error) => {
      console.warn(`[project-memory] unable to read context for ${sessionId?.slice(0, 8)}: ${error.message}`);
      return '';
    })
    : '';
  if (promptMode === 'default' && session?.projectId && !isInternalSession(session)) {
    void scheduleProjectMemoryRefresh({
      session,
      tool: effectiveTool,
      model: options.model,
      provider: options.provider,
      providerProfile: options.providerProfile,
      trigger: previousTool && previousTool !== effectiveTool ? 'PROVIDER_SWITCH' : 'NEW_SESSION_PREPARE',
    }).catch((error) => console.warn(`[project-memory] freshness failed: ${error.message}`));
  }
  const canonicalContext = buildCanonicalContext({
    runtimeFamily: options.runtimeFamily,
    provider: options.provider,
    providerCapabilities: options.providerCapabilities,
    promptMode,
    flattenPrompt,
    hasResume,
    userText: text,
    previousTool,
    effectiveTool,
    interactionMode: options.interactionMode,
    planAction: options.planAction,
    continuationContext,
    managerTurnContext,
    perMessageInstruction,
    systemContext,
    sourceRuntimePrompt,
    templateInstructions,
    visitorGuardrail: session.visitorId ? VISITOR_TURN_GUARDRAIL : '',
    goalInstructions,
    projectMemoryContext,
    sourceSeq,
    contextBudget: options.contextBudget || null,
  });

  try {
    contextPlan = assembleContextPlan({
      canonicalContext,
      checkpoint: continuityCheckpoint,
      toolResults: toolResultDescriptors,
      recentEvents: contextEvents,
      maxInputTokens: options.maxInputTokens || options.contextWindowTokens || options.contextWindow,
      outputReserveTokens: options.outputReserveTokens,
      sourceRevision: sourceSeq || continuityCheckpoint?.revision || 0,
      workspaceRevision: options.workspaceRevision
        || continuityCheckpoint?.execution?.workspace?.snapshotRevision
        || '',
    });
  } catch (error) {
    if (options.useAttentionPlan === true) throw error;
    contextPlanError = error?.code || 'CONTEXT_PLAN_FAILED';
  }

  const compilerOptions = {
    ...options,
    ...(options.contextBudget ? { budgetOverrides: options.contextBudget } : {}),
    useAttentionPlan: options.useAttentionPlan === true,
  };
  const rendered = compileRuntimeContext({
    context: canonicalContext,
    contextPlan,
    runtimeFamily: options.runtimeFamily,
    options: compilerOptions,
  });
  if (contextPlanError) {
    rendered.metadata = {
      ...(rendered.metadata || {}),
      contextPlanError,
    };
  }
  let freshRecovery = null;
  if (hasResume) {
    const freshCanonicalContext = buildCanonicalContext({
      ...canonicalContext,
      hasResume: false,
      continuationContext: canonicalContext.sections?.continuationContext,
      managerTurnContext: canonicalContext.sections?.managerTurnContext,
      perMessageInstruction: canonicalContext.sections?.perMessageInstruction,
      systemContext: canonicalContext.sections?.systemContext,
      sourceRuntimePrompt: canonicalContext.sections?.sourceRuntimePrompt,
      templateInstructions: canonicalContext.sections?.templateInstructions,
      visitorGuardrail: canonicalContext.sections?.visitorGuardrail,
      planArtifact: canonicalContext.sections?.planArtifact,
      goalInstructions: canonicalContext.sections?.goalInstructions,
      projectMemoryContext: canonicalContext.sections?.projectMemoryContext,
    });
    freshRecovery = compileRuntimeContext({
      context: freshCanonicalContext,
      contextPlan,
      runtimeFamily: options.runtimeFamily,
      options: compilerOptions,
    });
  }
  if (providerContextReceipt) {
    const receiptRefs = [
      ...(Array.isArray(providerContextReceipt.includedSourceRefs) ? providerContextReceipt.includedSourceRefs : []),
      ...(Array.isArray(contextPlan?.receipt?.includedSourceRefs) ? contextPlan.receipt.includedSourceRefs : []),
    ];
    const seenReceiptRefs = new Set();
    const includedSourceRefs = receiptRefs.filter((ref) => {
      const key = JSON.stringify(ref);
      if (seenReceiptRefs.has(key)) return false;
      seenReceiptRefs.add(key);
      return true;
    }).slice(0, 64);
    const receipt = {
      ...providerContextReceipt,
      resumeId: resumeState.providerResumeId || '',
      ...(includedSourceRefs.length > 0 ? { includedSourceRefs } : {}),
      ...(contextPlan?.sessionRevision >= (providerContextReceipt.coverage?.coveredThroughSeq || 0)
        && contextPlan.sessionRevision > 0
        ? { sourceRevision: contextPlan.sessionRevision }
        : {}),
      ...(contextPlan?.workspaceRevision ? { workspaceRevision: contextPlan.workspaceRevision } : {}),
    };
    validateContextReceipt(receipt);
    rendered.metadata = {
      ...(rendered.metadata || {}),
      contextReceipt: receipt,
    };
  }
  return {
    ...rendered,
    ...(freshRecovery ? {
      freshRecoveryPrompt: freshRecovery.prompt,
      freshRecoveryDeveloperInstructions: freshRecovery.developerInstructions || '',
      freshRecoverySystemPrefix: freshRecovery.systemPrefix || '',
      freshRecoveryMetadata: freshRecovery.metadata || null,
    } : {}),
  };
}

export async function buildPrompt(sessionId, session, text, previousTool, effectiveTool, snapshot = null, options = {}) {
  const envelope = await buildPromptEnvelope(sessionId, session, text, previousTool, effectiveTool, snapshot, options);
  return envelope.prompt;
}

function normalizeRunEvents(run, events) {
  const provider = trimString(run?.provider || run?.providerCapabilities?.provider);
  const runtimeFamily = trimString(run?.runtimeFamily || run?.providerCapabilities?.runtimeFamily);
  const providerCapabilities = run?.providerCapabilities && typeof run.providerCapabilities === 'object'
    ? run.providerCapabilities
    : null;
  const permissionMode = trimString(run?.permissionMode);
  const interactionMode = trimString(run?.interactionMode).toLowerCase();
  const planAction = normalizePlanAction(run?.planAction);
  return (events || []).map((event) => ({
    ...event,
    runId: run.id,
    ...(run.requestId ? { requestId: run.requestId } : {}),
    ...(run.responseId ? { responseId: run.responseId } : {}),
    ...(provider && !event.provider ? { provider } : {}),
    ...(runtimeFamily && !event.runtimeFamily ? { runtimeFamily } : {}),
    ...(event.type !== 'text_delta' && providerCapabilities && !event.providerCapabilities
      ? { providerCapabilities }
      : {}),
    ...(event.type !== 'text_delta' && permissionMode && !event.permissionMode
      ? { permissionMode }
      : {}),
    ...(event.type === 'plan'
      ? planEventModeFields(event, { interactionMode, planAction })
      : {}),
  }));
}

// A durable timeline page can contain many historical Run ids.  Enrichment is
// best-effort metadata work, but an unbounded Promise.all here still opens one
// filesystem read/clone chain per id and lets overlapping browser refreshes
// saturate the shared libuv pool. Keep the fan-out bounded while preserving
// input order and the existing failure-isolated semantics.
async function mapWithBoundedConcurrency(items, mapper, concurrency = 8) {
  const source = Array.isArray(items) ? items : [];
  if (source.length === 0) return [];
  const workerCount = Math.max(1, Math.min(source.length, Number.isInteger(concurrency) ? concurrency : 8));
  const results = new Array(source.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= source.length) return;
      results[index] = await mapper(source[index], index);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function enrichPlanEventIntents(events = []) {
  const sourceEvents = Array.isArray(events) ? events : [];
  const unresolvedRunIds = [...new Set(sourceEvents
    .filter((event) => event?.type === 'plan' && !trimString(event?.planIntent))
    .map((event) => trimString(event?.runId))
    .filter(Boolean))];
  const manifestsByRunId = new Map(await mapWithBoundedConcurrency(unresolvedRunIds, async (runId) => [
    runId,
    await getRunManifest(runId),
  ]));
  return sourceEvents.map((event) => {
    if (event?.type !== 'plan') return event;
    const manifest = manifestsByRunId.get(trimString(event.runId));
    const fields = planEventModeFields(event, {
      interactionMode: manifest?.options?.interactionMode,
      planAction: manifest?.options?.planAction,
    });
    if (
      event.planIntent === fields.planIntent
      && (!fields.interactionMode || event.interactionMode === fields.interactionMode)
    ) {
      return event;
    }
    return { ...event, ...fields };
  });
}

// Read-path enrichment: the durable history may omit providerCapabilities (a
// future phase stops embedding it into run events to slim storage). Event
// consumers see capabilities sourced from the authoritative run record, so the
// API surface stays stable regardless of what was persisted. Additive and
// idempotent: events that already carry the field (or never had a run, e.g.
// plain messages and text deltas) pass through untouched.
async function enrichRunCapabilities(events = []) {
  const sourceEvents = Array.isArray(events) ? events : [];
  const unresolvedRunIds = [...new Set(sourceEvents
    .filter((event) => event?.type !== 'text_delta' && !event?.providerCapabilities && trimString(event?.runId))
    .map((event) => trimString(event.runId)))];
  if (unresolvedRunIds.length === 0) return sourceEvents;
  const capabilitiesByRunId = new Map();
  await mapWithBoundedConcurrency(unresolvedRunIds, async (runId) => {
    try {
      const run = await getRun(runId);
      const capabilities = run?.providerCapabilities && typeof run.providerCapabilities === 'object'
        ? run.providerCapabilities
        : null;
      if (capabilities) capabilitiesByRunId.set(runId, capabilities);
    } catch {
      // Run record missing or unreadable — keep the event as persisted rather
      // than failing the read path.
    }
  });
  return sourceEvents.map((event) => {
    if (event?.type === 'text_delta' || event?.providerCapabilities) return event;
    const capabilities = capabilitiesByRunId.get(trimString(event.runId));
    if (!capabilities) return event;
    return { ...event, providerCapabilities: capabilities };
  });
}

async function cancelPendingApprovedActionsForRun(sessionId, run) {
  if (!run?.id) return 0;
  const store = createApprovedActionSessionStore(run);
  let cancelled = 0;
  for (const batch of await store.recover()) {
    if (trimString(batch?.runId) !== trimString(run.id)) continue;
    for (const action of Array.isArray(batch.actions) ? batch.actions : []) {
      const state = trimString(action?.state);
      if ([
        APPROVED_ACTION_STATE.PROPOSED,
        APPROVED_ACTION_STATE.CLASSIFIED,
        APPROVED_ACTION_STATE.WAITING_USER,
        APPROVED_ACTION_STATE.AUTHORIZED,
      ].includes(state)) {
        try {
          const expired = isApprovedActionExpired(action);
          await store.transition(action.actionId, expired ? APPROVED_ACTION_STATE.EXPIRED : APPROVED_ACTION_STATE.CANCELLED, {
            reason: 'Run ended before the owner resolved this action',
            resultRef: { reason: expired ? 'Approval window expired' : 'Run ended before the owner resolved this action' },
          });
          cancelled += 1;
        } catch (error) {
          console.error(`[approved-action] failed to cancel ${action.actionId}: ${error?.message || error}`);
        }
      } else if (state === APPROVED_ACTION_STATE.EXECUTING) {
        try {
          await store.transition(action.actionId, APPROVED_ACTION_STATE.FAILED, {
            reason: 'Run ended before this approved action completed',
            resultRef: { error: 'Run ended before this approved action completed' },
          });
          cancelled += 1;
        } catch (error) {
          console.error(`[approved-action] failed to close ${action.actionId}: ${error?.message || error}`);
        }
      }
    }
  }
  if (cancelled > 0) {
    await updateRun(run.id, (current) => {
      const next = { ...current };
      delete next.approvedActionPending;
      delete next.actionPause;
      return next;
    });
    broadcastSessionInvalidation(sessionId);
  }
  return cancelled;
}

async function finalizeDetachedRun(sessionId, run, manifest, fullNormalizedEvents = []) {
  const directCompaction = manifest?.internalOperation === 'context_compaction';
  const workerCompaction = manifest?.internalOperation === 'context_compaction_worker';
  const compacting = directCompaction || workerCompaction;
  const staleClaudeResumeDetected = !compacting && run?.staleClaudeResumeDetected === true;
  const persistProviderContext = !compacting && !staleClaudeResumeDetected
    && shouldPersistProviderContextForRun(manifest);
  const providerContextUpdate = persistProviderContext
    ? await buildProviderContextUpdateForFinalizedRun(sessionId, run, manifest)
    : null;

  async function persistFinalizedContinuityCheckpoint() {
    const executionScope = manifest?.executionScope || run?.executionScope || {};
    const workspace = manifest?.workspace || run?.workspace || {
      root: manifest?.folder || run?.folder || '',
      snapshotRevision: manifest?.workspaceRevision || executionScope.workspaceRevision,
      observedAt: run?.updatedAt || run?.completedAt || run?.startedAt,
    };
    const git = manifest?.git || run?.git || executionScope.git || null;
    const historyBase = await getHistoryBase(sessionId).catch(() => null);
    let checkpoint = await defaultContinuityStore.read(sessionId).catch(() => null);
    if (historyBase && (!checkpoint || checkpoint.coverage?.coveredThroughSeq < historyBase.throughSeq)) {
      // A newly created shared-prefix child may still be building its first
      // lineage checkpoint. Wait for the bounded streaming index, rather than
      // materializing the parent's logical history in the run finalizer.
      await waitForForkHistoryIndexBuild(sessionId);
      checkpoint = await defaultContinuityStore.read(sessionId).catch(() => null);
    }
    const latestSeq = Number.isInteger(run?.latestSeq)
      ? run.latestSeq
      : (await loadMeta(sessionId)).latestSeq || 0;
    const coveredThroughSeq = Number.isInteger(checkpoint?.coverage?.coveredThroughSeq)
      ? checkpoint.coverage.coveredThroughSeq
      : 0;
    const state = await reduceContinuityHistory(sessionId, {
      ...(historyBase && checkpoint && coveredThroughSeq >= historyBase.throughSeq
        ? { fromSeq: Math.max(1, coveredThroughSeq + 1), initialState: checkpoint }
        : {}),
      toSeq: latestSeq,
      executionInput: { run, workspace, git },
      executionProjection: buildExecutionStateProjection({
        run,
        workspace,
        git,
        processes: run?.processes || manifest?.processes || [],
        artifacts: run?.publishedResultAssets || manifest?.publishedResultAssets || [],
      }),
      ...(providerContextUpdate ? { bindings: [providerContextUpdate] } : {}),
    });
    if (state.coverage.omittedRanges.length > 0) {
      const error = new Error(`continuity history has omitted ranges for ${sessionId}`);
      error.code = 'CONTINUITY_HISTORY_GAP';
      error.omittedRanges = state.coverage.omittedRanges;
      throw error;
    }
    const previous = await defaultContinuityStore.read(sessionId);
    return defaultContinuityStore.write(sessionId, state, {
      expectedRevision: previous?.revision || 0,
    });
  }
  // Runs no longer hold a WorkspaceLease (mutation-scoped lease redesign), so
  // there is no run-scoped lease to release at finalization.
  touchSessionRuntimeState(sessionId);
  let historyChanged = false;
  let sessionChanged = false;
  const runtimeState = sessionRuntimeStateById.get(sessionId);
  const compactionTargetSessionId = typeof manifest?.compactionTargetSessionId === 'string'
    ? manifest.compactionTargetSessionId
    : '';

  // An action proposal is durable outside the provider spool. If the run is
  // cancelled or crashes before the owner resolves it, close those action
  // records as well so replay cannot resurrect an approval pointing at a dead
  // run.
  if (await cancelPendingApprovedActionsForRun(sessionId, run)) {
    historyChanged = true;
  }

  if (run.state === 'cancelled') {
    const event = {
      ...statusEvent('cancelled'),
      runId: run.id,
      ...(run.requestId ? { requestId: run.requestId } : {}),
    };
    await appendEvent(sessionId, event);
    historyChanged = true;
  } else if (run.state === 'failed' && run.failureReason) {
    const event = {
      ...statusEvent(`error: ${run.failureReason}`),
      runId: run.id,
      ...(run.requestId ? { requestId: run.requestId } : {}),
    };
    await appendEvent(sessionId, event);
    historyChanged = true;
  }

  // A run that ends with unanswered approvals leaves the Decision Sheet and
  // in-stream cards on clients pointing at approvals that no longer exist —
  // clicking them would 404. Emit a cancelled approval_response for every
  // pending approval that was never answered (skipping ones already responded
  // or with a queued response that was actually SENT), so every client
  // dismisses them. A queued-but-unsent response (run cancelled/errored before
  // the sidecar flushed it) will never reach the provider — leaving the
  // approval pending would make it re-pop the sheet on every later page load.
  const unansweredApprovals = (Array.isArray(run?.appServerPendingApprovals)
    ? run.appServerPendingApprovals
    : []).filter((entry) => {
    const approvalId = String(entry?.approvalId || "").trim();
    if (!approvalId || String(entry?.state || "") === 'responded') return false;
    const queued = Array.isArray(run?.appServerApprovalResponseQueue)
      ? run.appServerApprovalResponseQueue
      : [];
    return !queued.some((item) =>
      String(item?.approvalId || "").trim() === approvalId
      && String(item?.state || "") === 'sent');
  });
  for (const entry of unansweredApprovals) {
    const responseEvent = approvalResponseEvent({
      approvalId: String(entry.approvalId).trim(),
      decision: 'cancelled',
      status: 'cancelled',
      source: 'run-finalize',
      ...(run.requestId ? { requestId: run.requestId } : {}),
    });
    if (responseEvent) {
      await appendEvent(sessionId, {
        ...responseEvent,
        runId: run.id,
      });
      historyChanged = true;
    }
  }

  // Belt-and-suspenders: the run-state pending list can be empty even when the
  // stream carried a live approval_request (sidecar gate edge cases — e.g.
  // hold paths that only keep in-memory state, or tracking lost to a crash —
  // never persist an entry). A pending request that survives into a terminal
  // run makes the client replay gate pop the card on every page load and the
  // approve/deny clicks 404 forever. Derive unresolved approvals from the
  // run's own normalized events instead of trusting run state alone.
  const cancelIds = new Set(unansweredApprovals
    .map((entry) => normalizeRuntimeApprovalId(String(entry?.approvalId || '')))
    .filter(Boolean));
  for (const event of collectUnansweredApprovalRequests(fullNormalizedEvents, { cancelIds })) {
    const responseEvent = approvalResponseEvent({
      approvalId: String(event.approvalId).trim(),
      decision: 'cancelled',
      status: 'cancelled',
      source: 'run-finalize',
      ...(run.requestId ? { requestId: run.requestId } : {}),
    });
    if (responseEvent) {
      await appendEvent(sessionId, {
        ...responseEvent,
        runId: run.id,
      });
      historyChanged = true;
    }
  }

  // The normalized-events sweep above only sees approvals the adapter still
  // surfaces on replay. Auto-allowed approvals (sidecar autoApproved echo) are
  // suppressed in the replay, but live delta ticks may already have persisted
  // them as pending in session history — cancel those too, keyed by run id, so
  // they cannot re-pop the sheet once the run is gone.
  try {
    const finalizeHistory = await readRuntimeApprovalEventsForRun(sessionId, run.id);
    for (const event of collectUnansweredApprovalRequestsFromHistory(finalizeHistory, run.id, { cancelIds })) {
      const responseEvent = approvalResponseEvent({
        approvalId: String(event.approvalId).trim(),
        decision: 'cancelled',
        status: 'cancelled',
        source: 'run-finalize',
        ...(run.requestId ? { requestId: run.requestId } : {}),
      });
      if (responseEvent) {
        await appendEvent(sessionId, {
          ...responseEvent,
          runId: run.id,
        });
        historyChanged = true;
      }
    }
  } catch (historyErr) {
    // The sweep must never break run finalization.
    console.error(`[finalize] history approval sweep failed for ${sessionId}:`, historyErr?.message || historyErr);
  }

  // Privileged batch approvals ride a separate event channel: one
  // privileged_batch_request event with other/delete (and installAuto) op
  // groups, closed by one privileged_batch_response per group. A run that ends
  // with an unanswered batch leaves the batch sheet open on clients forever —
  // emit a cancelled privileged_batch_response for every group that never got
  // one, so the sheet dismisses exactly like the approval cards above. Group
  // keys are the short names the frontend store matches against.
  const batchResponseKeys = new Set();
  for (const event of Array.isArray(fullNormalizedEvents) ? fullNormalizedEvents : []) {
    if (event?.type !== 'privileged_batch_response') continue;
    const batchId = trimString(event?.batchId);
    const category = trimString(event?.category);
    if (batchId && category) batchResponseKeys.add(`${batchId} ${category}`);
  }
  for (const event of Array.isArray(fullNormalizedEvents) ? fullNormalizedEvents : []) {
    if (event?.type !== 'privileged_batch_request') continue;
    if (trimString(event?.runId) !== run.id) continue;
    const batchId = trimString(event?.batchId);
    if (!batchId) continue;
    for (const category of ['other', 'delete', 'installAuto']) {
      if (!Array.isArray(event?.[category]) || event[category].length === 0) continue;
      if (batchResponseKeys.has(`${batchId} ${category}`)) continue;
      const responseEvent = privilegedBatchResponseEvent({
        batchId,
        category,
        decisions: {},
        source: 'run-finalize',
      });
      if (responseEvent) {
        await appendEvent(sessionId, {
          ...responseEvent,
          runId: run.id,
        });
        historyChanged = true;
      }
    }
  }

  if (compacting) {
    const targetRuntimeState = workerCompaction && compactionTargetSessionId
      ? sessionRuntimeStateById.get(compactionTargetSessionId)
      : runtimeState;
    if (targetRuntimeState) {
      targetRuntimeState.pendingCompact = false;
    }
    if (runtimeState && runtimeState !== targetRuntimeState) {
      runtimeState.pendingCompact = false;
    }

    if (workerCompaction && compactionTargetSessionId) {
      if (run.state === 'completed') {
        if (await applyCompactionWorkerResult(compactionTargetSessionId, run, manifest, getCompactionServices())) {
          // Continuity rebuild must scan every event for its state machine,
          // but it does not need to materialize an unlimited transcript of
          // external message bodies.  Reserve one aggregate body budget so a
          // compaction completion cannot turn a very long session into a
          // multi-gigabyte read/GC pause.
          let continuityBodyBytesRemaining = 4 * 1024 * 1024;
          const continuityBodyMaxBytes = 64 * 1024;
          await rebuildContinuityCheckpoint({
            sessionId: compactionTargetSessionId,
            forEachEvent: (visit) => forEachStoredEvent(compactionTargetSessionId, async (event) => {
              let hydrated = event;
              if (event?.type === 'message'
                && event.bodyAvailable
                && event.bodyLoaded === false
                && continuityBodyBytesRemaining > 0) {
                const bodyBudget = Math.min(continuityBodyMaxBytes, continuityBodyBytesRemaining);
                continuityBodyBytesRemaining -= bodyBudget;
                const body = await readEventBody(compactionTargetSessionId, event.seq, {
                  includeAssistantControlBlocks: true,
                  maxBytes: bodyBudget,
                }).catch(() => null);
                if (body && typeof body.value === 'string') {
                  hydrated = { ...event, [body.field]: body.value, bodyLoaded: true };
                }
              }
              return visit(hydrated);
            }),
          });
          historyChanged = true;
          sessionChanged = true;
        }
      } else if (run.state === 'failed' && run.failureReason) {
        await appendEvent(compactionTargetSessionId, statusEvent(`error: auto compress failed: ${run.failureReason}`));
        historyChanged = true;
      } else if (run.state === 'cancelled') {
        await appendEvent(compactionTargetSessionId, statusEvent('Auto Compress cancelled'));
        historyChanged = true;
      }
    } else if (directCompaction && run.state === 'completed') {
      const workerEvent = await findLatestAssistantMessageForRun(sessionId, run.id);
      const summary = extractTaggedBlock(workerEvent?.content || '', 'summary');
      if (summary) {
        const compactEvent = await appendEvent(sessionId, statusEvent('Context compacted — next message will resume from summary'));
        await setContextHead(sessionId, {
          mode: 'summary',
          summary,
          activeFromSeq: compactEvent.seq,
          compactedThroughSeq: compactEvent.seq,
          inputTokens: run.contextInputTokens || null,
          updatedAt: nowIso(),
          source: 'context_compaction',
        });
        const cleared = await clearPersistedResumeIds(sessionId);
        sessionChanged = sessionChanged || cleared;
        historyChanged = true;
      }
    }
  }

  if (!compacting) {
    const fallbackPlan = await maybeAppendPlanFallbackArtifact(sessionId, run, manifest);
    historyChanged = historyChanged || !!fallbackPlan;
  }

  const finalizedPlanAction = normalizePlanAction(manifest?.options?.planAction);
  const finalizedPlanId = normalizePlanId(manifest?.options?.planId);
  if (!compacting && finalizedPlanAction && finalizedPlanId) {
    const artifact = await findLatestPlanArtifact(sessionId, finalizedPlanId);
    if (artifact) {
      // A cancelled run must NOT resurrect the plan to awaiting_decision —
      // that makes the client replay gate re-pop the Decision Sheet on every
      // full-sync even though the request moment has passed. Terminalize it
      // with the new 'cancelled' state (stale per the client gate); the user
      // can re-trigger the agent if they still want the plan.
      const finalPlanState = finalizedPlanAction === 'execute'
        ? (run.state === 'completed' ? 'completed' : (run.state === 'failed' ? 'failed' : (run.state === 'cancelled' ? 'cancelled' : 'awaiting_decision')))
        : (run.state === 'completed' ? 'superseded' : (run.state === 'cancelled' ? 'cancelled' : 'awaiting_decision'));
      await appendPlanArtifactStateEvent(sessionId, artifact, {
        state: finalPlanState,
        run,
        requestId: run.requestId || manifest?.requestId || '',
        responseId: run.responseId || manifest?.responseId || '',
        lastPlanAction: finalizedPlanAction,
      });
      historyChanged = true;
    }
  }

  // Mid-run plan proposals (agent-proposed ExitPlanMode-style plans outside
  // the manifest planAction flow above) are never terminalized by that block.
  // A proposal left awaiting_decision when its run ends makes the client
  // replay gate re-open the Decision Sheet on every full-sync forever — same
  // stale-card family as unresolved approvals. Terminalize any plan whose
  // latest state in THIS run is awaiting_decision (skipping progress-tracking
  // plans, and plans owned by the planAction flow above). The in-stream plan
  // card stays, and its Execute/Revise buttons keep working — they dispatch a
  // NEW run, never the dead one.
  const planIdsOwnedByPlanAction = finalizedPlanId && finalizedPlanAction
    ? new Set([trimString(finalizedPlanId)])
    : new Set();
  const runPlanStates = new Map(); // planId -> latest plan event in this run
  for (const event of fullNormalizedEvents) {
    if (!event || typeof event !== 'object' || event.type !== 'plan') continue;
    const planId = trimString(event?.planId || '');
    if (!planId || planIdsOwnedByPlanAction.has(planId)) continue;
    runPlanStates.set(planId, event);
  }
  for (const [planId, event] of runPlanStates) {
    const state = String(event?.state || '').trim().toLowerCase();
    const planIntent = String(event?.planIntent || '').trim().toLowerCase();
    if (state !== 'awaiting_decision') continue;
    if (planIntent === 'progress' || String(event?.interactionMode || '').trim().toLowerCase() === 'agent') continue;
    const terminalEvent = planEvent({
      planId,
      title: event.title,
      bodyMarkdown: event.bodyMarkdown,
      items: event.items,
      state: 'cancelled',
      source: 'agentoc-plan-action',
      revision: event.revision,
      providerThreadId: event.providerThreadId,
      providerTurnId: event.providerTurnId,
      previousPlanId: event.previousPlanId,
      lastPlanAction: event.lastPlanAction,
      planIntent: event.planIntent || 'proposal',
    });
    const stored = await appendEvent(sessionId, {
      ...terminalEvent,
      runId: run.id,
      ...(run.requestId ? { requestId: run.requestId } : {}),
    });
    if (stored) {
      broadcastSessionInvalidation(sessionId);
      historyChanged = true;
    }
  }

  // Session-wide sweep: the per-run projection above only sees plans born
  // inside THIS run. A proposal from an EARLIER run whose run has already
  // ended stays awaiting_decision forever — its Decision Sheet re-pops on
  // every full-sync (the same stale-card family as unresolved approvals).
  // Terminalize those too. This runs inside the server process, so appended
  // events share the server's seq/meta state — no external-writer race like
  // a disk-side cleanup script hitting an active session.
  try {
    const sessionEvents = await readPlanEvents(sessionId);
    const sessionPlanStates = new Map(); // planId -> latest plan event (seq order)
    for (const event of sessionEvents) {
      if (!event || typeof event !== 'object' || event.type !== 'plan') continue;
      const planId = trimString(event?.planId || '');
      if (!planId || planIdsOwnedByPlanAction.has(planId)) continue;
      sessionPlanStates.set(planId, event);
    }
    for (const [planId, event] of sessionPlanStates) {
      if (runPlanStates.has(planId)) continue; // current-run sweep handled it
      const state = String(event?.state || '').trim().toLowerCase();
      const planIntent = String(event?.planIntent || '').trim().toLowerCase();
      if (state !== 'awaiting_decision') continue;
      if (planIntent === 'progress' || String(event?.interactionMode || '').trim().toLowerCase() === 'agent') continue;
      const planRunId = trimString(event?.runId || '');
      let planRun = null;
      if (planRunId) {
        try { planRun = await getRun(planRunId); } catch { planRun = null; }
      }
      if (!planRun || !isTerminalRunState(planRun.state)) continue;
      const terminalEvent = planEvent({
        planId,
        title: event.title,
        bodyMarkdown: event.bodyMarkdown,
        items: event.items,
        state: 'cancelled',
        source: 'agentoc-plan-action',
        revision: event.revision,
        providerThreadId: event.providerThreadId,
        providerTurnId: event.providerTurnId,
        previousPlanId: event.previousPlanId,
        lastPlanAction: event.lastPlanAction,
        planIntent: event.planIntent || 'proposal',
      });
      const stored = await appendEvent(sessionId, {
        ...terminalEvent,
        runId: planRunId || run.id,
        ...(run.requestId ? { requestId: run.requestId } : {}),
      });
      if (stored) {
        broadcastSessionInvalidation(sessionId);
        historyChanged = true;
      }
    }
    // Reconcile every persisted approval protocol against its exact run, even
    // for the run being finalized. The direct per-run flush above covers the
    // normal path; this catches approval events that were durable in session
    // history but missing from the normalized projection or run-side cache.
    try {
      const cancelledApprovals = await sweepStaleApprovalsInSession(sessionId, {
        cancelIds,
        requestId: run.requestId || '',
        source: 'run-finalize',
      });
      if (cancelledApprovals > 0) historyChanged = true;
    } catch (approvalSweepErr) {
      console.error(`[finalize] session approval sweep failed for ${sessionId}:`, approvalSweepErr?.message || approvalSweepErr);
    }
  } catch (cleanupErr) {
    // The sweep must never break run finalization.
    console.error(`[finalize] session plan sweep failed for ${sessionId}:`, cleanupErr?.message || cleanupErr);
  }

  // codex goal mode: mirror the latest goal status from this turn's events into
  // session.goal (snapshot only — the objective/tokenBudget/enabled intent is
  // user-owned). Only attaches when the session already has a goal intent; v1
  // does not auto-adopt model-created goals.
  const codexGoalSnapshot = !compacting ? extractCodexGoalSnapshotFromEvents(fullNormalizedEvents) : null;
  const normalizedFinalAuthRecovery = normalizeAuthRecoveryForActivity(run?.authRecovery);
  // `auth_retrying` is an in-flight state and must never survive as an idle
  // session projection if a terminalization race reaches this path.
  const terminalAuthRecovery = normalizedFinalAuthRecovery?.state === 'auth_retrying'
    ? null
    : normalizedFinalAuthRecovery;
  const finalizedMeta = await mutateSessionMeta(sessionId, (session) => {
    let changed = false;
    if (session.activeRunId === run.id) {
      delete session.activeRunId;
      changed = true;
    }
    if (terminalAuthRecovery
        && JSON.stringify(session.lastAuthRecovery || null) !== JSON.stringify(terminalAuthRecovery)) {
      session.lastAuthRecovery = terminalAuthRecovery;
      changed = true;
    }
    if (!compacting) {
      if (staleClaudeResumeDetected) {
        changed = clearStaleClaudeResumeFromSession(session) || changed;
      }
      if (codexGoalSnapshot && session.goal) {
        const snapshotFields = codexGoalSnapshot.cleared
          ? { status: '', tokensUsed: null, timeUsedSeconds: null }
          : {
            status: codexGoalSnapshot.status,
            tokensUsed: codexGoalSnapshot.tokensUsed,
            timeUsedSeconds: codexGoalSnapshot.timeUsedSeconds,
          };
        const nextGoal = applyGoalSnapshot(session.goal, {
          ...snapshotFields,
          updatedAt: codexGoalSnapshot.updatedAt || nowIso(),
        });
        if (nextGoal && JSON.stringify(session.goal) !== JSON.stringify(nextGoal)) {
          session.goal = nextGoal;
          changed = true;
        }
      }
    }
    if (changed) {
      session.updatedAt = nowIso();
    }
    return changed;
  });
  sessionChanged = sessionChanged || finalizedMeta.changed;
  const remainingActive = await reconcileSessionActiveRuns(finalizedMeta.meta);
  if ((remainingActive.meta?.activeRunId || '') !== (finalizedMeta.meta?.activeRunId || '')) sessionChanged = true;
  if (staleClaudeResumeDetected && finalizedMeta.changed) {
    await appendEvent(sessionId, statusEvent('Cleared stale Claude resume id — next message will continue from Ragent history.'));
    historyChanged = true;
  }

  appendFinalizedRunUsageLedger(finalizedMeta.meta, run, manifest, fullNormalizedEvents, sessionId);

  // I-CTX-001..004: the canonical continuity checkpoint must be durable
  // before the run becomes finalized/READY. Provider cursors and compaction
  // remain caches/projections and cannot satisfy this barrier.
  await persistFinalizedContinuityCheckpoint();

  // I-CTX-006: provider cursors are committed only after the canonical
  // checkpoint. If the process dies before this block, the cursor remains
  // behind and the next turn safely replays the missing delta.
  if (!compacting && persistProviderContext && providerContextUpdate) {
    const providerMeta = await mutateSessionMeta(sessionId, (session) => {
      let changed = false;
      if (run.claudeSessionId && session.claudeSessionId !== run.claudeSessionId) {
        session.claudeSessionId = run.claudeSessionId;
        changed = true;
      }
      if (run.codexThreadId && session.codexThreadId !== run.codexThreadId) {
        session.codexThreadId = run.codexThreadId;
        changed = true;
      }
      changed = applyProviderContextUpdate(session, providerContextUpdate) || changed;
      if (changed) session.updatedAt = nowIso();
      return changed;
    });
    sessionChanged = sessionChanged || providerMeta.changed;
  }

  const finalizedRun = await updateRun(run.id, (current) => ({
    ...current,
    finalizedAt: current.finalizedAt || nowIso(),
  })) || run;

  // Wake durable follow-up messages once the active Run pointer, continuity
  // checkpoint, provider cursor, and finalizedAt marker are all durable.
  // Previously this happened only in the optional post-finalization effects
  // pipeline (after result publication, self-check, grouping, etc.). Any
  // slow/failing optional effect could therefore leave a queued message
  // visible forever while no active Run remained to trigger another flush.
  // The queue flusher re-checks activeRunId and is idempotent, so scheduling it
  // here is safe; the later completion-effects call simply coalesces with it.
  if (!compacting) {
    // Re-read after the terminal marker is durable. A user can enqueue the
    // next message concurrently with finalization; using only the earlier
    // mutateSessionMeta snapshot would miss that queue insert and leave it
    // waiting forever because no later active Run exists to wake it.
    const queueSnapshot = await findSessionMeta(sessionId).catch(() => finalizedMeta.meta);
    if (getFollowUpQueueCount(queueSnapshot) > 0) {
      scheduleQueuedFollowUpDispatch(sessionId);
    }
  }

  // Publish one durable terminal signal for deferred session wake-ups. The
  // trigger store owns matching, claim/retry, and idempotency; finalization
  // must remain successful even if an optional wake delivery is unavailable.
  if (!compacting && finalizedRun?.id) {
    void import('./triggers.mjs').then(({ emitTriggerEvent }) => emitTriggerEvent('run_terminal', {
      eventId: finalizedRun.id,
      runId: finalizedRun.id,
      sessionId,
      state: finalizedRun.state,
      completedAt: finalizedRun.completedAt || finalizedRun.finalizedAt || nowIso(),
      failureReason: finalizedRun.failureReason || '',
    })).catch((error) => {
      console.error(`[runs] terminal wake publication failed for ${finalizedRun.id}: ${error.message}`);
    });
  }

  if (compacting) {
    if (workerCompaction && compactionTargetSessionId) {
      const targetSession = await getSession(compactionTargetSessionId);
      if (getSessionQueueCount(targetSession) > 0) {
        scheduleQueuedFollowUpDispatch(compactionTargetSessionId);
      }
      broadcastSessionInvalidation(compactionTargetSessionId);
    } else if (getFollowUpQueueCount(finalizedMeta.meta) > 0) {
      scheduleQueuedFollowUpDispatch(sessionId);
    }
    broadcastSessionInvalidation(sessionId);
    return { historyChanged, sessionChanged };
  }
  scheduleDetachedRunPostFinalization(sessionId, finalizedRun, manifest, fullNormalizedEvents);

  return { historyChanged, sessionChanged };
}

function appendFinalizedRunUsageLedger(session, run, manifest, fullNormalizedEvents = [], sessionId = '') {
  const latestUsageEvent = [...fullNormalizedEvents]
    .reverse()
    .find((event) => event?.type === 'usage');
  if (!session || !latestUsageEvent) {
    return false;
  }
  try {
    const usageRecord = buildUsageLedgerRecord({
      session,
      run,
      usageEvent: latestUsageEvent,
      manifest,
    });
    if (!usageRecord) {
      return false;
    }
    appendUsageLedgerRecord(usageRecord);
    return true;
  } catch (error) {
    console.error(`[usage-ledger] Failed to append run usage for ${sessionId?.slice(0, 8)}: ${error.message}`);
    return false;
  }
}

function scheduleDetachedRunPostFinalization(sessionId, finalizedRun, manifest, fullNormalizedEvents = []) {
  if (!finalizedRun?.id) {
    return null;
  }
  const existing = runPostFinalizePromises.get(finalizedRun.id);
  if (existing) {
    return existing;
  }
  // Keep optional AI follow-up out of syncDetachedRun's shared promise so
  // timeline/history reads only wait for fast run reconciliation.
  const promise = runDetachedRunPostFinalizationEffects(sessionId, finalizedRun, manifest, fullNormalizedEvents)
    .catch((error) => {
      console.error(`[runs] post-finalization effects failed for ${sessionId?.slice(0, 8)}: ${error.message}`);
    })
    .finally(() => {
      if (runPostFinalizePromises.get(finalizedRun.id) === promise) {
        runPostFinalizePromises.delete(finalizedRun.id);
      }
      broadcastSessionInvalidation(sessionId);
    });
  runPostFinalizePromises.set(finalizedRun.id, promise);
  return promise;
}

function isExternalCodexOAuthOwnershipEnabled(environment = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(
    trimString(environment?.AGENTOC_CODEX_NATIVE_EXTERNAL_OAUTH_OWNERSHIP).toLowerCase(),
  );
}

async function detectExternalCodexOAuthRotation({ secretStore, storageRef } = {}) {
  if (!secretStore || typeof secretStore.resolveSecret !== 'function' || !trimString(storageRef)) {
    return { rotated: false, reason: 'native-secret-unavailable' };
  }
  try {
    const {
      inspectExternalCodexAuth,
      nativeOAuthAccountId,
      nativeOAuthTokenFingerprint,
      resolveExternalCodexAuthFile,
    } = await import('../lib/provider-runtime/run-provider-prepare.mjs');
    const nativeSecret = await secretStore.resolveSecret(storageRef);
    if (!nativeSecret?.ok || nativeSecret.authType !== 'oauth') {
      return { rotated: false, reason: 'native-oauth-secret-unavailable' };
    }
    const externalAuth = await inspectExternalCodexAuth({
      externalCodexAuthFile: resolveExternalCodexAuthFile(),
    });
    if (!externalAuth.ok || externalAuth.status !== 'logged-in' || !externalAuth.tokens) {
      return { rotated: false, reason: externalAuth.status || 'external-codex-auth-unavailable' };
    }
    const nativeAccountId = nativeOAuthAccountId(nativeSecret.tokens);
    const externalAccountId = nativeOAuthAccountId(externalAuth.tokens);
    if (!nativeAccountId || !externalAccountId || nativeAccountId !== externalAccountId) {
      return { rotated: false, reason: 'external-codex-account-mismatch' };
    }
    const nativeFingerprint = nativeOAuthTokenFingerprint(nativeSecret.tokens);
    if (!externalAuth.fingerprint || externalAuth.fingerprint === nativeFingerprint) {
      return { rotated: false, reason: 'external-codex-generation-unchanged' };
    }
    return {
      rotated: true,
      accountId: externalAccountId,
      sourceFingerprint: externalAuth.fingerprint,
    };
  } catch (error) {
    return { rotated: false, reason: error?.message || 'external-codex-auth-inspection-failed' };
  }
}

async function runDetachedRunPostFinalizationEffects(sessionId, finalizedRun, manifest, fullNormalizedEvents = []) {
  let latestSession = await getSession(sessionId);
  if (!latestSession) {
    return;
  }

  // Native provider failover is deliberately decided after the failed Run has
  // been finalized, but before result publication/self-check can turn a
  // partial upstream response into the visible answer.  The replacement is a
  // fresh Run with its own immutable provider snapshot; the failed Run remains
  // fully auditable and no global/current provider is changed.
  const failover = await maybeStartNativeProviderFailover(
    sessionId,
    finalizedRun,
    manifest,
    fullNormalizedEvents,
  );
  if (failover?.started) {
    return;
  }

  await maybePublishRunResultAssets(sessionId, finalizedRun, manifest, fullNormalizedEvents);

  if (getProgressiveCompactionLevel(finalizedRun) >= COMPACTION_LEVEL.TRIM_TOOLS) {
    await runSessionTurnCompletionEffects(sessionId, latestSession, finalizedRun, manifest);
    latestSession = await getSession(sessionId) || latestSession;
    scheduleDetachedRunMemoryWriteback(sessionId, latestSession, finalizedRun, manifest);
    scheduleDetachedRunProjectMemory(sessionId, latestSession, finalizedRun, manifest, 'CONTEXT_PRESSURE');
    return;
  }

  const preparedReplySelfCheck = await prepareReplySelfCheck(sessionId, latestSession, finalizedRun, manifest);

  const replySelfCheck = await maybeRunReplySelfCheck(
    sessionId,
    latestSession,
    finalizedRun,
    manifest,
    preparedReplySelfCheck,
  );
  if (replySelfCheck.continued) {
    return;
  }

  latestSession = await getSession(sessionId) || latestSession;
  await runSessionTurnCompletionEffects(sessionId, latestSession, finalizedRun, manifest);
  scheduleDetachedRunMemoryWriteback(sessionId, latestSession, finalizedRun, manifest);
  scheduleDetachedRunProjectMemory(sessionId, latestSession, finalizedRun, manifest, 'TASK_COMPLETE');
}

async function maybeStartNativeProviderFailover(sessionId, finalizedRun, manifest, fullNormalizedEvents = []) {
  if (finalizedRun?.state !== 'failed') return null;
  if (manifest?.internalOperation === 'context_compaction'
      || manifest?.internalOperation === 'context_compaction_worker') {
    return null;
  }
  if (manifest?.options?.providerFailover === false) return null;

  const attempt = Number.isInteger(manifest?.options?.providerFailoverAttempt)
    ? manifest.options.providerFailoverAttempt
    : Number(manifest?.options?.providerFailoverAttempt || 0);
  const classification = classifyProviderFailure(finalizedRun.failureReason);
  const authRetryEligible = classification.kind === 'auth' && attempt === 0;
  if (!shouldFailoverProvider({ failureReason: finalizedRun.failureReason, attempt }) && !authRetryEligible) {
    return null;
  }
  if (hasProviderSideEffects(fullNormalizedEvents)) {
    console.info(`[native-provider-failover] skip ${finalizedRun.id}: run already has tool/approval side effects`);
    return null;
  }

  const tool = trimString(manifest?.tool);
  const runtimeFamily = trimString(manifest?.runtimeFamily || manifest?.options?.runtimeFamily);
  const isCodex = tool === 'codex'
    || tool === 'codex-cli'
    || runtimeFamily.startsWith('codex-');
  const isClaude = tool === 'claude'
    || tool === 'claude-bidi'
    || runtimeFamily.startsWith('claude-');
  const agentType = isCodex ? 'codex' : (isClaude ? 'claude' : '');
  if (!agentType) return null;

  const modelFromManifest = trimString(manifest?.options?.model);
  const modelFromRun = trimString(finalizedRun?.model);

  const modelProviderId = modelFromManifest.includes('@')
    ? modelFromManifest.slice(modelFromManifest.lastIndexOf('@') + 1)
    : '';
  const currentProviderId = trimString(manifest?.options?.providerProfile) || modelProviderId;
  if (!currentProviderId) return null;

  try {
    const { createNativeProviderRegistry, createSecretStore } = await import('../lib/provider-runtime/index.mjs');
    const registry = createNativeProviderRegistry({ configDir: CONFIG_DIR });
    const secretStore = createSecretStore({ configDir: CONFIG_DIR });
    const [profiles, authProfiles] = await Promise.all([
      registry.listProviderProfiles(),
      registry.listAuthProfiles(),
    ]);
    const authById = new Map(authProfiles.map((profile) => [profile.id, profile]));
    const currentProfile = profiles.find((profile) => profile.id === currentProviderId) || null;
    const currentAuth = currentProfile ? authById.get(currentProfile.authProfileId) : null;
    if (
      authRetryEligible
      && agentType === 'codex'
      && currentProfile
      && currentAuth?.authType === 'oauth'
      && isExternalCodexOAuthOwnershipEnabled()
    ) {
      const rotated = await detectExternalCodexOAuthRotation({
        secretStore,
        storageRef: currentAuth.storageRef,
      });
      if (!rotated.rotated) return null;
      const currentModel = bareProviderModel(
        modelFromManifest
        || modelFromRun
        || trimString(currentProfile.modelPolicy?.defaultModel),
      );
      if (!currentModel) return null;
      const currentName = currentProfile.displayName || currentProviderId;
      await appendEvent(sessionId, {
        ...statusEvent(`External Codex credentials changed for ${currentName}; reloading and retrying once.`),
        runId: finalizedRun.id,
        ...(finalizedRun.requestId ? { requestId: finalizedRun.requestId } : {}),
        providerFailover: {
          fromProvider: currentProviderId,
          toProvider: currentProviderId,
          reason: 'external-oauth-rotation',
          attempt: attempt + 1,
          accountId: rotated.accountId,
        },
      });
      const replacement = await regenerateSessionReply(sessionId, finalizedRun.requestId || manifest.requestId, {
        requestId: createInternalRequestId('external-oauth-reload'),
        providerProfile: currentProviderId,
        model: currentModel,
        providerFailoverAttempt: attempt + 1,
        providerFailoverFromProvider: currentProviderId,
        providerFailoverReason: 'external-oauth-rotation',
        providerFailover: true,
      });
      return replacement?.run ? { started: true, run: replacement.run, candidate: { id: currentProviderId, displayName: currentName } } : null;
    }
    // An OAuth account has ownership/refresh semantics that are intentionally
    // not folded into generic upstream failover.  A failed official account
    // therefore stays visible as failed instead of silently changing accounts.
    if (!currentProfile || currentAuth?.authType !== 'api-key') return null;
    const currentModel = agentType === 'claude'
      ? bareProviderModel(modelFromManifest || modelFromRun || 'sonnet')
      : bareProviderModel(
        modelFromManifest
        || modelFromRun
        || trimString(currentProfile.modelPolicy?.defaultModel),
      );
    if (!currentModel) return null;
    const candidates = [];

    for (const profile of profiles) {
      if (profile.id === currentProviderId || profile.agentType !== agentType) continue;
      const auth = authById.get(profile.authProfileId);
      // Do not silently move a failed official OAuth Run to another account.
      // OAuth ownership/refresh is coordinated separately; failover here is
      // restricted to independent API-key credentials.
      if (!auth || auth.authType !== 'api-key') continue;
      const credential = await secretStore.describeSecret(auth.storageRef).catch(() => null);
      if (!credential?.ok || credential.authType !== 'api-key') continue;
      const model = resolveProviderFailoverModel(profile, currentModel, agentType);
      if (!model) continue;
      candidates.push({
        id: profile.id,
        displayName: profile.displayName || profile.id,
        protocol: profile.protocol || '',
        model: model.model,
        exactModel: model.exactModel,
        authType: auth.authType,
      });
    }

    const ranked = rankProviderFailoverCandidates(candidates, {
      currentProtocol: currentProfile?.protocol || '',
    });
    const candidate = ranked[0];
    if (!candidate) return null;

    const currentName = currentProfile?.displayName || currentProviderId;
    await appendEvent(sessionId, {
      ...statusEvent(`Provider ${currentName} failed (${classification.kind}); retrying with ${candidate.displayName}.`),
      runId: finalizedRun.id,
      ...(finalizedRun.requestId ? { requestId: finalizedRun.requestId } : {}),
      providerFailover: {
        fromProvider: currentProviderId,
        toProvider: candidate.id,
        reason: classification.kind,
        attempt: attempt + 1,
      },
    });

    const replacement = await regenerateSessionReply(sessionId, finalizedRun.requestId || manifest.requestId, {
      requestId: createInternalRequestId('failover'),
      providerProfile: candidate.id,
      model: candidate.model,
      providerFailoverAttempt: attempt + 1,
      providerFailoverFromProvider: currentProviderId,
      providerFailoverReason: classification.kind,
      providerFailover: true,
    });
    return replacement?.run ? { started: true, run: replacement.run, candidate } : null;
  } catch (error) {
    console.warn(`[native-provider-failover] unable to start replacement for ${finalizedRun.id}: ${error?.message || error}`);
    return null;
  }
}

function scheduleDetachedRunProjectMemory(sessionId, session, finalizedRun, manifest, trigger) {
  if (manifest?.internalOperation || isInternalSession(session)) return false;
  void scheduleProjectMemoryForFinalizedRun({
    session: { ...session, id: sessionId }, run: finalizedRun, manifest, trigger,
  }).catch((error) => console.warn(`[project-memory] scheduling failed: ${error.message}`));
  return true;
}

function scheduleDetachedRunMemoryWriteback(sessionId, session, finalizedRun, manifest) {
  if (manifest?.internalOperation || isInternalSession(session)) {
    return false;
  }
  void (async () => {
    try {
      const { userMessage, assistantTurnText } = await loadReplySelfCheckTurnContext(
        sessionId, finalizedRun.id, { loadSessionHistory: loadHistory },
      );
      const result = await maybeRunMemoryWriteback({
        sessionId,
        session,
        run: finalizedRun,
        userMessage: userMessage?.content || '',
        assistantTurnText,
        runPrompt: (prompt, promptOptions = {}) => runDetachedAssistantPrompt({
          ...session,
          id: sessionId,
          tool: finalizedRun.tool || session.tool,
          model: undefined,
          effort: 'low',
          thinking: false,
        }, prompt, {
          ...promptOptions,
          usageTracking: {
            ...(promptOptions?.usageTracking || {}),
            operation: 'memory_writeback_review',
          },
        }),
      });
      if (result?.promotedCount > 0) {
        const paths = Array.isArray(result.promotedFiles)
          ? result.promotedFiles.map((filePath) => displayPromptPath(filePath)).filter(Boolean)
          : [];
        await appendEvent(sessionId, contextOperationEvent({
          operation: 'write_memory',
          phase: 'applied',
          trigger: 'automatic',
          title: 'Durable memory updated',
          summary: `Ragent promoted ${result.promotedCount} durable learning(s) for reuse in later turns.`,
          reason: paths.length > 0 ? `Updated: ${paths.join(', ')}` : '',
        }));
      }
    } catch (error) {
      console.error(`[memory-writeback] Async writeback failed for ${sessionId?.slice(0, 8)}: ${error.message}`);
    }
  })();
  return true;
}

async function reconcileOrphanDetachedRuns() {
  if (orphanRunSweepPromise) return orphanRunSweepPromise;
  orphanRunSweepPromise = (async () => {
    // The durable index lets routine orphan sweeps skip terminal history
    // without opening every status.json.  Keep a compatibility fallback for
    // a pre-index installation or a transient index read failure.
    let candidates;
    try {
      candidates = await listRunIndexEntries({ reverse: true });
    } catch {
      candidates = (await listRunIds()).map((id) => ({ id }));
    }
    candidates = candidates.filter((entry) => (
      !isTerminalRunState(entry?.state) && entry?.state !== 'waiting_user'
    ));
    for (let index = 0; index < candidates.length; index += 1) {
      if (index > 0 && index % STARTUP_RECOVERY_BATCH_SIZE === 0) await yieldToEventLoop();
      const runId = trimString(candidates[index]?.id);
      if (!runId) continue;
      if (observedRuns.has(runId)) continue;
      const run = await getRun(runId).catch(() => null);
      if (!run || isTerminalRunState(run.state) || run.state === 'waiting_user') continue;
      if (run.appApiMessageVersion === 1 && !hasRegisteredDetachedRunner(run) &&
          (run.appApiMessageQueue || ['preparing', 'accepted'].includes(run.state))) {
        scheduleScopedMessageRun(run.sessionId, runId);
        continue;
      }
      if (run.state === 'queued') {
        if (run.adaptiveQueue?.reason === 'adaptive_capacity') adaptiveQueuedRunIds.add(runId);
        continue;
      }
      if (run.state === 'preparing' && (await getRunManifest(runId).catch(() => null))?.preparation) {
        schedulePreparingRun(run.sessionId, runId);
        continue;
      }
      // Concurrent derived Runs remain independently observable even when
      // another Run is the Session's compatibility selection.
      observeDetachedRun(run.sessionId, runId);
      const anchorMs = Date.parse(
        run.runnerHeartbeatAt || run.updatedAt || run.createdAt || '',
      );
      if (!Number.isFinite(anchorMs) || (Date.now() - anchorMs) < DETACHED_RUN_LAUNCH_GRACE_MS) continue;
      // syncDetachedRun invokes the same PID/unit checks and missing-result
      // synthesizer as normal observers. This sweep covers the race where a
      // process died before session metadata advertised activeRunId, as well as
      // Runs left behind by a supervisor crash.
      const manifest = await getRunManifest(runId).catch(() => null);
      adoptHarnessRunBudget(run, manifest);
      await syncDetachedRun(run.sessionId, runId);
    }
  })().finally(() => {
    orphanRunSweepPromise = null;
  });
  return orphanRunSweepPromise;
}

async function syncDetachedRun(sessionId, runId) {
  // Same-run dedup is for fast exactly-once reconciliation only.
  if (!runId) return null;
  if (runSyncPromises.has(runId)) {
    return runSyncPromises.get(runId);
  }
  const promise = (async () => {
    try {
      return await syncDetachedRunUnlocked(sessionId, runId);
    } catch (error) {
      // A single run whose runtime can't be built (e.g. template/plan runs using
      // the 'missing-tool' sentinel, or a run missing runtimeFamily) must never
      // abort the whole rehydrate loop or the request-path timeline build.
      console.error(`[runs] Skipping sync for ${runId}: ${error.message}`);
      return null;
    }
  })()
    .finally(() => {
      if (runSyncPromises.get(runId) === promise) {
        runSyncPromises.delete(runId);
      }
    });
  runSyncPromises.set(runId, promise);
  return promise;
}

export async function startDetachedRunObservers() {
  let allSessions = await loadSessionsMeta();
  for (const meta of allSessions) await reconcileSessionActiveRuns(meta);
  allSessions = await loadSessionsMeta();
  // A prior process can exit after a provider marks a Run terminal but before
  // the historical projection supplies finalizedAt. Reclaim those durable
  // account slots before rehydrating queued work, otherwise every later AgY
  // request remains stuck before its runner is even created.
  await reclaimTerminalAgyAccountLocksAtStartup();
  const completionTargetSessionIds = new Set(
    allSessions
      .filter((meta) => Array.isArray(meta?.completionTargets) && meta.completionTargets.length > 0)
      .map((meta) => trimString(meta?.id || ''))
      .filter(Boolean),
  );
  const sessions = allSessions.filter((meta) => (
    !!meta?.activeRunId
    || getPendingPlanningQueueCount(meta) > 0
    || getFollowUpQueueCount(meta) > 0
  ));
  for (let index = 0; index < sessions.length; index += 1) {
    if (index > 0 && index % STARTUP_RECOVERY_BATCH_SIZE === 0) await yieldToEventLoop();
    const meta = sessions[index];
    try {
      if (meta?.activeRunId) {
        let run = await getRun(meta.activeRunId);
        const manifest = run ? await getRunManifest(run.id).catch(() => null) : null;
        if (run?.authRecovery?.authRetryState === 'auth_retrying'
            && RESUMABLE_AUTH_RECOVERY_LAUNCH_STATES.has(run?.runnerLaunchState)) {
          // A restart may land after the failed sidecar accepted the durable
          // recovery hand-off, after local state reset, or while the broker
          // request is in flight. The generation-specific unit makes replay
          // idempotent, so resume all pre-acceptance phases instead of treating
          // the intentionally empty runner window as a disappeared Run.
          scheduleRunAuthRecoveryLaunch(run.id);
          continue;
        } else if (run?.appApiMessageVersion === 1 && !hasRegisteredDetachedRunner(run) &&
            (run.appApiMessageQueue || ['preparing', 'accepted'].includes(run.state))) {
          scheduleScopedMessageRun(meta.id, run.id);
        } else if (run?.state === 'preparing' && manifest?.preparation) {
          schedulePreparingRun(meta.id, run.id);
        } else if (run?.state === 'queued' && run.adaptiveQueue?.reason === 'adaptive_capacity') {
          adaptiveQueuedRunIds.add(run.id);
        } else if (run?.state === 'queued' && isAgyRunManifest(manifest, run)) {
          await launchDetachedRunWithAgySlot(meta.id, run, manifest);
          run = await getRun(run.id) || run;
        } else {
          if (run && !isTerminalRunState(run.state) && run.state !== 'queued') {
            // Re-attach an adaptive lease to work that survived a control
            // plane restart. Adoption bypasses the current soft limit so
            // recovery never duplicates or kills an already-running harness.
            adoptHarnessRunBudget(run, manifest);
          }
          if (run && !isTerminalRunState(run.state) && isAgyRunManifest(manifest, run)) {
            // Reclaim the durable slot before observing a process that was
            // launched by the previous control-plane instance.
            await adoptAgyRunSlot(run, manifest);
          }
          run = await syncDetachedRun(meta.id, meta.activeRunId) || run;
        }
        if (run && !isTerminalRunState(run.state)
          && !(run.state === 'queued' && run.adaptiveQueue?.reason === 'adaptive_capacity')) {
          observeDetachedRun(meta.id, meta.activeRunId);
          continue;
        }
      }
      if (getPendingPlanningQueueCount(meta) > 0) {
        schedulePendingDispatchFlush(meta.id, 0);
      }
      if (getFollowUpQueueCount(meta) > 0) {
        scheduleQueuedFollowUpDispatch(meta.id);
      }
    } catch (error) {
      // Defense in depth: one bad session/run must never abort observer startup
      // for every other session.
      console.error(`[runs] Observer startup skipped session ${meta?.id}: ${error.message}`);
    }
  }
  await reconcileOrphanDetachedRuns();
  await drainQueuedAgyRuns();
  if (process.platform === 'linux' && process.env.AGENTOC_LINUX_RUN_SCOPE_GRANTS === '1' && !linuxRunScopeRecoveryTimer) {
    const recover = (scanAll = false) => {
      if (linuxRunScopeRecoveryPromise) return;
      linuxRunScopeRecoveryPromise = recoverLinuxRunScopeRevocations({ scanAll })
        .catch((error) => console.error(`[runs] privileged scope recovery failed: ${error.message}`))
        .finally(() => { linuxRunScopeRecoveryPromise = null; });
    };
    recover(true);
    linuxRunScopeRecoveryTimer = setInterval(() => recover(false), 15_000);
    linuxRunScopeRecoveryTimer.unref?.();
  }
  if (process.platform === 'linux' && process.env.AGENTOC_LINUX_RUN_SCOPE_GRANTS === '1' && !linuxRunScopeRenewalTimer) {
    const renewalSweep = import('./linux-run-scope-renewal.mjs')
      .then(({ createLinuxRunScopeRenewalSweep }) => createLinuxRunScopeRenewalSweep());
    const renew = (scanAll = false) => {
      if (linuxRunScopeRenewalPromise) return;
      linuxRunScopeRenewalPromise = renewalSweep.then((sweep) => sweep({ scanAll }))
        .catch((error) => console.error(`[runs] privileged scope renewal failed: ${error.message}`))
        .finally(() => { linuxRunScopeRenewalPromise = null; });
    };
    renew(true);
    linuxRunScopeRenewalTimer = setInterval(() => renew(false), 30_000);
    linuxRunScopeRenewalTimer.unref?.();
  }
  if (process.platform === 'linux' && process.env.AGENTOC_LINUX_RUN_SCOPE_GRANTS === '1' && !linuxRunScopeOutboxTimer) {
    const outboxRecovery = import('./linux-run-revocation-outbox.mjs')
      .then(({ createLinuxRunRevocationOutboxRecovery }) => createLinuxRunRevocationOutboxRecovery());
    const recoverOutbox = () => {
      if (linuxRunScopeOutboxPromise) return;
      linuxRunScopeOutboxPromise = outboxRecovery.then((recover) => recover())
        .then(({ invalid }) => { if (invalid) console.error(`[runs] ${invalid} invalid privileged scope revocation records`); })
        .catch((error) => console.error(`[runs] privileged scope outbox recovery failed: ${error.message}`))
        .finally(() => { linuxRunScopeOutboxPromise = null; });
    };
    recoverOutbox();
    linuxRunScopeOutboxTimer = setInterval(recoverOutbox, 15_000);
    linuxRunScopeOutboxTimer.unref?.();
  }
  if (process.platform === 'linux' && !linuxRunResultTransactionTimer) {
    const recovery = import('./linux-run-result-transaction-recovery.mjs')
      .then(({ createLinuxRunResultTransactionRecovery }) => createLinuxRunResultTransactionRecovery());
    const recoverTransactions = () => {
      if (linuxRunResultTransactionPromise) return;
      linuxRunResultTransactionPromise = recovery.then((recover) => recover())
        .then(({ invalid }) => { if (invalid) console.error(`[runs] ${invalid} invalid result transactions`); })
        .catch((error) => console.error(`[runs] result transaction recovery failed: ${error.message}`))
        .finally(() => { linuxRunResultTransactionPromise = null; });
    };
    recoverTransactions();
    linuxRunResultTransactionTimer = setInterval(recoverTransactions, 15_000);
    linuxRunResultTransactionTimer.unref?.();
  }
  if (!orphanRunSweepTimer) {
    orphanRunSweepTimer = setInterval(() => {
      void reconcileOrphanDetachedRuns().catch((error) => {
        console.error(`[runs] orphan sweep failed: ${error.message}`);
      });
    }, ORPHAN_RUN_SWEEP_INTERVAL_MS);
    if (typeof orphanRunSweepTimer.unref === 'function') orphanRunSweepTimer.unref();
  }
  // If no compact session metadata advertises completion targets, avoid
  // scanning every historical run directory at boot.
  await resumePendingCompletionTargets({ targetSessionIds: completionTargetSessionIds });

  // DS-07: retire runtime state / generation entries of sessions idle past the
  // TTL. Booted here (with the observers) so restart recovery is complete
  // before the first sweep can run. Guards are restart-safe: active runs and
  // pending queues are re-observed/re-scheduled above and re-protected.
  startSessionRuntimeStateSweep();
  scheduleAdaptiveRunDrain(0);
}

export async function listSessions({
  includeVisitor = false,
  includeNonUserAddressable = false,
  rootOnly = false,
  templateId = '',
  sourceId = '',
  projectId = '',
  includeQueuedMessages = false,
  listSummary = false,
  limit = 0,
} = {}) {
  await ensureProjectsInitialized();
  const metas = await loadSessionsMeta();
  const normalizedTemplateId = normalizeAppId(templateId);
  const normalizedSourceId = normalizeAppId(sourceId);
  const normalizedProjectId = normalizeProjectId(projectId);
  const hierarchyIndex = buildSessionHierarchyIndex(metas);
  // Sessions without a project binding stay
  // visible under the selected project when their folder belongs to that
  // project's root — mirroring the frontend agentocSessionMatchesSelectedWorkspace
  // fallback contract. Without this, a project-scoped list request hides them
  // entirely even though the same session shows up in the folder-scoped view.
  const projectRootPath = normalizedProjectId
    ? expandProjectRootPath((await getProject(normalizedProjectId))?.rootPath || '')
    : '';
  const filtered = metas
    .filter((meta) => includeVisitor || !meta.visitorId)
    .filter((meta) => shouldExposeSession(meta))
    .filter((meta) => includeNonUserAddressable || isUserAddressableSession(meta))
    .filter((meta) => !rootOnly || isRootSessionMeta(meta, hierarchyIndex))
    .filter((meta) => !normalizedTemplateId || resolveSessionTemplateId(meta) === normalizedTemplateId)
    .filter((meta) => !normalizedSourceId || resolveSessionSourceId(meta) === normalizedSourceId)
    .filter((meta) => {
      if (!normalizedProjectId) return true;
      if (normalizeProjectId(meta.projectId) === normalizedProjectId) return true;
      return meta.projectDetached !== true
        && !meta.projectId
        && !!meta.folder
        && !!projectRootPath
        && expandProjectRootPath(meta.folder) === projectRootPath;
    });
  const normalizedLimit = Number.isInteger(limit) && limit > 0 ? limit : 0;
  // Enriching a session performs history/run/connector projection work.  A
  // bounded list request (sidebar, search, project picker) does not need that
  // work for every archived session: use the durable metadata order to select
  // a small candidate window, then apply the authoritative enriched sort and
  // final limit below. The overlap absorbs minor metadata-vs-history drift.
  const enrichmentCandidates = normalizedLimit > 0
    ? [...filtered]
      .sort(compareSessionListOrder)
      .slice(0, Math.min(filtered.length, Math.max(normalizedLimit * 2, normalizedLimit + 32)))
    : filtered;
  // Session listing is a hot path: tunnel reconnects can overlap with the
  // browser refresh and each enrichment may read history/run/connector state.
  // Keep the I/O and JSON work bounded instead of starting one task per
  // session. Preserve input order before the existing sort so this is only a
  // scheduling change.
  const enrichConcurrency = 8;
  const sessions = new Array(enrichmentCandidates.length);
  let cursor = 0;
  const enrichWorker = async () => {
    while (cursor < enrichmentCandidates.length) {
      const index = cursor;
      cursor += 1;
      sessions[index] = await enrichSessionMetaForClient(enrichmentCandidates[index], {
        includeQueuedMessages,
        hierarchyIndex,
        listSummary,
      });
    }
  };
  await Promise.all(Array.from({
    length: Math.min(enrichConcurrency, enrichmentCandidates.length),
  }, () => enrichWorker()));
  const sorted = sessions.filter(Boolean).sort(compareSessionListOrder);
  return normalizedLimit > 0 ? sorted.slice(0, normalizedLimit) : sorted;
}

export async function getSession(id, options = {}) {
  await ensureProjectsInitialized();
  const metas = await loadSessionsMeta();
  let meta = options?.sessionMeta && typeof options.sessionMeta === 'object'
    ? options.sessionMeta
    : (metas.find((entry) => entry.id === id) || await findSessionMeta(id));
  if (!meta) return null;

  // Historical Agent sessions sometimes stored the Agent id in `tool`. Keep
  // the persisted session boundary canonical so every client and fork sees a
  // real Runtime tool instead of carrying the bad value forward.
  const storedTool = trimString(meta.tool);
  const storedTemplateId = trimString(meta.templateId || meta.agentId);
  if (!storedTool || storedTool.startsWith('app_') || storedTool === storedTemplateId) {
    const repaired = await repairSessionRuntimeTool(id, meta, {
      riskMode: resolveSessionRiskMode(meta),
    });
    if (repaired.session) meta = repaired.session;
  }
  return applyMessageExecutionConfiguration(await enrichSessionMetaForClient(meta, {
    ...options,
    hierarchyIndex: options.hierarchyIndex || buildSessionHierarchyIndex(metas),
  }));
}

// Timeline/event routes only need a cheap existence check and the durable
// latestSeq counter. Calling getSession() there would perform the complete
// history/run/connector enrichment before the route reads the requested page.
// Keep this metadata-only surface separate so detail/sidebar callers retain
// their richer contract without doubling the event request cost.
export async function getSessionMeta(id) {
  await ensureProjectsInitialized();
  return findSessionMeta(id);
}

// A session timeline request usually needs the same three durable facts:
// session metadata (for existence/project context), history metadata (for the
// authoritative sequence boundary), and the active Run (for activity state).
// Keep them in one read snapshot so route handlers can pass the already-read
// values into page/bundle builders instead of making a second round of
// meta.json/session-list reads. The snapshot is intentionally request-scoped;
// callers serving long-poll responses must refresh it after notification.
export async function getSessionReadSnapshot(sessionId, { includeRun = true } = {}) {
  await ensureProjectsInitialized();
  // Resolve session existence before the strict history read. This preserves
  // a clean null/404 for an unknown id while ensuring an existing session
  // cannot silently turn a missing or malformed meta.json into empty history.
  let sessionMeta = await findSessionMeta(sessionId);
  if (!sessionMeta) return null;
  sessionMeta = (await reconcileSessionActiveRuns(sessionMeta)).meta;
  let lastFingerprint = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const historyMeta = await loadMeta(sessionId, { strict: true });
    const activeRunId = typeof sessionMeta.activeRunId === 'string'
      ? sessionMeta.activeRunId.trim()
      : '';
    const run = includeRun && activeRunId
      ? await getRun(activeRunId).catch(() => null)
      : null;
    // A writer commits the event file before advancing meta.json. Read the
    // revision again after the page inputs are assembled; if an append or
    // recovery happened in between, retry instead of returning a mixed
    // metadata/events/run view.
    const verifyHistoryMeta = await loadMeta(sessionId, { strict: true });
    const verifySessionMeta = await findSessionMeta(sessionId);
    const verifyRun = includeRun && activeRunId
      ? await getRun(activeRunId).catch(() => null)
      : null;
    const fingerprint = [
      historyMeta.historyRevision || 0,
      historyMeta.latestSeq || 0,
      verifyHistoryMeta.historyRevision || 0,
      verifyHistoryMeta.latestSeq || 0,
      run?.state || '',
      run?.updatedAt || '',
      run?.lastNormalizedAt || '',
      verifyRun?.state || '',
      verifyRun?.updatedAt || '',
      verifyRun?.lastNormalizedAt || '',
    ].join(':');
    const stable = historyMeta.historyRevision === verifyHistoryMeta.historyRevision
      && historyMeta.latestSeq === verifyHistoryMeta.latestSeq
      && (sessionMeta.updatedAt || '') === (verifySessionMeta?.updatedAt || '')
      && (sessionMeta.activeRunId || '') === (verifySessionMeta?.activeRunId || '')
      && (run?.state || '') === (verifyRun?.state || '')
      && (run?.updatedAt || '') === (verifyRun?.updatedAt || '')
      && (run?.lastNormalizedAt || '') === (verifyRun?.lastNormalizedAt || '');
    if (stable) return { sessionMeta: verifySessionMeta || sessionMeta, historyMeta, activeRunId, run, strict: true };
    sessionMeta = verifySessionMeta || sessionMeta;
    lastFingerprint = fingerprint;
  }
  throw Object.assign(new Error(`Session snapshot changed while loading ${sessionId}`), {
    code: 'SESSION_SNAPSHOT_UNSTABLE',
    stage: 'snapshot',
    retryable: true,
    sessionId,
    fingerprint: lastFingerprint,
  });
}

export async function getSessionEventsAfter(sessionId, afterSeq = 0, options = {}) {
  const includeBodies = options?.includeBodies !== false;
  const priority = options?.priority === 'background' ? 'background' : 'interactive';
  // Delta callers already provide the last sequence they rendered. Reading
  // the complete transcript and filtering afterwards turns a small refresh
  // into an O(history) read, especially damaging for long sessions. Preserve
  // the body-rich compatibility contract while starting at afterSeq.
  const events = await readEventsAfter(sessionId, afterSeq, {
    includeBodies,
    includeMessageBodies: options?.includeMessageBodies === true,
    ...(Number.isInteger(options?.limit) && options.limit > 0 ? { limit: options.limit } : {}),
    priority,
    ...(options?.strict ? { strict: true } : {}),
    ...(options?.historyMeta ? { metaOverride: options.historyMeta } : {}),
  });
  const filtered = (Array.isArray(events) ? events : []).filter((event) => Number.isInteger(event?.seq) && event.seq > afterSeq);
  const enriched = await enrichRunCapabilities(await enrichPlanEventIntents(filtered));
  const projected = projectMessageTimelineIdentities(enriched).map(createApprovedActionClientEventProjection);
  if (options?.includeAttachmentPaths === true) return projected;
  return projected.map((event) => stripEventAttachmentSavedPaths(event));
}

// Event-block expansion is a compatibility/detail path, not a timeline
// bootstrap. Read only the requested raw sequence range and then apply the
// same enrichment/projection used by the full timeline builder.
export async function getSessionEventBlock(sessionId, startSeq, endSeq, options = {}) {
  const rawEvents = await readEventsRange(sessionId, startSeq, endSeq, {
    includeBodies: true,
    priority: 'interactive',
    ...(options?.strict ? { strict: true } : {}),
  });
  const enriched = await enrichRunCapabilities(await enrichPlanEventIntents(rawEvents));
  return buildEventBlockEvents(enriched, startSeq, endSeq);
}

export async function getSessionEventsPage(sessionId, options = {}) {
  const priority = options?.priority === 'background' ? 'background' : 'interactive';
  const page = await readEventsPage(sessionId, {
    includeBodies: options?.includeBodies === true,
    includeMessageBodies: options?.includeMessageBodies === true,
    includeReasoningBodies: options?.includeReasoningBodies === true,
    limit: options?.limit,
    afterSeq: options?.afterSeq,
    beforeSeq: options?.beforeSeq,
    direction: options?.direction,
    maxBodyBytes: options?.maxBodyBytes,
    maxResponseBytes: options?.maxResponseBytes,
    priority,
    ...(options?.historyMeta ? { metaOverride: options.historyMeta } : {}),
    ...(options?.strict ? { strict: true } : {}),
  });
  const enriched = await enrichRunCapabilities(await enrichPlanEventIntents(page.events || []));
  const projected = projectMessageTimelineIdentities(enriched).map(createApprovedActionClientEventProjection);
  const events = options?.includeAttachmentPaths === true
    ? projected
    : projected.map((event) => stripEventAttachmentSavedPaths(event));
  return {
    events,
    pagination: page.pagination,
  };
}

export async function getSessionTimelineEvents(sessionId, options = {}) {
  return buildSessionTimelineEvents(sessionId, options);
}

function getEventStartSeq(event) {
  if (Number.isInteger(event?.startSeq) && event.startSeq > 0) {
    return event.startSeq;
  }
  if (Number.isInteger(event?.blockStartSeq) && event.blockStartSeq > 0) {
    return event.blockStartSeq;
  }
  if (Number.isInteger(event?.mergedStartSeq) && event.mergedStartSeq > 0) {
    return event.mergedStartSeq;
  }
  return Number.isInteger(event?.seq) ? event.seq : 0;
}

function getEventBoundarySeq(event) {
  if (event?.canonicalMessageId && Number.isInteger(event.lastEventSeq) && event.lastEventSeq > 0) return event.lastEventSeq;
  if (Number.isInteger(event?.endSeq) && event.endSeq > 0) {
    return event.endSeq;
  }
  if (Number.isInteger(event?.blockEndSeq) && event.blockEndSeq > 0) {
    return event.blockEndSeq;
  }
  if (Number.isInteger(event?.mergedEndSeq) && event.mergedEndSeq > 0) {
    return event.mergedEndSeq;
  }
  return Number.isInteger(event?.seq) ? event.seq : 0;
}

function rawTimelinePageStartsAtTurnBoundary(events = []) {
  const first = Array.isArray(events) ? events[0] : null;
  if (!first) return true;
  return first.type === 'message' && first.role === 'user';
}

// Bounded visible projection path.  The legacy bundle is intentionally kept
// for full exports and compatibility, but normal session entry/refreshes must
// not materialize an entire 100k-event transcript just to return 50 items.
export async function getSessionTimelinePage(sessionId, options = {}) {
  const priority = options?.priority === 'background' ? 'background' : 'interactive';
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? Math.min(options.limit, 200)
    : 50;
  const requestedDirection = String(options.direction || '').trim().toLowerCase();
  const beforeSeq = Number.isInteger(options.beforeSeq) && options.beforeSeq > 0 ? options.beforeSeq : 0;
  const afterSeq = Number.isInteger(options.afterSeq) && options.afterSeq > 0 ? options.afterSeq : 0;
  const direction = requestedDirection || (beforeSeq > 0 ? 'before' : (afterSeq > 0 ? 'after' : 'latest'));
  // Projection groups can span several raw events. Read a bounded overlap so
  // the page still contains complete turns while retaining O(page-size) cost.
  const rawLimit = Math.min(1000, Math.max(200, limit * 6));
  const maxRawEvents = Math.max(rawLimit, rawLimit * 4);
  const maxRawPages = 8;
  const sessionMeta = options?.sessionMeta || await findSessionMeta(sessionId);
  const activeRunId = typeof sessionMeta?.activeRunId === 'string' ? sessionMeta.activeRunId.trim() : '';
  const run = activeRunId
    ? (options?.run || await getRun(activeRunId).catch(() => null))
    : null;
  const sessionRunning = run?.state === 'running' || hasPendingApprovedActionPause(run);
  let rawEvents = [];
  let rawPage = null;
  let rawBeforeSeq = beforeSeq;
  let rawPagesRead = 0;

  while (rawPagesRead < maxRawPages && rawEvents.length < maxRawEvents) {
    const page = await getSessionEventsPage(sessionId, {
      includeBodies: false,
      includeMessageBodies: true,
      includeReasoningBodies: true,
      limit: rawLimit,
      beforeSeq: rawBeforeSeq,
      afterSeq: rawBeforeSeq > 0 ? 0 : afterSeq,
      direction: rawPagesRead === 0 ? direction : 'before',
      priority,
      ...(options?.historyMeta ? { historyMeta: options.historyMeta } : {}),
      ...(options?.strict ? { strict: true } : {}),
    });
    rawPage = page;
    const pageEvents = Array.isArray(page?.events) ? page.events : [];
    if (pageEvents.length === 0) break;
    rawEvents = [...pageEvents, ...rawEvents];
    rawPagesRead += 1;

    // A latest/before raw page may begin after the user message that gives
    // the display projector its turn context. Continue reading older raw
    // events until the context is complete and there are enough display rows
    // to fill the requested page. The hard caps keep pathological turns from
    // turning a bounded endpoint into a full-history read.
    const partialDisplay = buildSessionDisplayEvents(rawEvents, {
      sessionRunning,
    });
    const partialCandidates = beforeSeq > 0
      ? partialDisplay.filter((event) => getEventStartSeq(event) < beforeSeq)
      : (afterSeq > 0
        ? partialDisplay.filter((event) => getEventBoundarySeq(event) > afterSeq)
        : partialDisplay);
    const isBackwardPage = direction === 'latest' || beforeSeq > 0;
    const enoughDisplayRows = partialCandidates.length >= limit;
    const atTurnBoundary = rawTimelinePageStartsAtTurnBoundary(rawEvents);
    const hasMoreRawBefore = page.pagination?.hasMoreBefore === true;
    if (!isBackwardPage || (enoughDisplayRows && atTurnBoundary) || !hasMoreRawBefore) break;

    const nextRawBefore = Number.isInteger(page.pagination?.nextBeforeSeq)
      ? page.pagination.nextBeforeSeq
      : (Number.isInteger(page.pagination?.oldestSeq) ? page.pagination.oldestSeq : 0);
    if (nextRawBefore < 2 || (rawBeforeSeq > 0 && nextRawBefore >= rawBeforeSeq)) break;
    rawBeforeSeq = nextRawBefore;
  }

  const visibleSources = await hydrateTimelineMessageSnapshots(sessionId, rawEvents,
    options?.historyMeta?.latestSeq || rawPage?.pagination?.totalLatestSeq || Number.MAX_SAFE_INTEGER);
  const displayEvents = buildSessionDisplayEvents(visibleSources, {
    sessionRunning,
    projectRoot: sessionMeta?.folder || '',
    home: process.env.HOME || '',
  });
  let candidates = displayEvents;
  if (beforeSeq > 0) candidates = candidates.filter((event) => getEventStartSeq(event) < beforeSeq);
  if (afterSeq > 0) candidates = candidates.filter((event) => getEventBoundarySeq(event) > afterSeq);
  const events = direction === 'latest' || beforeSeq > 0
    ? candidates.slice(-limit)
    : candidates.slice(0, limit);
  const first = events[0] || null;
  const last = events.at(-1) || null;
  const nextBeforeSeq = first
    ? getEventStartSeq(first)
    : (rawPage?.pagination?.oldestSeq || null);
  return {
    events,
    runActivity: buildRunActivityProjection(displayEvents, {
      sessionRunning,
      run,
      sessionId,
    }),
    latestSeq: rawPage?.pagination?.totalLatestSeq || displayEvents.reduce(
      (latest, event) => Math.max(latest, getEventBoundarySeq(event)),
      0,
    ),
    pagination: {
      limit,
      direction: direction || (beforeSeq > 0 ? 'before' : (afterSeq > 0 ? 'after' : 'forward')),
      beforeSeq: beforeSeq || null,
      afterSeq: afterSeq || null,
      oldestSeq: first ? getEventStartSeq(first) : null,
      latestSeq: last ? getEventBoundarySeq(last) : null,
      hasMoreBefore: Boolean(first && getEventStartSeq(first) > 1),
      nextBeforeSeq: nextBeforeSeq && nextBeforeSeq > 1 ? nextBeforeSeq : null,
      hasMoreAfter: rawPage?.pagination?.hasMoreAfter === true || Boolean(last && getEventBoundarySeq(last) < (rawPage?.pagination?.totalLatestSeq || 0)),
      totalLatestSeq: rawPage?.pagination?.totalLatestSeq || 0,
      bounded: true,
    },
  };
}

export async function getSessionSourceContext(sessionId, options = {}) {
  const session = await getSession(sessionId);
  if (!session) return null;
  const requestedRequestId = typeof options.requestId === 'string' ? options.requestId.trim() : '';
  const event = await findLatestStoredEvent(sessionId, (candidate) => {
    if (candidate?.type !== 'message' || candidate.role !== 'user') return false;
    if (requestedRequestId && (candidate.requestId || '') !== requestedRequestId) return false;
    return Boolean(normalizeSourceContext(candidate.sourceContext));
  });
  let matchedRequestId = requestedRequestId;
  let messageContext = null;
  if (event) {
    messageContext = normalizeSourceContext(event.sourceContext);
    matchedRequestId = event.requestId || matchedRequestId;
  }

  return {
    session: normalizeSourceContext(session.sourceContext),
    message: messageContext,
    requestId: matchedRequestId,
  };
}

async function findReplyPublicationRunByResponseId(sessionId, responseId, history = null) {
  const normalized = trimString(responseId);
  if (!normalized) return null;
  const loadedHistory = Array.isArray(history) ? history : null;
  let matchedUserEvent = loadedHistory
    ? resolveReplyPublicationUserEvent(loadedHistory, normalized)
    : null;
  if (!loadedHistory) {
    // Response publication lookup is frequently called by connector retries.
    // Search only recent event metadata first; the reverse paginated helper
    // preserves latest-match semantics without rebuilding the transcript.
    matchedUserEvent = await findLatestStoredEvent(sessionId, (event) => (
      event?.type === 'message'
      && event.role === 'user'
      && (trimString(event.responseId) === normalized
        || trimString(event.requestId) === normalized
        || sourceContextReferencesRequest(event.sourceContext, normalized, normalized))
    )).catch(() => null);
  }
  if (matchedUserEvent?.runId) {
    const run = await getRun(trimString(matchedUserEvent.runId));
    if (run?.sessionId === sessionId) {
      return { run, history: loadedHistory };
    }
  }

  const indexedRuns = await listRunIndexEntries({ sessionId, reverse: true });
  for (const indexed of indexedRuns) {
    const run = await getRun(indexed.id);
    if (!run || run.sessionId !== sessionId) continue;
    if (!runIncludesResponseId(run, normalized)) continue;
    const rootRunId = trimString(run.replyPublicationRootRunId);
    if (rootRunId && rootRunId !== run.id) {
      const rootRun = await getRun(rootRunId);
      if (rootRun?.sessionId === sessionId) {
        return { run: rootRun, history: loadedHistory };
      }
    }
    return { run, history: loadedHistory };
  }

  return { run: null, history: loadedHistory };
}

async function buildReplyPublicationFromRun(sessionId, rootRun, responseId, history = null) {
  if (!rootRun?.id) return null;
  const rootRunId = trimString(rootRun.replyPublicationRootRunId);
  if (rootRunId && rootRunId !== rootRun.id) {
    const resolvedRootRun = await getRun(rootRunId);
    if (resolvedRootRun?.sessionId === sessionId) {
      rootRun = resolvedRootRun;
    }
  }
  const loadedHistory = Array.isArray(history)
    ? history
    : await loadRunScopedHistory(sessionId, rootRun.id, {
        includeBodies: true,
        responseIds: getRunResponseIds(rootRun),
      });
  const publication = rootRun.replyPublication && typeof rootRun.replyPublication === 'object'
    ? rootRun.replyPublication
    : {
        responseIds: getRunResponseIds(rootRun),
        state: deriveReplyPublicationStateFromRun(rootRun),
        rootRunId: rootRun.id,
        finalRunId: rootRun.id,
        continuationRunIds: [],
      };
  const summary = buildReplyPublicationSummary({
    ...publication,
    id: responseId,
  });

  if (summary.ready) {
    const payloadHistory = collectReplyPublicationHistory(loadedHistory, rootRun);
    summary.payload = buildReplyPublicationPayload(payloadHistory, rootRun);
  }

  return summary;
}

export const MAX_RETAINED_EXPORT_TEXT_BYTES = 25 * 1024 * 1024;

/** Export hydration is separate from the intentionally bounded UI/notification projection. */
async function hydrateRetainedExportMessages(sessionId, events) {
  let remaining = MAX_RETAINED_EXPORT_TEXT_BYTES;
  const result = [];
  for (const event of events) {
    if (event.type !== 'message' || event.role !== 'assistant') {
      result.push(event);
      continue;
    }
    if (Number.isFinite(event.bodyBytes) && event.bodyBytes > remaining) {
      throw Object.assign(new Error('Retained export exceeds the text budget'), {
        code: 'RESULT_EXPORT_TOO_LARGE', statusCode: 413,
      });
    }
    let hydrated = event;
    if (event.bodyLoaded === false && event.bodyAvailable && event.bodyField) {
      const body = remaining > 0
        ? await readEventBody(sessionId, event.seq, { maxBytes: remaining, strict: true }) : null;
      if (!body || typeof body.value !== 'string') {
        throw Object.assign(new Error('Retained export body is unavailable'), {
          code: 'RESULT_EXPORT_INCOMPLETE', statusCode: 409,
        });
      }
      hydrated = { ...event, [body.field]: body.value, bodyLoaded: true, bodyTruncated: body.truncated === true };
    }
    const size = Buffer.byteLength(typeof hydrated.text === 'string' ? hydrated.text : '', 'utf8');
    if (size > remaining) {
      throw Object.assign(new Error('Retained export exceeds the text budget'), {
        code: 'RESULT_EXPORT_TOO_LARGE', statusCode: 413,
      });
    }
    remaining -= size;
    result.push(hydrated);
  }
  return result;
}

/** Exact retained Run publication; never flushes a runner or dispatches work. */
export async function getRetainedRunReplyPublication(run, readOptions = {}) {
  return readRetainedRunPublication(run, false, readOptions);
}

/** Complete export source; callers must authorize the exact Session before reading. */
export async function getRetainedRunExportPublication(run) {
  if (run?.state !== 'completed') {
    throw Object.assign(new Error('Complete retained result is not available'), {
      code: 'RESULT_EXPORT_INCOMPLETE', statusCode: 409,
    });
  }
  const publication = await readRetainedRunPublication(run, true);
  if (!publication?.ready || typeof publication.payload?.text !== 'string' || publication.payload.textIncomplete === true) {
    throw Object.assign(new Error('Complete retained result is not available'), {
      code: 'RESULT_EXPORT_INCOMPLETE', statusCode: 409,
    });
  }
  if (Buffer.byteLength(publication.payload?.text || '', 'utf8') > MAX_RETAINED_EXPORT_TEXT_BYTES) {
    throw Object.assign(new Error('Retained export exceeds the text budget'), {
      code: 'RESULT_EXPORT_TOO_LARGE', statusCode: 413,
    });
  }
  return publication;
}

async function readRetainedRunPublication(run, completeBodies, { readHistory = loadRunScopedHistory, readRun = getRun } = {}) {
  const allowedRuns = new Set([run.id]);
  const childIds = [...new Set([
    ...(Array.isArray(run.replyPublication?.continuationRunIds) ? run.replyPublication.continuationRunIds : []),
    run.replyPublication?.finalRunId,
  ].filter(id => typeof id === 'string' && id && id !== run.id))];
  if ((run.replyPublicationRootRunId && run.replyPublicationRootRunId !== run.id) || childIds.length > 128) {
    return { ready: false, state: 'checking', rootRunId: run.id, payload: null };
  }
  for (const id of childIds) {
    const child = await readRun(id);
    if (child?.sessionId === run.sessionId && child?.replyPublicationRootRunId === run.id) allowedRuns.add(id);
  }
  const history = await readHistory(run.sessionId, run.id, {
    includeBodies: !completeBodies, responseIds: getRunResponseIds(run),
    allowedRunIds: [...allowedRuns], requestId: run.requestId,
  });
  // A reused response ID is not enough to include another Run's reply.
  let exactHistory = history.filter(event => {
    const eventRun = trimString(event.runId || event.resultRunId);
    return eventRun ? allowedRuns.has(eventRun) : trimString(event.requestId) === run.requestId;
  });
  if (completeBodies) exactHistory = await hydrateRetainedExportMessages(run.sessionId, exactHistory);
  const publication = await buildReplyPublicationFromRun(run.sessionId, run, trimString(run.responseId || run.requestId), exactHistory);
  if (publication?.ready && publication.finalRunId && publication.finalRunId !== run.id) {
    const finalRun = await readRun(publication.finalRunId);
    if (finalRun?.sessionId !== run.sessionId || finalRun?.replyPublicationRootRunId !== run.id || finalRun?.state !== 'completed') {
      return { ...publication, ready: false, state: 'checking', payload: null };
    }
  }
  if (publication?.payload) {
    // The common reader deliberately bounds event/body hydration. A preview
    // must never qualify as a complete PROCESS_TEXT replacement.
    publication.payload.textIncomplete = history.length >= MAX_SCOPED_HISTORY_EVENTS || exactHistory.some(event =>
      event.type === 'message' && event.role === 'assistant' &&
        (event.bodyTruncated === true || (event.bodyAvailable && event.bodyLoaded === false))) ||
      history.some(event => event.type === 'message' && event.role === 'assistant' && !event.runId && !event.resultRunId && !event.requestId);
  }
  return publication;
}

export async function getSessionReplyPublication(sessionId, responseId) {
  const normalized = trimString(responseId);
  if (!normalized) return null;

  const sessionMeta = await findSessionMeta(sessionId);
  if (!sessionMeta) return null;

  const pendingEntry = findPendingDispatchByResponse(sessionMeta, normalized);
  const queuedEntry = findQueuedFollowUpByResponse(sessionMeta, normalized);
  const resolved = await findReplyPublicationRunByResponseId(sessionId, normalized);
  const rootRun = resolved?.run || null;
  if (!rootRun) {
    if (pendingEntry) {
      return buildReplyPublicationSummary({
        id: normalized,
        responseIds: [normalized],
        state: 'checking',
      });
    }
    if (queuedEntry) {
      return buildReplyPublicationSummary({
        id: normalized,
        responseIds: [normalized],
        state: 'queued',
      });
    }
    return null;
  }

  return buildReplyPublicationFromRun(sessionId, rootRun, normalized, resolved?.history || null);
}

export async function getRunState(runId) {
  const run = await getRun(runId);
  if (!run) return null;
  const effectiveRun = await flushDetachedRunIfNeeded(run.sessionId, runId) || await getRun(runId);
  if (!effectiveRun) return null;
  const session = await findSessionMeta(effectiveRun.sessionId);
  const connectors = await buildRunConnectorSurface(session, effectiveRun);
  const primaryResponseId = trimString(effectiveRun.responseId || getRunResponseIds(effectiveRun)[0]);
  const publication = primaryResponseId
    ? (trimString(effectiveRun.replyPublicationRootRunId)
      ? await getSessionReplyPublication(effectiveRun.sessionId, primaryResponseId)
      : await buildReplyPublicationFromRun(effectiveRun.sessionId, effectiveRun, primaryResponseId, null))
    : null;
  return {
    ...effectiveRun,
    ...(publication ? { replyPublication: publication } : {}),
    ...(connectors ? { connectors } : {}),
  };
}

function hasRequestedProjectAssociation(extra = {}) {
  return Object.prototype.hasOwnProperty.call(extra, 'projectId');
}

function shouldAssociateProjectWithSession(extra = {}, requestedVisitorId = '') {
  if (extra.createdByPrincipalKind === 'temporary_device') return false;
  if (trimString(extra.internalRole)) return false;
  if (trimString(extra.compactsSessionId)) return false;
  if (trimString(requestedVisitorId)) return false;
  return true;
}

async function resolveSessionProjectAssociation(folder, extra, requestedVisitorId) {
  if (!shouldAssociateProjectWithSession(extra, requestedVisitorId)) {
    return { folder, projectId: '' };
  }
  const hasProjectId = hasRequestedProjectAssociation(extra);
  const requestedProjectId = hasProjectId ? normalizeProjectId(extra.projectId) : '';
  if (hasProjectId && !requestedProjectId) {
    throw new Error('projectId is invalid');
  }
  if (requestedProjectId) {
    const project = await getProject(requestedProjectId);
    if (!project) throw new Error('Project not found');
    return {
      folder: project.rootPath,
      projectId: project.id,
    };
  }
  const project = await ensureProjectForSessionFolder(folder, { migratedFromFolder: false });
  return {
    folder: project.rootPath,
    projectId: project.id,
  };
}

export async function createSession(folder, tool, name, extra = {}) {
  return (await createSessionWithOutcome(folder, tool, name, extra)).session;
}

export async function createSessionWithOutcome(folder, tool, name, extra = {}, { authorizeCommit } = {}) {
  if (WORKBENCH_EXECUTION_POLICY) {
    tool = tool || 'codex';
    assertWorkbenchExecution({ agentType: tool, model: extra.model || WORKBENCH_EXECUTION_POLICY.model,
      ...(extra.providerProfile ? { providerProfileId: extra.providerProfile } : {}) });
    extra = { ...extra, model: extra.model || WORKBENCH_EXECUTION_POLICY.model, riskMode: 'safe',
      privilegedMode: false, permissionMode: 'untrusted-read-only' };
  }
  if (authorizeCommit !== undefined && typeof authorizeCommit !== 'function') throw new TypeError('Invalid creation authorization callback');
  if (authorizeCommit && (!extra.creationRequest || extra.externalTriggerId
    || extra.organizationProvisioningKey || extra.organizationReplacementKey)) {
    throw new TypeError('Authorized creation requires exclusive keyed Session identity');
  }
  const hasRequestedInteractionMode = Object.prototype.hasOwnProperty.call(extra, 'interactionMode');
  const requestedInteractionMode = hasRequestedInteractionMode && typeof extra.interactionMode === 'string'
    ? extra.interactionMode.trim().toLowerCase()
    : '';
  if (hasRequestedInteractionMode && requestedInteractionMode && !['agent', 'plan'].includes(requestedInteractionMode)) {
    throw new Error('interactionMode must be "agent" or "plan"');
  }
  const hasRequestedRiskMode = Object.prototype.hasOwnProperty.call(extra, 'riskMode');
  const requestedRiskMode = hasRequestedRiskMode && typeof extra.riskMode === 'string'
    ? extra.riskMode.trim().toLowerCase()
    : '';
  if (hasRequestedRiskMode && requestedRiskMode && !RISK_MODES.includes(requestedRiskMode)) {
    throw new Error('riskMode must be "safe", "recommended" or "full-auto"');
  }
  const requestedSessionPlane = normalizeSessionPlane(extra.sessionPlane);
  const sessionContract = normalizeSessionContractForCreate(extra, requestedSessionPlane);
  if (ORG_SESSION_ADDRESSABILITY_ENABLED
      && requestedSessionPlane === 'organization'
      && !sessionContract.hasClass) {
    const error = new Error('Managed sessions require an explicit sessionClass');
    error.code = 'SESSION_CLASS_INVALID';
    error.statusCode = 400;
    throw error;
  }
  if (isManagedSessionClass(sessionContract.sessionClass)) {
    assertManagedSessionLineage({
      ...extra,
      sessionPlane: requestedSessionPlane,
      sessionClass: sessionContract.sessionClass,
    });
  }
  const requestedOrganizationRootSessionId = typeof extra.organizationRootSessionId === 'string'
    ? extra.organizationRootSessionId.trim()
    : '';
  const requestedOrganizationId = typeof extra.organizationId === 'string'
    ? extra.organizationId.trim()
    : '';
  const requestedOrganizationNodeId = typeof (extra.organizationNodeId || extra.nodeId) === 'string'
    ? (extra.organizationNodeId || extra.nodeId).trim()
    : '';
  const requestedOrganizationProvisioningKey = requestedSessionPlane === 'organization'
    && typeof extra.idempotencyKey === 'string'
    ? extra.idempotencyKey.trim()
    : '';
  const requestedOrganizationReplacementKey = requestedSessionPlane === 'organization'
    && typeof extra.replacementKey === 'string'
    ? extra.replacementKey.trim()
    : '';
  // If no explicit interactionMode requested, try to inherit from fork/delegate source session
  let inheritedInteractionMode = '';
  if (!hasRequestedInteractionMode && (extra.forkedFromSessionId || extra.delegatedFromSessionId)) {
    try {
      const sourceId = extra.forkedFromSessionId || extra.delegatedFromSessionId;
      const source = await getSession(sourceId);
      if (source && typeof source.interactionMode === 'string' && ['agent', 'plan'].includes(source.interactionMode)) {
        inheritedInteractionMode = source.interactionMode;
      }
    } catch (e) {
      // ignore errors and fall back to default
    }
  }
  const externalTriggerId = typeof extra.externalTriggerId === 'string' ? extra.externalTriggerId.trim() : '';
  const { createdByPrincipalId: requestedCreatedByPrincipalId, visitorId: requestedVisitorId } = resolveRequestedSessionPrincipalFields(extra);
  const requestedCreatedByPrincipalKind = typeof extra.createdByPrincipalKind === 'string'
    ? extra.createdByPrincipalKind.trim()
    : '';
  const requestedTemplateId = normalizeAppId(extra.templateId || extra.agentId);
  const requestedTemplateName = normalizeSessionTemplateName(extra.templateName);
  const requestedSourceId = resolveRequestedSessionSourceId(extra);
  const requestedSourceName = resolveRequestedSessionSourceName(extra, requestedSourceId);
  const hasRequestedSourceHint = hasRequestedSessionSourceHint(extra);
  const requestedVisitorName = normalizeSessionVisitorName(extra.visitorName);
  const requestedUserId = typeof extra.userId === 'string' ? extra.userId.trim() : '';
  const requestedUserName = normalizeSessionUserName(extra.userName);
  const requestedGroup = normalizeSessionGroup(extra.group || '');
  const requestedDescription = normalizeSessionDescription(extra.description || '');
  const requestedStarterPreset = normalizeSessionStarterPreset(extra.starterPreset);
  const projectAssociation = await resolveSessionProjectAssociation(
    folder,
    extra,
    requestedVisitorId,
  );
  const sessionFolder = projectAssociation.folder || folder;
  const requestedProjectId = projectAssociation.projectId || '';
  const hasRequestedSystemPrompt = Object.prototype.hasOwnProperty.call(extra, 'systemPrompt');
  const requestedSystemPrompt = typeof extra.systemPrompt === 'string' ? extra.systemPrompt : '';
  const requestedProviderProfile = typeof extra.providerProfile === 'string' ? extra.providerProfile.trim() : '';
  const initialProviderProfile = requestedProviderProfile;
  const hasRequestedModel = Object.prototype.hasOwnProperty.call(extra, 'model');
  const requestedModel = typeof extra.model === 'string' ? extra.model.trim() : '';
  const hasRequestedEffort = Object.prototype.hasOwnProperty.call(extra, 'effort');
  const requestedEffort = typeof extra.effort === 'string' ? extra.effort.trim() : '';
  const hasRequestedServiceTier = Object.prototype.hasOwnProperty.call(extra, 'serviceTier');
  const requestedServiceTier = hasRequestedServiceTier
    ? normalizeCodexServiceTier(extra.serviceTier)
    : '';
  const hasRequestedThinking = Object.prototype.hasOwnProperty.call(extra, 'thinking');
  const requestedThinking = extra.thinking === true;
  const requestedCodexThreadId = typeof extra.codexThreadId === 'string' ? extra.codexThreadId.trim() : '';
  const hasRequestedSourceContext = Object.prototype.hasOwnProperty.call(extra, 'sourceContext');
  const requestedSourceContext = normalizeSourceContext(extra.sourceContext);
  const hasRequestedActiveAgreements = Object.prototype.hasOwnProperty.call(extra, 'activeAgreements');
  const requestedActiveAgreements = hasRequestedActiveAgreements
    ? normalizeSessionAgreements(extra.activeAgreements || [])
    : [];
  const requestedInitialNaming = resolveInitialSessionName(name, {
    group: requestedGroup,
    sourceId: hasRequestedSourceHint ? requestedSourceId : '',
    sourceName: hasRequestedSourceHint ? requestedSourceName : '',
    externalTriggerId,
  });
  const created = await withSessionsMetaMutation(async (metas, saveSessionsMeta) => {
    const replay = findSessionCreationReplay(metas, extra.creationRequest);
    if (replay) {
      await authorizeCommit?.({ session: structuredClone(replay), duplicate: true, sessions: metas });
      // A prior file write may have failed after updating the cache. A replay
      // is acknowledged only after its identity is definitely durable.
      await saveSessionsMeta(metas, { immediate: true });
      return { session: replay, created: false, changed: false, replayed: true };
    }
    if (requestedSessionPlane === 'organization'
        && (requestedOrganizationProvisioningKey || requestedOrganizationReplacementKey)) {
      const existingIndex = metas.findIndex((meta) => meta.sessionPlane === 'organization'
        && ((requestedOrganizationProvisioningKey
          && meta.organizationProvisioningKey === requestedOrganizationProvisioningKey)
          || (requestedOrganizationReplacementKey
            && meta.organizationReplacementKey === requestedOrganizationReplacementKey)));
      if (existingIndex !== -1) {
        const existing = metas[existingIndex];
        const identityPairs = [
          [requestedOrganizationId, existing.organizationId],
          [requestedOrganizationNodeId, existing.organizationNodeId],
          [requestedOrganizationRootSessionId, existing.organizationRootSessionId],
          [sessionContract.sessionClass, existing.sessionClass],
        ];
        const rawRequestedRevision = extra.organizationRevision ?? extra.revision;
        const requestedRevision = typeof rawRequestedRevision === 'string' && rawRequestedRevision.trim()
          ? Number(rawRequestedRevision)
          : rawRequestedRevision;
        if (Number.isInteger(requestedRevision)
            && Number.isInteger(existing.organizationRevision)
            && requestedRevision !== existing.organizationRevision) {
          throw Object.assign(new Error('organization session idempotency key conflicts with another revision'), {
            code: 'SESSION_IDEMPOTENCY_CONFLICT',
            statusCode: 409,
          });
        }
        if (identityPairs.some(([requested, actual]) => requested && actual && requested !== actual)) {
          throw Object.assign(new Error('organization session idempotency key conflicts with another session'), {
            code: 'SESSION_IDEMPOTENCY_CONFLICT',
            statusCode: 409,
          });
        }
        return { session: existing, created: false, changed: false, replayed: true };
      }
    }
    if (externalTriggerId) {
      const existingIndex = metas.findIndex((meta) => meta.externalTriggerId === externalTriggerId);
      if (existingIndex !== -1) {
        const existing = metas[existingIndex];
        const updated = { ...existing };
        let changed = false;

        if (requestedGroup && updated.group !== requestedGroup) {
          updated.group = requestedGroup;
          changed = true;
        }

        if (requestedDescription && updated.description !== requestedDescription) {
          updated.description = requestedDescription;
          changed = true;
        }

        const refreshedInitialNaming = resolveInitialSessionName(name, {
          group: requestedGroup || updated.group || '',
          sourceId: hasRequestedSourceHint
            ? requestedSourceId
            : ((updated.sourceId || '') === DEFAULT_APP_ID ? '' : (updated.sourceId || '')),
          sourceName: hasRequestedSourceHint
            ? requestedSourceName
            : ((updated.sourceId || '') === DEFAULT_APP_ID ? '' : (updated.sourceName || '')),
          externalTriggerId: externalTriggerId || updated.externalTriggerId || '',
        });
        if (isSessionAutoRenamePending(updated) && !refreshedInitialNaming.autoRenamePending) {
          if (updated.name !== refreshedInitialNaming.name || updated.autoRenamePending !== false) {
            updated.name = refreshedInitialNaming.name;
            updated.autoRenamePending = false;
            updated.titleSource = 'connector';
            updated.titleUpdatedAt = nowIso();
            delete updated.titleAnchorRunId;
            changed = true;
          }
        }

        const workflowState = normalizeSessionWorkflowState(extra.workflowState || '');
        if (workflowState && updated.workflowState !== workflowState) {
          updated.workflowState = workflowState;
          changed = true;
        }

        const workflowPriority = normalizeSessionWorkflowPriority(extra.workflowPriority || '');
        if (workflowPriority && updated.workflowPriority !== workflowPriority) {
          updated.workflowPriority = workflowPriority;
          changed = true;
        }

        if (hasRequestedSourceHint && updated.sourceId !== requestedSourceId) {
          updated.sourceId = requestedSourceId;
          changed = true;
        }

        if (hasRequestedSourceHint && updated.sourceName !== requestedSourceName) {
          updated.sourceName = requestedSourceName;
          changed = true;
        }

        if (requestedTemplateId && updated.templateId !== requestedTemplateId) {
          updated.templateId = requestedTemplateId;
          changed = true;
        }

        if (requestedTemplateName && updated.templateName !== requestedTemplateName) {
          updated.templateName = requestedTemplateName;
          changed = true;
        }

        if (requestedCreatedByPrincipalId && updated.createdByPrincipalId !== requestedCreatedByPrincipalId) {
          updated.createdByPrincipalId = requestedCreatedByPrincipalId;
          changed = true;
        }

        if (requestedCreatedByPrincipalKind && updated.createdByPrincipalKind !== requestedCreatedByPrincipalKind) {
          updated.createdByPrincipalKind = requestedCreatedByPrincipalKind;
          changed = true;
        }

        if (requestedVisitorId && updated.visitorId !== requestedVisitorId) {
          updated.visitorId = requestedVisitorId;
          changed = true;
        }

        if (requestedVisitorName && updated.visitorName !== requestedVisitorName) {
          updated.visitorName = requestedVisitorName;
          changed = true;
        }

        if (requestedUserId && updated.userId !== requestedUserId) {
          updated.userId = requestedUserId;
          changed = true;
        }

        if (requestedUserName && updated.userName !== requestedUserName) {
          updated.userName = requestedUserName;
          changed = true;
        }

        if (requestedProjectId && updated.projectId !== requestedProjectId) {
          updated.projectId = requestedProjectId;
          changed = true;
        }

        if (requestedProjectId && updated.folder !== sessionFolder) {
          updated.folder = sessionFolder;
          changed = true;
        }

        if (requestedStarterPreset && updated.starterPreset !== requestedStarterPreset) {
          updated.starterPreset = requestedStarterPreset;
          changed = true;
        }

        if (hasRequestedSystemPrompt && (updated.systemPrompt || '') !== requestedSystemPrompt) {
          if (requestedSystemPrompt) updated.systemPrompt = requestedSystemPrompt;
          else delete updated.systemPrompt;
          changed = true;
        }

        if (hasRequestedModel && (updated.model || '') !== requestedModel) {
          if (requestedModel) updated.model = requestedModel;
          else delete updated.model;
          changed = true;
        }

        if (hasRequestedEffort && (updated.effort || '') !== requestedEffort) {
          if (requestedEffort) updated.effort = requestedEffort;
          else delete updated.effort;
          changed = true;
        }

        if (hasRequestedServiceTier && (updated.serviceTier || '') !== requestedServiceTier) {
          if (requestedServiceTier === 'fast') updated.serviceTier = requestedServiceTier;
          else delete updated.serviceTier;
          changed = true;
        }

        if (hasRequestedThinking && updated.thinking !== requestedThinking) {
          if (requestedThinking) updated.thinking = true;
          else delete updated.thinking;
          changed = true;
        }

        if (hasRequestedInteractionMode) {
          if (requestedInteractionMode) updated.interactionMode = requestedInteractionMode;
          else delete updated.interactionMode;
          changed = true;
        }

        const completionTargets = sanitizeAllCompletionTargets(extra.completionTargets || []);
        if (completionTargets.length > 0 && JSON.stringify(updated.completionTargets || []) !== JSON.stringify(completionTargets)) {
          updated.completionTargets = completionTargets;
          changed = true;
        }

        if (hasRequestedActiveAgreements) {
          if (JSON.stringify(normalizeSessionAgreements(updated.activeAgreements || [])) !== JSON.stringify(requestedActiveAgreements)) {
            if (requestedActiveAgreements.length > 0) updated.activeAgreements = requestedActiveAgreements;
            else delete updated.activeAgreements;
            changed = true;
          }
        }

        if (hasRequestedSourceContext) {
          const currentSourceContext = normalizeSourceContext(updated.sourceContext);
          if (JSON.stringify(currentSourceContext) !== JSON.stringify(requestedSourceContext)) {
            if (requestedSourceContext) updated.sourceContext = requestedSourceContext;
            else delete updated.sourceContext;
            changed = true;
          }
        }

        if (sessionContract.hasClass && updated.sessionClass !== sessionContract.sessionClass) {
          updated.sessionClass = sessionContract.sessionClass;
          updated.userAddressable = sessionContract.userAddressable;
          changed = true;
        }
        if (sessionContract.hasClass) {
          const beforeContract = JSON.stringify({
            root: updated.organizationRootSessionId,
            node: updated.organizationNodeId,
            role: updated.roleInstanceId,
            revision: updated.organizationRevision,
            controller: updated.controllerSessionId,
            parent: updated.parentSessionId,
          });
          applySessionContractFields(updated, {
            ...extra,
            organizationRootSessionId: requestedOrganizationRootSessionId,
          }, sessionContract);
          const afterContract = JSON.stringify({
            root: updated.organizationRootSessionId,
            node: updated.organizationNodeId,
            role: updated.roleInstanceId,
            revision: updated.organizationRevision,
            controller: updated.controllerSessionId,
            parent: updated.parentSessionId,
          });
          if (beforeContract !== afterContract) changed = true;
        }

        if (changed) {
          updated.updatedAt = nowIso();
          metas[existingIndex] = updated;
          // External-trigger reuse refreshes the canonical source identity;
          // preserve the existing durable refresh contract for callers that
          // read chat-sessions.json immediately after this operation.
          await saveSessionsMeta(metas, { immediate: true });
          return { session: updated, created: false, changed: true };
        }

        return { session: existing, created: false, changed: false };
      }
    }

    const id = generateId();
    const initialNaming = requestedInitialNaming;
    const now = nowIso();
    const workflowState = normalizeSessionWorkflowState(extra.workflowState || '');
    const workflowPriority = normalizeSessionWorkflowPriority(extra.workflowPriority || '');
    const completionTargets = sanitizeAllCompletionTargets(extra.completionTargets || []);

    const session = {
      id,
      folder: sessionFolder,
      tool,
      sourceId: requestedSourceId,
      name: initialNaming.name,
      autoRenamePending: initialNaming.autoRenamePending,
      titleSource: initialNaming.autoRenamePending ? 'placeholder' : 'explicit',
      titleUpdatedAt: now,
      created: now,
      updatedAt: now,
    };

    if (extra.creationRequest) {
      session.creationRequest = {
        ...extra.creationRequest,
        initialization: extra.creationInitialization || { events: [] },
        state: 'initializing',
      };
    }

    if (requestedProjectId) session.projectId = requestedProjectId;
    if (requestedGroup) session.group = requestedGroup;
    if (requestedDescription) session.description = requestedDescription;
    if (workflowState) session.workflowState = workflowState;
    if (workflowPriority) session.workflowPriority = workflowPriority;
    if (requestedSourceName) session.sourceName = requestedSourceName;
    if (requestedTemplateId) session.templateId = requestedTemplateId;
    if (requestedTemplateName) session.templateName = requestedTemplateName;
    if (typeof extra.uiLanguage === 'string' && extra.uiLanguage.trim()) {
      const normalizedUiLanguage = normalizeUiLanguagePreference(extra.uiLanguage);
      if (normalizedUiLanguage && normalizedUiLanguage !== 'auto') {
        session.uiLanguage = normalizedUiLanguage;
      }
    }
    if (requestedCreatedByPrincipalId) session.createdByPrincipalId = requestedCreatedByPrincipalId;
    if (requestedCreatedByPrincipalKind) session.createdByPrincipalKind = requestedCreatedByPrincipalKind;
    if (requestedVisitorId) session.visitorId = requestedVisitorId;
    if (requestedVisitorName) session.visitorName = requestedVisitorName;
    if (requestedUserId) session.userId = requestedUserId;
    if (requestedUserName) session.userName = requestedUserName;
    if (requestedStarterPreset) session.starterPreset = requestedStarterPreset;
    if (requestedSystemPrompt) session.systemPrompt = requestedSystemPrompt;
    if (initialProviderProfile) session.providerProfile = initialProviderProfile;
    if (requestedModel) session.model = requestedModel;
    if (requestedEffort) session.effort = requestedEffort;
    if (requestedServiceTier === 'fast') session.serviceTier = requestedServiceTier;
    if (requestedThinking) session.thinking = true;
    if (requestedCodexThreadId) session.codexThreadId = requestedCodexThreadId;
    if (extra.internalRole) session.internalRole = extra.internalRole;
    // Set interactionMode: explicit request -> use it; inherit from source -> use it; otherwise default to 'agent'
    if (requestedInteractionMode) {
      session.interactionMode = requestedInteractionMode;
    } else if (inheritedInteractionMode) {
      session.interactionMode = inheritedInteractionMode;
    } else {
      session.interactionMode = 'agent';
    }
    // Keep the semantic privileged channel available for supported Sessions.
    // The account policy below determines whether the Harness uses a gated,
    // bypass, or conservative permission profile for ordinary execution.
    session.privilegedMode = true;
    // Risk mode (统一风险门控计划 phase 3): explicit request wins. Sessions
    // created without one fall back to the account-level permission policy
    // (账号级权限模式) and then to the built-in 'full-auto' default. A
    // 'full-auto' value coming from the account policy is the owner's
    // standing opt-in, so it carries the explicit marker; an explicit
    // per-session riskMode is never overridden by the account policy.
    if (requestedRiskMode) {
      session.riskMode = requestedRiskMode;
      if (requestedRiskMode === 'full-auto') session.riskModeExplicit = true;
    } else {
      const accountRiskMode = accountPolicyToSessionRiskMode(await loadAccountPermissionPolicy());
      session.riskMode = accountRiskMode;
      if (session.riskMode === 'full-auto') session.riskModeExplicit = true;
    }
    if (extra.compactsSessionId) session.compactsSessionId = extra.compactsSessionId;
    if (externalTriggerId) session.externalTriggerId = externalTriggerId;
    if (requestedSourceContext) session.sourceContext = requestedSourceContext;
    if (extra.forkedFromSessionId) session.forkedFromSessionId = extra.forkedFromSessionId;
    if (Number.isInteger(extra.forkedFromSeq)) session.forkedFromSeq = extra.forkedFromSeq;
    if (Number.isInteger(extra.forkedAnchorSeq) && extra.forkedAnchorSeq > 0) session.forkedAnchorSeq = extra.forkedAnchorSeq;
    if (typeof extra.forkMode === 'string' && extra.forkMode.trim()) session.forkMode = extra.forkMode.trim();
    if (typeof extra.forkIdempotencyKey === 'string' && extra.forkIdempotencyKey.trim()) {
      session.forkIdempotencyKey = extra.forkIdempotencyKey.trim();
    }
    if (extra.historyStorage === 'shared-prefix-v1') session.historyStorage = extra.historyStorage;
    if (extra.rootSessionId) session.rootSessionId = extra.rootSessionId;
    if (extra.forkedAt) session.forkedAt = extra.forkedAt;
    if (extra.delegatedFromSessionId) session.delegatedFromSessionId = extra.delegatedFromSessionId;
    if (Number.isInteger(extra.delegationDepth) && extra.delegationDepth > 0) session.delegationDepth = extra.delegationDepth;
    if (completionTargets.length > 0) session.completionTargets = completionTargets;
    if (hasRequestedActiveAgreements && requestedActiveAgreements.length > 0) {
      session.activeAgreements = requestedActiveAgreements;
    }
    // Organization constitution §3.2/§3.3: sessionPlane is always persisted
    // (default 'user'), and organizationRootSessionId is the migration-time
    // root binding distinct from the legacy workstream rootSessionId.
    session.sessionPlane = requestedSessionPlane;
    if (requestedOrganizationRootSessionId) session.organizationRootSessionId = requestedOrganizationRootSessionId;
    if (requestedOrganizationProvisioningKey) {
      session.organizationProvisioningKey = requestedOrganizationProvisioningKey;
    }
    if (requestedOrganizationReplacementKey) {
      session.organizationReplacementKey = requestedOrganizationReplacementKey;
    }
    applySessionContractFields(session, {
      ...extra,
      organizationRootSessionId: requestedOrganizationRootSessionId,
    }, sessionContract);
    if (!sessionContract.hasClass
        && requestedSessionPlane === 'user'
        && !(typeof extra.delegatedFromSessionId === 'string' && extra.delegatedFromSessionId.trim())) {
      session.sessionClass = 'ROOT_LEADERSHIP';
      session.userAddressable = true;
    }

    if (typeof extra.delegatedFromSessionId === 'string' && extra.delegatedFromSessionId.trim()) {
      const parentIndex = metas.findIndex((meta) => meta.id === extra.delegatedFromSessionId.trim());
      if (parentIndex !== -1) {
        const parent = metas[parentIndex];
        parent.delegatedChildCount = (Number(parent.delegatedChildCount) || 0) + 1;
        parent.updatedAt = nowIso();
      }
    }

    // Internal adapters recheck current authority while the metadata actor still owns this write.
    // Once this callback accepts, persistence may finish even if authority is later revoked.
    await authorizeCommit?.({ session: structuredClone(session), duplicate: false, sessions: metas });
    metas.push(session);
    // Session creation must survive a crash (immediate, not debounced).
    await saveSessionsMeta(metas, { immediate: true });
    return { session, created: true, changed: true };
  });

  if (created.created && extra.historyStorage === 'shared-prefix-v1') {
    await markSharedForkHistoryPending(created.session.id);
  }

  if ((created.created || created.changed)
      && extra.suppressBroadcast !== true
      && !extra.creationRequest
      && shouldExposeSession(created.session)) {
    broadcastScopedSessionsInvalidation(created.session);
  }

  return { ...created, session: await enrichSessionMeta(created.session) };
}

export async function findCreatedSession(request) {
  return withSessionsMetaMutation(async (metas, saveSessionsMeta) => {
    const existing = findSessionCreationReplay(metas, request);
    if (existing) await saveSessionsMeta(metas, { immediate: true });
    return existing;
  });
}

// Freeze Agent initialization before persisting a keyed Session. A retry must
// finish this exact snapshot even if the Agent has since changed or vanished.
export async function prepareSessionCreationInitialization(templateId, welcomeMessage = '') {
  const timestamp = Date.now();
  const events = [];
  let template = null;
  if (templateId) {
    const app = await getApp(templateId);
    if (!app) throw sessionCreationError('RESOURCE_NOT_FOUND', 'Agent not found', 404);
    template = { id: app.id, name: app.name || '', tool: app.tool || '', systemPrompt: app.systemPrompt || '' };
    if (app.templateContext?.content) {
      events.push({ type: 'template_context', templateId: app.id, templateName: app.name || 'Template',
        content: app.templateContext.content, ...await resolveAppTemplateFreshness(app), timestamp });
    }
    welcomeMessage = typeof app.welcomeMessage === 'string' ? app.welcomeMessage.trim() : '';
  }
  if (welcomeMessage) events.push(messageEvent('assistant', welcomeMessage));
  return { template, events, appliedAt: new Date(timestamp).toISOString() };
}

export async function initializeCreatedSession(sessionId) {
  const snapshot = await withSessionsMetaMutation(async (metas, saveSessionsMeta) => {
    const session = metas.find((meta) => meta.id === sessionId);
    if (!session?.creationRequest || session.creationRequest.state === 'complete') return null;
    const initialization = session.creationRequest.initialization;
    if (initialization.template) {
      const template = initialization.template;
      session.templateId = template.id;
      session.templateName = template.name;
      session.systemPrompt = template.systemPrompt;
      if (template.tool) session.tool = template.tool;
      session.templateAppliedAt = initialization.appliedAt;
      await saveSessionsMeta(metas, { immediate: true });
    }
    return initialization;
  });
  if (snapshot) {
    await appendInitializationEvents(sessionId, snapshot.events);
    await withSessionsMetaMutation(async (metas, saveSessionsMeta) => {
      const session = metas.find((meta) => meta.id === sessionId);
      if (!session) throw sessionCreationError('RESOURCE_NOT_FOUND', 'Session was deleted during initialization', 404);
      session.creationRequest.state = 'complete';
      // Keep key and fingerprint with the Session; discard bulky initialization
      // content only after all deterministic history events are durable.
      delete session.creationRequest.initialization;
      await saveSessionsMeta(metas, { immediate: true });
    });
    broadcastSessionInvalidation(sessionId);
  }
  return getSession(sessionId);
}

function createSessionDeleteError(message, code = 'SESSION_DELETE_BLOCKED') {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}

const deletingSessionIds = new Set();

export async function deleteSession(id) {
  const sessionId = trimString(id);
  if (!sessionId) return null;
  if (deletingSessionIds.has(sessionId)) {
    throw createSessionDeleteError('Session deletion is already in progress', 'SESSION_DELETE_IN_PROGRESS');
  }

  deletingSessionIds.add(sessionId);
  try {
    const current = await findSessionMeta(sessionId);
    if (!current) return null;
    const activeRunId = trimString(current.activeRunId);
    if (activeRunId) {
      const activeRun = await flushDetachedRunIfNeeded(sessionId, activeRunId) || await getRun(activeRunId);
      if (activeRun && !isTerminalRunState(activeRun.state)) {
        throw createSessionDeleteError('Stop the active run before deleting this session', 'SESSION_DELETE_ACTIVE');
      }
    }

    const removed = await withSessionsMetaMutation(async (metas, saveSessionsMeta) => {
      const index = metas.findIndex((meta) => meta?.id === sessionId);
      if (index < 0) return false;
      const latestRunId = trimString(metas[index].activeRunId);
      if (latestRunId) {
        const latestRun = await getRun(latestRunId);
        if (latestRun && !isTerminalRunState(latestRun.state)) {
          throw createSessionDeleteError('Stop the active run before deleting this session', 'SESSION_DELETE_ACTIVE');
        }
      }
      const dependents = [];
      for (const meta of metas) {
        if (meta?.id === sessionId) continue;
        const base = await getHistoryBase(meta?.id);
        if (base?.sourceSessionId === sessionId) dependents.push(meta);
      }
      const materialized = [];
      if (dependents.length > 0) {
        // Shared-prefix forks are optimized for reads, but deleting their
        // source must not make the child unreadable. Materialize each live
        // child before removing the source; the child's local tail remains
        // untouched and lineage metadata is retained for display.
        try {
          for (const dependent of dependents) {
            const result = await materializeSharedHistory(dependent.id);
            if (result?.materialized) {
              delete dependent.historyStorage;
              delete dependent.historyRepairState;
              delete dependent.historyRepairMessage;
              materialized.push(dependent.id);
            }
          }
        } catch (error) {
          // A preceding child may already have been materialized before a
          // later child failed. Keep its session marker in sync with its
          // durable local history even though the source deletion aborts.
          if (materialized.length > 0) await saveSessionsMeta(metas, { immediate: true });
          throw error;
        }
      }
      // Root-backed Run results must be cleared before removing the session
      // record. If the broker is unavailable, keep the session addressable so
      // the owner can retry instead of leaving inaccessible retained data.
      let removedRunIds;
      try { removedRunIds = await removeRunsForSession(sessionId); }
      catch (error) {
        if (materialized.length > 0) await saveSessionsMeta(metas, { immediate: true });
        throw error;
      }
      metas.splice(index, 1);
      await saveSessionsMeta(metas, { immediate: true });
      return { removedRunIds };
    });
    if (!removed) return null;

    stopObservedRun(activeRunId);
    await releaseSessionRuntimeState(sessionId, { force: true });
    releaseSessionTimelineCache(sessionId);
    await removeSessionHistory(sessionId);
    if (shouldExposeSession(current)) {
      broadcastSessionsInvalidation();
    }
    return { id: sessionId, removedRunIds: removed.removedRunIds };
  } finally {
    deletingSessionIds.delete(sessionId);
  }
}

// Shared-prefix metadata is written after the child session record. A crash
// in that small window must not leave a visible session that silently reads as
// an empty transcript. Mark broken shared forks hidden and retain the record
// for explicit repair/forensics; never synthesize an empty history.
export async function recoverSharedForkHistories() {
  const candidates = (await loadSessionsMeta()).filter((meta) => (
    meta?.historyStorage === 'shared-prefix-v1'
  ));
  const repairs = [];
  const pending = [];
  for (const meta of candidates) {
    try {
      await getHistoryBase(meta.id, { required: true, validate: true });
      if (meta.historyStatsState === 'pending' || meta.historyIndexState === 'pending') {
        pending.push(meta.id);
      }
    } catch (error) {
      repairs.push({
        sessionId: meta.id,
        code: error?.code || 'HISTORY_BASE_UNAVAILABLE',
        message: error?.message || 'Shared fork history is unavailable',
      });
    }
  }
  if (repairs.length === 0) {
    for (const sessionId of pending) scheduleForkHistoryIndexBuild(sessionId);
    return { checked: candidates.length, repaired: 0, scheduled: pending.length, repairs: [] };
  }
  const repairById = new Map(repairs.map((repair) => [repair.sessionId, repair]));
  await withSessionsMetaMutation(async (metas, saveSessionsMeta) => {
    let changed = false;
    for (const meta of metas) {
      const repair = repairById.get(meta?.id);
      if (!repair) continue;
      if (meta.archived !== true) {
        meta.archived = true;
        changed = true;
      }
      if (meta.userAddressable !== false) {
        meta.userAddressable = false;
        changed = true;
      }
      if (meta.historyRepairState !== repair.code) {
        meta.historyRepairState = repair.code;
        changed = true;
      }
      if (meta.historyRepairMessage !== repair.message) {
        meta.historyRepairMessage = repair.message;
        changed = true;
      }
    }
    if (changed) await saveSessionsMeta(metas, { immediate: true });
  });
  for (const sessionId of pending) scheduleForkHistoryIndexBuild(sessionId);
  return { checked: candidates.length, repaired: repairs.length, scheduled: pending.length, repairs };
}

// Legacy releases persisted archive as a recoverable state. It no longer
// exists: clean those sessions through the same durable deletion path at boot.
export async function purgeLegacyArchivedSessions() {
  const legacyIds = (await loadSessionsMeta())
    .filter((meta) => meta?.archived === true && !trimString(meta?.historyRepairState))
    .map((meta) => trimString(meta.id))
    .filter(Boolean);
  const deletedSessionIds = [];
  const skippedSessionIds = [];
  for (const sessionId of legacyIds) {
    try {
      const removed = await deleteSession(sessionId);
      if (removed) deletedSessionIds.push(sessionId);
    } catch (error) {
      if (error?.code === 'SESSION_DELETE_ACTIVE') {
        skippedSessionIds.push(sessionId);
        continue;
      }
      throw error;
    }
  }
  return { deletedSessionIds, skippedSessionIds };
}

export async function setSessionPinned(id, pinned = true) {
  const shouldPin = pinned === true;
  const result = await mutateSessionMeta(id, (session) => {
    const isPinned = session.pinned === true;
    if (isPinned === shouldPin) return false;
    if (shouldPin) {
      session.pinned = true;
    } else {
      delete session.pinned;
    }
    return true;
  });

  if (!result.meta) return null;
  if (result.changed && shouldExposeSession(result.meta)) {
    broadcastSessionsInvalidation();
  }
  if (result.changed) {
    broadcastSessionInvalidation(id);
  }
  return enrichSessionMeta(result.meta);
}

export async function updateSessionFollowUpQueue(id, options = {}) {
  const requestId = trimString(options.requestId);
  const clear = options.clear === true;
  const truncateFrom = options.truncateFrom === true;
  if (!clear && !requestId) {
    throw Object.assign(new Error('requestId is required'), { code: 'BAD_REQUEST' });
  }

  const result = await mutateSessionMeta(id, (session) => {
    const currentQueue = getFollowUpQueue(session);
    if (currentQueue.length === 0) return false;
    let nextQueue = [];
    if (clear) {
      nextQueue = [];
    } else if (truncateFrom) {
      const index = currentQueue.findIndex((entry) => trimString(entry?.requestId) === requestId);
      if (index < 0) return false;
      nextQueue = currentQueue.slice(0, index);
    } else {
      nextQueue = currentQueue.filter((entry) => trimString(entry?.requestId) !== requestId);
    }
    if (nextQueue.length === currentQueue.length) return false;
    if (nextQueue.length > 0) {
      session.followUpQueue = nextQueue;
    } else {
      delete session.followUpQueue;
      clearFollowUpFlushTimer(id);
    }
    session.updatedAt = nowIso();
    return true;
  });

  if (!result.meta) return null;
  if (result.changed) {
    broadcastSessionInvalidation(id);
    const remainingQueue = getFollowUpQueue(result.meta);
    if (remainingQueue.length > 0) {
      const activeRun = result.meta.activeRunId ? await getRun(result.meta.activeRunId) : null;
      const hasActiveRun = activeRun && !isTerminalRunState(activeRun.state);
      const hasPendingCompact = sessionRuntimeStateById.get(id)?.pendingCompact === true;
      if (!hasActiveRun && !hasPendingCompact) {
        scheduleQueuedFollowUpDispatch(id);
      }
    }
  }
  return enrichSessionMetaForClient(result.meta, { includeQueuedMessages: true });
}

async function waitForDetachedRunToStop(sessionId, runId, timeoutMs = FOLLOW_UP_STEER_CANCEL_TIMEOUT_MS) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let latestRun = await syncDetachedRun(sessionId, runId) || await getRun(runId);
  while (latestRun && !isTerminalRunState(latestRun.state) && Date.now() < deadline) {
    await sleep(OBSERVED_RUN_POLL_INTERVAL_MS);
    latestRun = await syncDetachedRun(sessionId, runId) || await getRun(runId);
  }
  return latestRun || null;
}

async function removeQueuedFollowUpForSteer(sessionId, requestId) {
  let removedEntry = null;
  let removedIndex = -1;
  const result = await mutateSessionMeta(sessionId, (session) => {
    const currentQueue = getFollowUpQueue(session);
    if (currentQueue.length === 0) return false;
    const index = currentQueue.findIndex((entry) => trimString(entry?.requestId) === requestId);
    if (index < 0) return false;
    removedEntry = currentQueue[index];
    removedIndex = index;
    const nextQueue = currentQueue.filter((_, itemIndex) => itemIndex !== index);
    if (nextQueue.length > 0) {
      session.followUpQueue = nextQueue;
    } else {
      delete session.followUpQueue;
      clearFollowUpFlushTimer(sessionId);
    }
    session.updatedAt = nowIso();
    return true;
  });
  return {
    changed: result.changed,
    meta: result.meta,
    entry: removedEntry,
    index: removedIndex,
  };
}

async function isAgyQueuedFollowUp(sessionMeta, queuedEntry, activeRun = null) {
  const runtimeFamily = trimString(
    activeRun?.runtimeFamily
      || activeRun?.providerCapabilities?.runtimeFamily,
  );
  if (isAgyRuntimeFamily(runtimeFamily)) return true;

  const toolId = trimString(queuedEntry?.tool || sessionMeta?.tool);
  if (toolId.toLowerCase() === 'agy') return true;
  if (!toolId) return false;

  const toolDefinition = await getToolDefinitionAsync(toolId).catch(() => null);
  return isAgyRuntimeFamily(toolDefinition?.runtimeFamily);
}

function throwAgySteerUnsupported() {
  throw Object.assign(
    new Error('Steer is not supported for the non-interactive AgY runtime; edit or delete the queued message instead'),
    { code: 'STEER_UNSUPPORTED' },
  );
}

async function restoreQueuedFollowUpAfterFailedSteer(sessionId, entry, index = -1) {
  if (!entry || !trimString(entry.requestId)) return false;
  const result = await mutateSessionMeta(sessionId, (session) => {
    const currentQueue = getFollowUpQueue(session);
    if (currentQueue.some((item) => trimString(item?.requestId) === trimString(entry.requestId))) {
      return false;
    }
    const nextQueue = [...currentQueue];
    const insertIndex = Number.isInteger(index) && index >= 0 && index <= nextQueue.length
      ? index
      : nextQueue.length;
    nextQueue.splice(insertIndex, 0, entry);
    session.followUpQueue = nextQueue;
    session.updatedAt = nowIso();
    return true;
  });
  if (result.changed) {
    scheduleQueuedFollowUpDispatch(sessionId);
    broadcastSessionInvalidation(sessionId);
  }
  return result.changed;
}

export async function steerQueuedFollowUp(id, options = {}) {
  const requestId = trimString(options.requestId);
  if (!requestId) {
    throw Object.assign(new Error('requestId is required'), { code: 'BAD_REQUEST' });
  }

  let sessionMeta = await findSessionMeta(id);
  if (!sessionMeta) return null;
  const queuedEntry = findQueuedFollowUpByRequest(sessionMeta, requestId);
  if (!queuedEntry) {
    throw Object.assign(new Error('Queued follow-up not found'), { code: 'NOT_FOUND' });
  }

  // AgY exposes only a non-interactive --print process. It can accept the
  // queued turn after the current run, but cannot receive a mid-turn steer or
  // an AgentoC cancel-and-replace steer without violating its runtime contract.
  if (await isAgyQueuedFollowUp(sessionMeta, queuedEntry)) {
    throwAgySteerUnsupported();
  }

  let interruptedRunId = null;
  const activeRunId = trimString(sessionMeta.activeRunId);
  if (activeRunId) {
    const activeRun = await flushDetachedRunIfNeeded(id, activeRunId) || await getRun(activeRunId);
    if (activeRun && !isTerminalRunState(activeRun.state)) {
      if (await isAgyQueuedFollowUp(sessionMeta, queuedEntry, activeRun)) {
        throwAgySteerUnsupported();
      }
      const dispatchOptions = resolveQueuedFollowUpDispatchOptions([queuedEntry], sessionMeta);
      const responseId = trimString(queuedEntry.responseId || queuedEntry.requestId);
      const queuedSourceContext = buildQueuedFollowUpSourceContext([queuedEntry]);
      const nativeSteer = await trySteerActiveBidirectionalRun({
        sessionId: id,
        session: sessionMeta,
        activeRun,
        requestId,
        responseId,
        text: buildQueuedFollowUpDispatchText([queuedEntry]),
        images: [],
        options: {
          tool: dispatchOptions.tool,
          model: dispatchOptions.model,
          effort: dispatchOptions.effort,
          serviceTier: dispatchOptions.serviceTier,
          thinking: dispatchOptions.thinking,
          ...sanitizeQueuedFollowUpOptions(queuedEntry),
          ...(queuedSourceContext ? { sourceContext: queuedSourceContext } : {}),
          preSavedAttachments: sanitizeQueuedFollowUpAttachments(getMessageAttachments(queuedEntry)),
        },
      });
      if (nativeSteer) {
        await removeQueuedFollowUpForSteer(id, requestId);
        await mutateSessionMeta(id, (session) => {
          session.recentFollowUpRequestIds = trimRecentFollowUpRequestIds([
            ...(session.recentFollowUpRequestIds || []),
            requestId,
          ]);
          session.updatedAt = nowIso();
          return true;
        });
        broadcastSessionInvalidation(id);
        return {
          ...nativeSteer,
          steered: true,
          interruptedRunId: null,
          queued: false,
          session: await getSession(id, { includeQueuedMessages: true }) || nativeSteer.session,
        };
      }

      interruptedRunId = activeRun.id;
      await requestRunCancel(activeRun.id);
      observeDetachedRun(id, activeRun.id);
      broadcastSessionInvalidation(id);
      const stoppedRun = await waitForDetachedRunToStop(id, activeRun.id);
      if (stoppedRun && !isTerminalRunState(stoppedRun.state)) {
        scheduleQueuedFollowUpDispatch(id, FOLLOW_UP_FLUSH_DELAY_MS);
        return {
          requestId,
          steered: false,
          pendingCancel: true,
          interruptedRunId,
          queued: true,
          run: stoppedRun,
          session: await getSession(id, { includeQueuedMessages: true }) || await enrichSessionMetaForClient(sessionMeta, { includeQueuedMessages: true }),
        };
      }
    }
    sessionMeta = await findSessionMeta(id) || sessionMeta;
  }

  const removed = await removeQueuedFollowUpForSteer(id, requestId);
  const entry = removed.entry || queuedEntry;
  if (!removed.changed || !entry) {
    throw Object.assign(new Error('Queued follow-up not found'), { code: 'NOT_FOUND' });
  }
  broadcastSessionInvalidation(id);

  try {
    const dispatchOptions = resolveQueuedFollowUpDispatchOptions([entry], sessionMeta);
    const responseId = trimString(entry.responseId || entry.requestId);
    const dispatchText = buildQueuedFollowUpDispatchText([entry]);
    const outcome = await submitHttpMessage(id, dispatchText, [], {
      requestId,
      ...(responseId ? { responseId } : {}),
      tool: dispatchOptions.tool,
      model: dispatchOptions.model,
      effort: dispatchOptions.effort,
      serviceTier: dispatchOptions.serviceTier,
      thinking: dispatchOptions.thinking,
      ...sanitizeQueuedFollowUpOptions(entry),
      preSavedAttachments: sanitizeQueuedFollowUpAttachments(getMessageAttachments(entry)),
      recordedUserText: buildQueuedFollowUpTranscriptText([entry]),
      queueIfBusy: false,
      skipDispatch: true,
    });

    await mutateSessionMeta(id, (session) => {
      session.recentFollowUpRequestIds = trimRecentFollowUpRequestIds([
        ...(session.recentFollowUpRequestIds || []),
        requestId,
      ]);
      session.updatedAt = nowIso();
      return true;
    });
    broadcastSessionInvalidation(id);
    return {
      ...outcome,
      steered: true,
      interruptedRunId,
      queued: false,
      session: await getSession(id, { includeQueuedMessages: true }) || outcome.session,
    };
  } catch (error) {
    await restoreQueuedFollowUpAfterFailedSteer(id, entry, removed.index);
    throw error;
  }
}

export async function renameSession(id, name, options = {}) {
  const nextName = typeof name === 'string' ? name.trim() : '';
  if (!nextName) return null;

  const result = await mutateSessionMeta(id, (session) => {
    const preserveAutoRename = options.preserveAutoRename === true;
    const nextPending = preserveAutoRename;
    const titleSource = typeof options.source === 'string' && options.source.trim()
      ? options.source.trim()
      : (preserveAutoRename ? 'provisional' : 'user');
    const titleAnchorRunId = typeof options.anchorRunId === 'string'
      ? options.anchorRunId.trim()
      : '';
    const changed = session.name !== nextName
      || session.autoRenamePending !== nextPending
      || session.titleSource !== titleSource
      || (titleAnchorRunId && session.titleAnchorRunId !== titleAnchorRunId)
      || (!titleAnchorRunId && !preserveAutoRename && !!session.titleAnchorRunId);
    if (!changed) return false;
    session.name = nextName;
    session.autoRenamePending = nextPending;
    session.titleSource = titleSource;
    session.titleUpdatedAt = nowIso();
    if (titleAnchorRunId) session.titleAnchorRunId = titleAnchorRunId;
    else if (!preserveAutoRename) delete session.titleAnchorRunId;
    session.updatedAt = nowIso();
    return true;
  });

  if (!result.meta) return null;
  clearRenameState(id);
  broadcastSessionInvalidation(id);
  return enrichSessionMeta(result.meta);
}

// A new foreground Run may retry missing/invalid title labels. Claim the
// title anchor under the same session metadata lock used by user renames, so
// a late result from an earlier Run cannot overwrite the newer Run or owner.
async function claimPendingSessionTitle(id, runId, firstUserText = '') {
  if (!runId) return null;
  const result = await mutateSessionMeta(id, (session) => {
    return claimPendingSessionTitleForRun(session, runId, firstUserText, nowIso());
  });
  if (!result.meta) return null;
  if (result.changed) {
    clearRenameState(id);
    broadcastSessionInvalidation(id);
  }
  return enrichSessionMeta(result.meta);
}

export async function updateSessionGrouping(id, patch = {}) {
  const result = await mutateSessionMeta(id, (session) => {
    let changed = false;
    if (Object.prototype.hasOwnProperty.call(patch, 'group')) {
      const nextGroup = normalizeSessionGroup(patch.group || '');
      if (nextGroup) {
        if (session.group !== nextGroup) {
          session.group = nextGroup;
          changed = true;
        }
      } else if (session.group) {
        delete session.group;
        changed = true;
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'description')) {
      const nextDescription = normalizeSessionDescription(patch.description || '');
      if (nextDescription) {
        if (session.description !== nextDescription) {
          session.description = nextDescription;
          changed = true;
        }
      } else if (session.description) {
        delete session.description;
        changed = true;
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'sidebarOrder')) {
      const nextSidebarOrder = normalizeSessionSidebarOrder(patch.sidebarOrder);
      if (nextSidebarOrder) {
        if (session.sidebarOrder !== nextSidebarOrder) {
          session.sidebarOrder = nextSidebarOrder;
          changed = true;
        }
      } else if (session.sidebarOrder) {
        delete session.sidebarOrder;
        changed = true;
      }
    }
    if (changed) {
      session.updatedAt = nowIso();
    }
    return changed;
  });

  if (!result.meta) return null;
  if (result.changed) {
    broadcastSessionInvalidation(id);
  }
  return enrichSessionMeta(result.meta);
}

async function updateSessionTaskCard(id, taskCard) {
  const nextTaskCard = normalizeSessionTaskCard(taskCard);
  const result = await mutateSessionMeta(id, (session) => {
    const currentTaskCard = normalizeSessionTaskCard(session.taskCard);
    if (JSON.stringify(currentTaskCard) === JSON.stringify(nextTaskCard)) {
      return false;
    }

    if (nextTaskCard) {
      session.taskCard = nextTaskCard;
    } else if (session.taskCard) {
      delete session.taskCard;
    }

    session.updatedAt = nowIso();
    return true;
  });

  if (!result.meta) return null;
  if (result.changed) {
    broadcastSessionInvalidation(id);
  }
  const enriched = await enrichSessionMeta(result.meta);
  return await maybeRetireWelcomeOnboarding(id, enriched) || enriched;
}

export async function updateSessionGoal(id, goalInput) {
  // PATCH path: only the user-writable intent (objective/tokenBudget/enabled)
  // is accepted, and any stale codex snapshot is reset — the next turn will
  // re-apply the intent and refresh the snapshot from thread/goal/updated.
  const nextGoal = normalizeSessionGoalIntent(goalInput);
  const result = await mutateSessionMeta(id, (session) => {
    if (nextGoal) {
      if (JSON.stringify(session.goal) === JSON.stringify(nextGoal)) {
        return false;
      }
      session.goal = nextGoal;
    } else if (session.goal) {
      delete session.goal;
    } else {
      return false;
    }
    session.updatedAt = nowIso();
    return true;
  });

  if (!result.meta) return null;
  if (result.changed) {
    broadcastSessionInvalidation(id);
  }
  const enriched = await enrichSessionMeta(result.meta);
  return await maybeRetireWelcomeOnboarding(id, enriched) || enriched;
}

async function maybeRetireWelcomeOnboarding(sessionId, session = null) {
  const currentSession = session || await getSession(sessionId);
  if (!shouldRetireWelcomeOnboarding(currentSession)) {
    return null;
  }

  const retiredAt = nowIso();
  const result = await mutateSessionMeta(sessionId, (draft) => {
    if (!isWelcomeOnboardingActive(draft)) {
      return false;
    }

    let changed = false;
    if (draft.systemPrompt) {
      delete draft.systemPrompt;
      changed = true;
    }
    if (!draft.welcomeOnboardingRetiredAt) {
      draft.welcomeOnboardingRetiredAt = retiredAt;
      changed = true;
    }
    if (draft.entryMode) {
      delete draft.entryMode;
      changed = true;
    }
    if (changed) {
      draft.updatedAt = retiredAt;
    }
    return changed;
  });
  const clearedResume = await clearPersistedResumeIds(sessionId);

  if (!result.meta) {
    if (clearedResume) {
      broadcastSessionInvalidation(sessionId);
    }
    return await getSession(sessionId);
  }
  if (result.changed || clearedResume) {
    broadcastSessionInvalidation(sessionId);
  }
  return getSession(sessionId);
}

export async function updateSessionAgreements(id, patch = {}) {
  const hasActiveAgreements = Object.prototype.hasOwnProperty.call(patch || {}, 'activeAgreements');
  if (!hasActiveAgreements) {
    return getSession(id);
  }

  const nextActiveAgreements = normalizeSessionAgreements(patch.activeAgreements);
  const result = await mutateSessionMeta(id, (session) => {
    const currentActiveAgreements = normalizeSessionAgreements(session.activeAgreements || []);
    if (JSON.stringify(currentActiveAgreements) === JSON.stringify(nextActiveAgreements)) {
      return false;
    }

    if (nextActiveAgreements.length > 0) {
      session.activeAgreements = nextActiveAgreements;
    } else if (session.activeAgreements) {
      delete session.activeAgreements;
    }

    session.updatedAt = nowIso();
    return true;
  });

  if (!result.meta) return null;
  if (result.changed) {
    broadcastSessionInvalidation(id);
  }
  return enrichSessionMeta(result.meta);
}

export async function updateSessionWorkflowState(id, workflowState) {
  return updateSessionWorkflowClassification(id, { workflowState });
}

export async function updateSessionWorkflowPriority(id, workflowPriority) {
  return updateSessionWorkflowClassification(id, { workflowPriority });
}

export async function updateSessionLastReviewedAt(id, lastReviewedAt) {
  const nextLastReviewedAt = normalizeSessionReviewedAt(lastReviewedAt || '');
  const result = await mutateSessionMeta(id, (session) => {
    const currentLastReviewedAt = normalizeSessionReviewedAt(session.lastReviewedAt || '');
    if (nextLastReviewedAt) {
      if (currentLastReviewedAt !== nextLastReviewedAt) {
        session.lastReviewedAt = nextLastReviewedAt;
        return true;
      }
      return false;
    }

    if (currentLastReviewedAt) {
      delete session.lastReviewedAt;
      return true;
    }

    return false;
  });

  if (!result.meta) return null;
  if (result.changed) {
    broadcastSessionInvalidation(id);
  }
  return enrichSessionMeta(result.meta);
}

export async function updateSessionEntryMode(id, entryMode) {
  const requestedEntryMode = normalizeSessionEntryMode(entryMode, { allowDefault: true });
  const result = await mutateSessionMeta(id, (session) => {
    const currentEntryMode = normalizeSessionEntryMode(session.entryMode);
    if (requestedEntryMode === 'read') {
      if (currentEntryMode !== 'read') {
        session.entryMode = 'read';
        session.updatedAt = nowIso();
        return true;
      }
      return false;
    }

    if (currentEntryMode) {
      delete session.entryMode;
      session.updatedAt = nowIso();
      return true;
    }

    return false;
  });

  if (!result.meta) return null;
  if (result.changed) {
    broadcastSessionInvalidation(id);
  }
  return enrichSessionMeta(result.meta);
}

export async function updateSessionWorkflowClassification(id, payload = {}) {
  const {
    workflowState,
    workflowPriority,
  } = payload;
  const nextWorkflowState = normalizeSessionWorkflowState(workflowState || '');
  const hasWorkflowState = Object.prototype.hasOwnProperty.call(payload, 'workflowState');
  const nextWorkflowPriority = normalizeSessionWorkflowPriority(workflowPriority || '');
  const hasWorkflowPriority = Object.prototype.hasOwnProperty.call(payload, 'workflowPriority');
  const result = await mutateSessionMeta(id, (session) => {
    const currentWorkflowState = normalizeSessionWorkflowState(session.workflowState || '');
    const currentWorkflowPriority = normalizeSessionWorkflowPriority(session.workflowPriority || '');
    let changed = false;

    if (hasWorkflowState) {
      if (nextWorkflowState) {
        if (currentWorkflowState !== nextWorkflowState) {
          session.workflowState = nextWorkflowState;
          // Timestamp of the last workflow-state transition; the front end
          // compares it against the session review stamp to hide the
          // "needs your action" amber dot once the owner has opened the
          // session after the state change.
          session.workflowStateChangedAt = nowIso();
          changed = true;
        }
      } else if (currentWorkflowState) {
        delete session.workflowState;
        session.workflowStateChangedAt = nowIso();
        changed = true;
      }
    }

    if (hasWorkflowPriority) {
      if (nextWorkflowPriority) {
        if (currentWorkflowPriority !== nextWorkflowPriority) {
          session.workflowPriority = nextWorkflowPriority;
          changed = true;
        }
      } else if (currentWorkflowPriority) {
        delete session.workflowPriority;
        changed = true;
      }
    }

    return changed;
  });

  if (!result.meta) return null;
  if (result.changed) {
    broadcastSessionInvalidation(id);
  }
  return enrichSessionMeta(result.meta);
}

async function updateSessionTool(id, tool) {
  const nextTool = typeof tool === 'string' ? tool.trim() : '';
  if (!nextTool) return null;

  const result = await mutateSessionMeta(id, (session) => {
    if (session.tool === nextTool) return false;
    session.tool = nextTool;
    delete session.agyConversationId;
    delete session.agyProviderProfileId;
    session.updatedAt = nowIso();
    return true;
  });

  if (!result.meta) return null;
  if (result.changed) {
    broadcastSessionInvalidation(id);
  }
  return enrichSessionMeta(result.meta);
}

async function applySessionTemplateMetadata(id, template, extra = {}) {
  const result = await mutateSessionMeta(id, (session) => {
    let changed = false;
    const nextTemplateId = normalizeAppId(template?.id);
    const nextTemplateName = typeof template?.name === 'string' ? template.name.trim() : '';
    const nextSystemPrompt = typeof template?.systemPrompt === 'string' ? template.systemPrompt : '';
    const nextTool = typeof template?.tool === 'string' ? template.tool.trim() : '';

    if (nextTemplateId) {
      if (session.templateId !== nextTemplateId) {
        session.templateId = nextTemplateId;
        changed = true;
      }
    } else if (session.templateId) {
      delete session.templateId;
      changed = true;
    }

    if (nextTemplateName) {
      if (session.templateName !== nextTemplateName) {
        session.templateName = nextTemplateName;
        changed = true;
      }
    } else if (session.templateName) {
      delete session.templateName;
      changed = true;
    }

    if (nextSystemPrompt) {
      if (session.systemPrompt !== nextSystemPrompt) {
        session.systemPrompt = nextSystemPrompt;
        changed = true;
      }
    } else if (session.systemPrompt) {
      delete session.systemPrompt;
      changed = true;
    }

    if (nextTool && session.tool !== nextTool) {
      session.tool = nextTool;
      changed = true;
    }

    if (Object.prototype.hasOwnProperty.call(extra, 'templateAppliedAt')) {
      const templateAppliedAt = typeof extra.templateAppliedAt === 'string' ? extra.templateAppliedAt.trim() : '';
      if (templateAppliedAt) {
        if (session.templateAppliedAt !== templateAppliedAt) {
          session.templateAppliedAt = templateAppliedAt;
          changed = true;
        }
      } else if (session.templateAppliedAt) {
        delete session.templateAppliedAt;
        changed = true;
      }
    }

    if (changed) {
      session.updatedAt = nowIso();
    }
    return changed;
  });

  if (!result.meta) return null;
  if (result.changed) {
    broadcastSessionInvalidation(id);
  }
  return enrichSessionMeta(result.meta);
}

export async function updateSessionRuntimePreferences(id, patch = {}) {
  if (WORKBENCH_EXECUTION_POLICY) {
    assertWorkbenchExecution({ ...(patch.tool ? { agentType: patch.tool } : {}),
      ...(patch.model ? { model: patch.model } : {}),
      ...(patch.providerProfile ? { providerProfileId: patch.providerProfile } : {}) });
    patch = { ...patch, riskMode: 'safe', privilegedMode: false, permissionMode: 'untrusted-read-only' };
  }
  const hasToolPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'tool');
  const hasProviderProfilePatch = Object.prototype.hasOwnProperty.call(patch || {}, 'providerProfile');
  const hasModelPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'model');
  const hasEffortPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'effort');
  const hasServiceTierPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'serviceTier');
  const hasThinkingPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'thinking');
  const hasPermissionModePatch = Object.prototype.hasOwnProperty.call(patch || {}, 'permissionMode');
  const hasInteractionModePatch = Object.prototype.hasOwnProperty.call(patch || {}, 'interactionMode');
  const hasPrivilegedModePatch = Object.prototype.hasOwnProperty.call(patch || {}, 'privilegedMode');
  const hasRiskModePatch = Object.prototype.hasOwnProperty.call(patch || {}, 'riskMode');
  if (!hasToolPatch && !hasProviderProfilePatch && !hasModelPatch && !hasEffortPatch && !hasServiceTierPatch && !hasThinkingPatch && !hasPermissionModePatch && !hasInteractionModePatch && !hasPrivilegedModePatch && !hasRiskModePatch) {
    return getSession(id);
  }

  const nextTool = hasToolPatch && typeof patch.tool === 'string'
    ? patch.tool.trim()
    : '';
  const currentMeta = await findSessionMeta(id);
  if (!currentMeta) return null;
  if (hasProviderProfilePatch) {
    const effectiveTool = nextTool || trimString(currentMeta.tool);
    const providerApp = resolveProviderAppForTool(effectiveTool);
    const nextProviderProfile = typeof patch.providerProfile === 'string'
      ? patch.providerProfile.trim()
      : '';
    if (!providerApp && nextProviderProfile) {
      const error = new Error('providerProfile is only supported for Codex, Claude, and AgY sessions');
      error.code = 'INVALID_PROVIDER_PROFILE';
      error.statusCode = 400;
      throw error;
    }
    if (providerApp && nextProviderProfile) {
      const providerExists = await nativeProviderProfileIsUsable(providerApp, nextProviderProfile);
      if (!providerExists) {
        const error = new Error(`${providerApp} provider does not exist: ${nextProviderProfile}`);
        error.code = 'INVALID_PROVIDER_PROFILE';
        error.statusCode = 400;
        throw error;
      }
    }
  }
  let toolChanged = false;

  const result = await mutateSessionMeta(id, (session) => {
    let changed = false;

    if (hasToolPatch && nextTool && session.tool !== nextTool) {
      session.tool = nextTool;
      if (session.providerProfile) {
        delete session.providerProfile;
      }
      delete session.claudeModelContract;
      delete session.agyConversationId;
      delete session.agyProviderProfileId;
      toolChanged = true;
      changed = true;
    }

    if (hasProviderProfilePatch) {
      const nextProviderProfile = typeof patch.providerProfile === 'string'
        ? patch.providerProfile.trim()
        : '';
      if ((session.providerProfile || '') !== nextProviderProfile) {
        if (nextProviderProfile) session.providerProfile = nextProviderProfile;
        else delete session.providerProfile;
        if (!hasModelPatch) delete session.model;
        delete session.claudeModelContract;
        delete session.claudeSessionId;
        delete session.codexThreadId;
        delete session.codexThreadModel;
        delete session.codexThreadEffort;
        delete session.codexThreadServiceTier;
        delete session.agyConversationId;
        delete session.agyProviderProfileId;
        delete session.providerContext;
        changed = true;
      }
    }

    if (hasModelPatch) {
      const nextModel = typeof patch.model === 'string' ? patch.model.trim() : '';
      const modelChanged = (session.model || '') !== nextModel;
      if (modelChanged) {
        session.model = nextModel;
        delete session.claudeModelContract;
        changed = true;
      }
      if (!nextModel && (session.claudeSessionId || session.codexThreadId)) {
        delete session.claudeSessionId;
        delete session.codexThreadId;
        delete session.codexThreadModel;
        changed = true;
      } else if (nextModel && modelChanged) {
        if (session.agyConversationId) {
          delete session.agyConversationId;
          delete session.agyProviderProfileId;
          changed = true;
        }
        if (session.codexThreadId) {
          delete session.codexThreadId;
          changed = true;
        }
        if (session.codexThreadModel) {
          delete session.codexThreadModel;
          changed = true;
        }
        if (session.codexThreadEffort) {
          delete session.codexThreadEffort;
          changed = true;
        }
        if (session.codexThreadServiceTier) {
          delete session.codexThreadServiceTier;
          changed = true;
        }
        changed = clearProviderContextEntry(session, 'codex') || changed;
      }
      if (!nextModel && session.codexThreadModel) {
        delete session.codexThreadModel;
        changed = true;
      }
      if (!nextModel && session.codexThreadEffort) {
        delete session.codexThreadEffort;
        changed = true;
      }
      if (!nextModel && session.codexThreadServiceTier) {
        delete session.codexThreadServiceTier;
        changed = true;
      }
    }

    if (hasEffortPatch) {
      const nextEffort = typeof patch.effort === 'string' ? patch.effort.trim() : '';
      if ((session.effort || '') !== nextEffort) {
        session.effort = nextEffort;
        changed = true;
      }
    }

    if (hasServiceTierPatch) {
      const nextServiceTier = normalizeCodexServiceTier(patch.serviceTier);
      if (nextServiceTier === 'fast') {
        if (session.serviceTier !== nextServiceTier) {
          session.serviceTier = nextServiceTier;
          changed = true;
        }
      } else if (session.serviceTier) {
        delete session.serviceTier;
        changed = true;
      }
    }

    if (hasThinkingPatch) {
      const nextThinking = patch.thinking === true;
      if (session.thinking !== nextThinking) {
        session.thinking = nextThinking;
        changed = true;
      }
    }

    if (hasPermissionModePatch) {
      const nextPermissionMode = typeof patch.permissionMode === 'string' ? patch.permissionMode.trim() : '';
      if ((session.permissionMode || '') !== nextPermissionMode) {
        if (nextPermissionMode) session.permissionMode = nextPermissionMode;
        else delete session.permissionMode;
        changed = true;
      }
    }

    if (hasPrivilegedModePatch) {
      const nextPrivilegedMode = patch.privilegedMode === true;
      if ((session.privilegedMode === true) !== nextPrivilegedMode) {
        if (nextPrivilegedMode) session.privilegedMode = true;
        else delete session.privilegedMode;
        changed = true;
      }
      // Legacy shim (统一风险门控计划 phase 3): turning the old privilegedMode
      // ON now also sets riskMode 'safe', so the session resolves gated under
      // the unified model. An explicit riskMode in the same patch wins.
      if (nextPrivilegedMode && !hasRiskModePatch && session.riskMode !== 'safe') {
        session.riskMode = 'safe';
        delete session.riskModeExplicit;
        changed = true;
      }
    }

    if (hasRiskModePatch) {
      const nextRiskMode = typeof patch.riskMode === 'string'
        ? patch.riskMode.trim().toLowerCase()
        : '';
      if (nextRiskMode) {
        if (RISK_MODES.includes(nextRiskMode) && session.riskMode !== nextRiskMode) {
          session.riskMode = nextRiskMode;
          changed = true;
        }
        if (RISK_MODES.includes(nextRiskMode)) {
          if (nextRiskMode === 'full-auto') {
            if (session.riskModeExplicit !== true) {
              session.riskModeExplicit = true;
              changed = true;
            }
          } else if (Object.prototype.hasOwnProperty.call(session, 'riskModeExplicit')) {
            delete session.riskModeExplicit;
            changed = true;
          }
        }
      } else if (session.riskMode) {
        // Clearing falls back to the derived default (recommended / safe for
        // legacy privilegedMode sessions) at run-launch.
        delete session.riskMode;
        delete session.riskModeExplicit;
        changed = true;
      }
    }

    if (hasInteractionModePatch) {
      const nextInteractionMode = typeof patch.interactionMode === 'string'
        ? patch.interactionMode.trim().toLowerCase()
        : '';
      if (['agent', 'plan'].includes(nextInteractionMode) && session.interactionMode !== nextInteractionMode) {
        session.interactionMode = nextInteractionMode;
        changed = true;
      }
    }

    if (changed) {
      session.updatedAt = nowIso();
    }
    return changed;
  });

  let effectiveMeta = result.meta;
  let changed = !!result.changed;
  if (!effectiveMeta) return null;
  if (!changed) {
    return enrichSessionMeta(effectiveMeta);
  }

  broadcastSessionInvalidation(id);
  if (shouldExposeSession(effectiveMeta)) {
    broadcastSessionsInvalidation();
  }
  return enrichSessionMeta(effectiveMeta);
}

async function hasBlockingInteractiveRun(session) {
  if (!session || !isSessionRunning(session)) return false;
  const runId = getSessionRunId(session);
  if (!runId) return true;
  const run = await getRun(runId);
  if (!run || isTerminalRunState(run.state)) return false;
  const manifest = await getRunManifest(runId);
  return !isReplySelfRepairOperation(manifest);
}

export async function saveSessionAsTemplate(sessionId, name = '') {
  const session = await getSession(sessionId);
  if (!session) return null;
  if (session.visitorId) return null;
  if (await hasBlockingInteractiveRun(session)) return null;

  const [snapshot, contextHead] = await Promise.all([
    getHistorySnapshot(sessionId),
    getContextHead(sessionId),
  ]);
  const prepared = await getOrPrepareForkContext(sessionId, snapshot, contextHead);
  const templateContent = buildSavedTemplateContextContent(prepared);

  if (!templateContent && !(session.systemPrompt || '').trim()) {
    return null;
  }

  return createApp({
    name: name || `Template - ${session.name || 'Session'}`,
    systemPrompt: session.systemPrompt || '',
    welcomeMessage: '',
    skills: [],
    tool: session.tool || 'codex',
    templateContext: templateContent
      ? {
          content: templateContent,
          sourceSessionId: session.id,
          sourceSessionName: session.name || '',
          sourceSessionUpdatedAt: session.updatedAt || session.created || nowIso(),
          updatedAt: nowIso(),
        }
      : null,
  });
}

export async function applyTemplateToSession(sessionId, templateId, options = {}) {
  const session = await getSession(sessionId);
  if (!session) return null;
  if (session.visitorId && options?.allowVisitor !== true) return null;
  if (isSessionRunning(session)) return null;
  if ((session.messageCount || 0) > 0) return null;

  const template = await getApp(templateId);
  if (!template) return null;

  if (await sessionHasTemplateContextEvent(sessionId)) {
    return null;
  }

  const templateFreshness = await resolveAppTemplateFreshness(template);
  const shouldAppendWelcome = options?.appendWelcome === true;
  const welcomeMessage = typeof template?.welcomeMessage === 'string'
    ? template.welcomeMessage.trim()
    : '';

  const appliedAt = nowIso();
  const updatedSession = await applySessionTemplateMetadata(sessionId, template, {
    templateAppliedAt: appliedAt,
  });
  if (!updatedSession) return null;

  if (template.templateContext?.content) {
    await appendEvent(sessionId, {
      type: 'template_context',
      templateId: template.id,
      templateName: template.name || 'Template',
      content: template.templateContext.content,
      ...templateFreshness,
      timestamp: Date.now(),
    });
    await clearForkContext(sessionId);
  }

  if (shouldAppendWelcome && welcomeMessage) {
    await appendEvent(sessionId, messageEvent('assistant', welcomeMessage));
  }

  return getSession(sessionId);
}
// Risk-gated permission model (统一风险门控计划 phase 3): the per-session
// semantic ('safe' | 'recommended' | 'full-auto'). New and legacy ordinary
// Existing unmarked sessions preserve their prior recommended behavior; new
// Sessions take the account default. The sidecar reads
// `manifest.options.riskMode` to dispatch its gate.
const RISK_MODES = Object.freeze(['safe', 'recommended', 'full-auto', 'conservative-auto']);

export function resolveSessionRiskModeForRun(session) {
  if (WORKBENCH_EXECUTION_POLICY) return 'safe';
  const explicit = trimString(session?.riskMode);
  if (explicit === 'full-auto' && session?.riskModeExplicit !== true) return 'recommended';
  if (RISK_MODES.includes(explicit)) return explicit;
  return session?.privilegedMode === true ? 'safe' : 'recommended';
}

function resolveSessionRiskMode(session) {
  return resolveSessionRiskModeForRun(session);
}

function createUnsupportedRiskGateError({ sessionId, tool, runtimeFamily, riskMode }) {
  const error = new Error(
    'The selected Harness cannot return permission decisions to Ragent; choose an autonomous profile or a runtime with an approval channel',
  );
  error.code = 'PRIVILEGED_GATE_UNSUPPORTED_RUNTIME';
  error.statusCode = 409;
  error.sessionId = trimString(sessionId);
  error.tool = trimString(tool);
  error.runtimeFamily = trimString(runtimeFamily);
  error.riskMode = trimString(riskMode);
  if (runtimeFamily === 'claude-stream-json') {
    error.requiredRuntimeFamily = 'claude-stream-json-bidi';
  }
  return error;
}

function resolveSessionProviderPermissionContract({
  sessionId,
  tool,
  runtimeFamily,
  session,
  requestedPermissionMode,
  interactionMode,
} = {}) {
  const sessionRiskMode = resolveSessionRiskMode(session);
  const sessionPrivilegedMode = session?.privilegedMode === true
    && sessionRiskMode !== 'full-auto' && sessionRiskMode !== 'conservative-auto';
  const riskGated = sessionRiskMode === 'safe' || sessionRiskMode === 'recommended';
  const gatedPermissionModeId = getGatedPermissionModeId(runtimeFamily);
  if (riskGated && !gatedPermissionModeId) {
    throw createUnsupportedRiskGateError({
      sessionId,
      tool,
      runtimeFamily,
      riskMode: sessionRiskMode,
    });
  }

  const effectivePermissionPolicy = resolveProviderPermissionPolicy(runtimeFamily, {
    permissionMode: requestedPermissionMode,
    interactionMode,
    privilegedMode: sessionPrivilegedMode,
    riskMode: sessionRiskMode,
  });
  const unattendedProfile = sessionRiskMode === 'full-auto'
    || sessionRiskMode === 'conservative-auto';
  if ((sessionRiskMode === 'conservative-auto'
      || (sessionRiskMode === 'full-auto' && (process.platform === 'win32' || requiresExplicitAcpAutoMode(runtimeFamily))))
      && !effectivePermissionPolicy) {
    const error = new Error(`The ${trimString(runtimeFamily) || 'unknown'} Harness cannot enforce ${sessionRiskMode} permissions`);
    error.code = 'PERMISSION_PROFILE_UNSUPPORTED_RUNTIME';
    error.statusCode = 409;
    throw error;
  }
  // Skip requested-mode validation when the session policy is overriding it.
  // A gated mode legitimately differs from the caller's requested provider
  // mode; runtimes without an AgentoC approval channel were rejected above.
  if (!sessionPrivilegedMode && !riskGated && !unattendedProfile && requestedPermissionMode
      && trimString(effectivePermissionPolicy?.id) !== requestedPermissionMode) {
    throw new Error(`permissionMode "${requestedPermissionMode}" is not supported for this runtime`);
  }
  return {
    sessionRiskMode,
    sessionPrivilegedMode,
    riskGated,
    gatedPermissionModeId,
    effectivePermissionPolicy,
    effectivePermissionMode: trimString(effectivePermissionPolicy?.id),
  };
}

function resolveProviderAppForTool(toolId) {
  const tool = trimString(toolId);
  if (!tool) return '';
  // Provider profiles belong to the built-in provider tools. Custom tools may
  // intentionally use a provider-shaped runtime family (for example an
  // isolated app-server test double) without sharing provider credentials.
  if (tool === 'claude' || tool === 'claude-bidi') return 'claude';
  if (tool === 'codex' || tool === 'codex-cli') return 'codex';
  if (tool === 'agy') return 'agy';
  return '';
}

// Provider-profile PATCHes validate against the native registry and credential
// vault, so an unusable profile can never become a Run selection.
async function nativeProviderProfileIsUsable(app, providerId) {
  const { createNativeProviderRegistry, createSecretStore } = await import('../lib/provider-runtime/index.mjs');
  const registry = createNativeProviderRegistry({ configDir: CONFIG_DIR });
  const profile = (await registry.listProviderProfiles())
    .find((row) => row.agentType === app && row.id === providerId);
  if (!profile) return false;
  const authProfile = await registry.getAuthProfile(profile.authProfileId).catch(() => null);
  if (!authProfile) return false;
  const secretStore = createSecretStore({ configDir: CONFIG_DIR });
  const described = await secretStore.describeSecret(authProfile.storageRef).catch(() => null);
  return described?.ok === true;
}

function isoDurationMs(startAt, endAt) {
  const start = Date.parse(startAt || '');
  const end = Date.parse(endAt || '');
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function buildPreparingRunRecord({
  sessionId,
  requestId,
  responseId,
  primaryResponseId,
  publicationResponseIds,
  replyPublicationRootRunId,
  nextRunId,
  session,
  effectiveTool,
  requestedRunTemplateId,
  effectiveProviderContract,
  effectiveRuntimeFamily,
  effectiveProviderProfile,
  effectiveServiceTier,
  effectivePermissionMode,
  effectiveInteractionMode,
  sessionPrivilegedMode,
  riskGated,
  sessionRiskMode,
  runtimeOptions,
  resumeState,
  effectiveAgyResume,
  codexGoalIntent,
  approvedActionChannel,
  windowsBrokerChannel,
  sessionControlChannel,
  persistedClaudeSessionId,
  persistedCodexThreadId,
  persistedAgyConversationId,
  attachmentInputStage,
  runPromptText,
  previousTool,
  snapshot,
  normalizedText,
  recordedUserText,
  sourceContext,
  imageRefs,
  options,
  isFirstRecordedUserMessage,
  planArtifactForAction,
  requestedPlanAction,
  requestedPlanId,
  productAgentCreateEligible,
  effectiveToolDefinition,
}) {
  const ackAt = nowIso();
  const manifestOptions = {
    images: attachmentInputStage.stagedAttachments,
    thinking: options.thinking === true,
    model: options.model || undefined,
    effort: options.effort || undefined,
    serviceTier: effectiveServiceTier,
    providerProfile: effectiveProviderProfile || undefined,
    interactionMode: effectiveInteractionMode,
    permissionMode: effectivePermissionMode || undefined,
    ...(sessionPrivilegedMode ? { privilegedMode: true } : {}),
    riskMode: sessionRiskMode,
    ...(session?.folder ? { projectRoot: session.folder } : {}),
    ...(options.freshThread === true ? { freshThread: true } : {}),
    ...(options.skipSessionContinuation === true ? { skipSessionContinuation: true } : {}),
    ...(options.transientProviderContext === true ? { transientProviderContext: true } : {}),
    ...(options.browserMcpEnabled === true ? { browserMcpEnabled: true } : {}),
    ...(requestedPlanAction ? { planAction: requestedPlanAction } : {}),
    ...(requestedPlanId ? { planId: requestedPlanId } : {}),
    ...(runtimeOptions.codexResume === true ? { codexResume: true } : {}),
    runtimeFamily: effectiveRuntimeFamily || undefined,
    toolCommand: typeof effectiveToolDefinition?.command === 'string' && effectiveToolDefinition.command.trim()
      ? effectiveToolDefinition.command.trim()
      : undefined,
    claudeSessionId: persistedClaudeSessionId || undefined,
    codexThreadId: persistedCodexThreadId || undefined,
    agyConversationId: persistedAgyConversationId || undefined,
    providerResumeId: ['copilot', 'hermes', 'cline', 'kilo'].includes(resumeState.providerKey)
      ? resumeState.providerResumeId || undefined
      : undefined,
    ...(effectiveAgyResume ? { agyResume: true } : {}),
    ...(codexGoalIntent ? { codexGoal: codexGoalIntent } : {}),
    ...(approvedActionChannel ? { approvedActionChannel } : {}),
    ...(windowsBrokerChannel ? { windowsBrokerChannel } : {}),
    ...(sessionControlChannel ? { sessionControlChannel } : {}),
  };
  const status = {
    sessionId,
    requestId,
    responseId: primaryResponseId || null,
    state: 'preparing',
    ackAt,
    tool: effectiveTool,
    providerProfile: effectiveProviderProfile || null,
    model: options.model || null,
    effort: options.effort || null,
    serviceTier: effectiveServiceTier,
    thinking: options.thinking === true,
    provider: effectiveProviderContract.provider || null,
    runtimeFamily: effectiveProviderContract.runtimeFamily || effectiveRuntimeFamily || null,
    providerCapabilities: effectiveProviderContract.providerCapabilities || null,
    permissionMode: effectivePermissionMode || null,
    claudeSessionId: persistedClaudeSessionId,
    codexThreadId: persistedCodexThreadId,
    agyConversationId: persistedAgyConversationId,
    agyProviderProfileId: effectiveTool === 'agy' ? effectiveProviderProfile || null : null,
    providerResumeId: resumeState.providerResumeId || null,
    providerResumeMode: resumeState.hasResume ? 'native' : 'semantic',
    providerResumeReason: resumeState.reason,
    ...(approvedActionChannel ? { approvedActionChannel: { enabled: true } } : {}),
    ...(windowsBrokerChannel ? { windowsBrokerChannel: { enabled: true } } : {}),
    ...(sessionControlChannel ? { sessionControlChannel: { enabled: true } } : {}),
    transientProviderContext: options.transientProviderContext === true,
    internalOperation: options.internalOperation || null,
    replyPublicationRootRunId: replyPublicationRootRunId || null,
    ...(requestedRunTemplateId && requestedRunTemplateId !== normalizeAppId(session.templateId)
      ? { agentTemplateId: requestedRunTemplateId }
      : {}),
  };
  const baseManifest = {
    sessionId,
    requestId,
    responseId: primaryResponseId || null,
    ...(attachmentInputStage.sourceRefs.length > 0
      ? { attachmentRefs: attachmentInputStage.sourceRefs }
      : {}),
    ...(attachmentInputStage.staging ? { attachmentStaging: attachmentInputStage.staging } : {}),
    folder: session.folder,
    tool: effectiveTool,
    ...(requestedRunTemplateId && requestedRunTemplateId !== normalizeAppId(session.templateId)
      ? { agentTemplateId: requestedRunTemplateId, agentTemplateName: '' }
      : {}),
    ...(effectiveProviderContract.provider ? { provider: effectiveProviderContract.provider } : {}),
    ...(effectiveProviderContract.runtimeFamily || effectiveRuntimeFamily
      ? { runtimeFamily: effectiveProviderContract.runtimeFamily || effectiveRuntimeFamily }
      : {}),
    ...(effectiveProviderContract.providerCapabilities
      ? { providerCapabilities: effectiveProviderContract.providerCapabilities }
      : {}),
    instructionRevision: runtimeOptions.instructionRevision,
    providerResumeMode: resumeState.hasResume ? 'native' : 'semantic',
    providerResumeReason: resumeState.reason,
    ...(effectivePermissionMode ? { permissionMode: effectivePermissionMode } : {}),
    transientProviderContext: options.transientProviderContext === true,
    internalOperation: options.internalOperation || null,
    ...(replyPublicationRootRunId ? { replyPublicationRootRunId } : {}),
    ...(publicationResponseIds.length > 0 ? { replyPublicationResponseIds: publicationResponseIds } : {}),
    ...(typeof options.compactionTargetSessionId === 'string' && options.compactionTargetSessionId
      ? { compactionTargetSessionId: options.compactionTargetSessionId }
      : {}),
    ...(Number.isInteger(options.compactionSourceSeq) ? { compactionSourceSeq: options.compactionSourceSeq } : {}),
    ...(typeof options.compactionToolIndex === 'string' ? { compactionToolIndex: options.compactionToolIndex } : {}),
    ...(typeof options.compactionReason === 'string' && options.compactionReason
      ? { compactionReason: options.compactionReason }
      : {}),
    options: manifestOptions,
  };
  return {
    ackAt,
    status,
    manifest: {
      ...baseManifest,
      preparation: {
        version: 1,
        productAgentCreateEligible: productAgentCreateEligible === true,
        promptInputs: {
          text: runPromptText,
          previousTool,
          effectiveTool,
          snapshot,
          runtimeOptions,
          requestedRunTemplateId: requestedRunTemplateId || '',
        },
        postInput: {
          normalizedText,
          recordedUserText,
          sourceContext,
          imageRefs,
          recordUserMessage: options.recordUserMessage !== false,
          isFirstRecordedUserMessage: isFirstRecordedUserMessage === true,
          requestedPlanAction: requestedPlanAction || '',
          requestedPlanId: requestedPlanId || '',
          planArtifactForAction: planArtifactForAction || null,
        },
      },
    },
  };
}

function promptEnvelopeFromManifest(manifest) {
  if (!manifest?.prompt) return null;
  return {
    prompt: manifest.prompt,
    metadata: manifest.contextRenderer || null,
    developerInstructions: manifest.developerInstructions || '',
    systemPrefix: manifest.systemPrefix || '',
    freshRecoveryPrompt: manifest.freshRecoveryPrompt || '',
    freshRecoveryDeveloperInstructions: manifest.freshRecoveryDeveloperInstructions || '',
    freshRecoverySystemPrefix: manifest.freshRecoverySystemPrefix || '',
  };
}

async function finishPreparingRunInputMetadata(sessionId, run, session, preparation) {
  const postInput = preparation?.postInput || {};
  const planAction = normalizePlanAction(postInput.requestedPlanAction);
  const planArtifact = postInput.planArtifactForAction;
  if (planArtifact && planAction) {
    const alreadyRecorded = await findLatestStoredEvent(sessionId, (event) => (
      event?.type === 'plan'
      && normalizePlanId(event.planId || event.artifactId || event.id) === planArtifact.planId
      && trimString(event.requestId) === trimString(run.requestId)
      && trimString(event.lastPlanAction).toLowerCase() === planAction
    )).catch(() => null);
    if (!alreadyRecorded) {
      await appendPlanArtifactStateEvent(sessionId, planArtifact, {
        state: planAction === 'execute' ? 'executing' : 'revising',
        run,
        requestId: run.requestId,
        responseId: run.responseId || '',
        lastPlanAction: planAction,
      });
    }
  }

  const toolDefinition = await getToolDefinitionAsync(run.tool).catch(() => null);
  const promptMode = toolDefinition?.promptMode === 'bare-user' ? 'bare-user' : 'default';
  if (promptMode === 'default') {
    const managerTurnContext = await buildManagerTurnContextText(
      session,
      postInput.normalizedText || postInput.recordedUserText || '',
    );
    if (managerTurnContext) {
      const alreadyRecorded = await findLatestStoredEvent(sessionId, (event) => (
        event?.type === 'manager_context'
        && trimString(event.requestId) === trimString(run.requestId)
      )).catch(() => null);
      if (!alreadyRecorded) {
        await appendEvent(sessionId, managerContextEvent(managerTurnContext, {
          requestId: run.requestId,
          ...(run.responseId ? { responseId: run.responseId } : {}),
          runId: run.id,
        }));
      }
    }
  }

  if (!run.internalOperation && isSessionAutoRenamePending(session)) {
    await claimPendingSessionTitle(sessionId, run.id,
      postInput.isFirstRecordedUserMessage === true ? postInput.recordedUserText || '' : '');
  }
  // The foreground prompt already carries the hidden label contract. Parsing
  // waits for terminal completion; no competing provider process is launched.
}

async function settlePreparingRunFailure(sessionId, run, manifest, error) {
  const current = await getRun(run.id).catch(() => null) || run;
  if (isTerminalRunState(current.state)) return current;
  const completedAt = nowIso();
  const cancelled = current.cancelRequested === true;
  const reason = error?.message || String(error || 'Preparing Run failed');
  const result = {
    completedAt,
    exitCode: 1,
    signal: null,
    ...(cancelled ? { cancelled: true } : { error: reason }),
    preparationFailed: !cancelled,
  };
  await writeRunResult(current.id, result);
  const failed = await updateRun(current.id, (latest) => ({
    ...latest,
    state: cancelled ? 'cancelled' : 'failed',
    completedAt,
    result,
    ...(cancelled ? {} : { failureReason: reason }),
  })) || current;
  await updateRunReplyPublication(failed.id, (publication) => ({
    ...publication,
    state: cancelled ? 'cancelled' : 'failed',
    failedAt: completedAt,
    lastError: cancelled ? '' : reason,
  })).catch(() => {});
  await mutateSessionMeta(sessionId, (session) => {
    if (session.activeRunId !== failed.id) return false;
    delete session.activeRunId;
    session.updatedAt = nowIso();
    return true;
  }).catch(() => {});
  broadcastSessionInvalidation(sessionId);
  try {
    if (failed.appApiMessageVersion === 1 && !hasRegisteredDetachedRunner(failed)) return failed;
    return await syncDetachedRun(sessionId, failed.id) || failed;
  } catch {
    return failed;
  }
}

async function continuePreparingRun(runId) {
  const run = await getRun(runId);
  const manifest = await getRunManifest(runId);
  if (!run || isTerminalRunState(run.state)) return run;
  if (run.appApiMessageVersion === 1) {
    return continueScopedMessageRun(run.id, {
      isSessionBusy: meta => ensureSessionRuntimeState(meta.id).pendingCompact === true,
      execute: executeScopedPreparingRun,
      settleFailure: ({ run, manifest }, error) => settlePreparingRunFailure(run.sessionId, run, manifest, error),
    });
  }
  if (!manifest?.preparation) return run;
  const sessionId = trimString(run.sessionId || manifest.sessionId);
  if (run.cancelRequested === true) {
    return settlePreparingRunFailure(sessionId, run, manifest, new Error('Preparing Run was cancelled'));
  }
  const preparation = manifest.preparation;
  try {
    const baseline = preparation.snapshot && typeof preparation.snapshot === 'object'
      ? preparation.snapshot
      : null;
    const beforeSeq = Number.isInteger(baseline?.latestSeq) && baseline.latestSeq >= 0
      ? baseline.latestSeq
      : null;
    const snapshotStartedHr = process.hrtime.bigint();
    const snapshot = await getHistorySnapshot(sessionId, {
      ...(beforeSeq !== null ? { beforeSeq, baseline } : {}),
      priority: 'interactive',
    });
    recordApiRequestPhase('send.history_snapshot', Number(process.hrtime.bigint() - snapshotStartedHr) / 1e6, {
      requestId: run.requestId,
      sessionId,
      runId,
    });
    return await submitHttpMessageInternal(sessionId, preparation.text, [], {
      ...(preparation.options || {}),
      requestId: run.requestId,
      responseId: run.responseId || undefined,
      preSavedAttachments: preparation.images || [],
      preparationRunId: run.id,
      preparationSnapshot: snapshot,
      preparationInputMetadata: preparation,
      userMessageAlreadyRecorded: true,
      backgroundPreparation: true,
    });
  } catch (error) {
    console.error(`[runs] deferred preparation failed for ${runId}: ${error?.message || error}`);
    return settlePreparingRunFailure(sessionId, run, manifest, error);
  }
}

async function executeScopedPreparingRun({ run, record, binding }) {
  await validatePreparedMessageAttachments(run.sessionId, binding.scope, record.request.attachments);
  const event = await appendRetainedMessageEvent(run.sessionId, messageEvent('user', record.request.text,
    buildMessageAttachmentRefs(record.request.attachments), {
      id: `message-run:${run.id}`, requestId: run.requestId, responseId: run.responseId, runId: run.id,
    }));
  const snapshot = await getHistorySnapshot(run.sessionId, { beforeSeq: Math.max(0, event.seq - 1), priority: 'interactive' });
  return submitHttpMessageInternal(run.sessionId, record.request.text, [], {
    ...record.request.runOptions, requestId: run.requestId, responseId: run.responseId,
    authenticatedPrincipalKind: binding.principalKind,
    authenticatedOwnerDevice: binding.ownerDevice,
    preSavedAttachments: record.request.attachments, preparationRunId: run.id,
    preparationSnapshot: snapshot, userMessageAlreadyRecorded: true, backgroundPreparation: true,
    queueIfBusy: false, deferIfBusy: false,
  });
}

export function scheduleScopedMessageRun(sessionId, runId) {
  const epoch = scopedMessageEpoch;
  const result = schedulePreparingRun(sessionId, runId);
  if (!result) return result;
  void result.then(outcome => {
    if (!outcome?.waiting || epoch !== scopedMessageEpoch || scopedMessageTimers.has(runId)) return;
    const timer = setTimeout(() => {
      scopedMessageTimers.delete(runId);
      scheduleScopedMessageRun(sessionId, runId);
    }, 500);
    timer.unref?.();
    scopedMessageTimers.set(runId, timer);
  }).catch(() => {});
  return result;
}

function schedulePreparingRun(sessionId, runId) {
  if (!runId) return null;
  const existing = preparingRunPromises.get(runId);
  if (existing) return existing;
  const promise = new Promise((resolve) => setImmediate(resolve))
    .then(() => continuePreparingRun(runId))
    .catch((error) => {
      console.error(`[runs] preparation scheduler failed for ${runId}: ${error?.message || error}`);
      return null;
    })
    .finally(() => {
      if (preparingRunPromises.get(runId) === promise) preparingRunPromises.delete(runId);
    });
  preparingRunPromises.set(runId, promise);
  return promise;
}

async function createPreparingHttpRun(prepared) {
  const ackAt = nowIso();
  const { run } = await publishSessionRun(prepared.sessionId, null, () => createRun({
    status: {
      id: prepared.runId,
      sessionId: prepared.sessionId,
      requestId: prepared.requestId,
      responseId: prepared.responseId,
      state: 'preparing',
      ackAt,
      tool: prepared.options.tool || prepared.session.tool || null,
      model: prepared.options.model || prepared.session.model || null,
      effort: prepared.options.effort || prepared.session.effort || null,
      serviceTier: prepared.options.serviceTier || prepared.session.serviceTier || 'standard',
      thinking: prepared.options.thinking === true,
    },
    manifest: {
      sessionId: prepared.sessionId,
      requestId: prepared.requestId,
      responseId: prepared.responseId,
      tool: prepared.options.tool || prepared.session.tool || null,
      folder: prepared.session.folder || '',
      preparation: {
        version: 1,
        text: prepared.normalizedText,
        images: sanitizeQueuedFollowUpAttachments(prepared.options.preSavedAttachments || []),
        options: prepared.preparationOptions,
        snapshot: prepared.snapshot,
        postInput: {
          normalizedText: prepared.normalizedText,
          recordedUserText: prepared.recordedUserText,
          sourceContext: prepared.sourceContext,
          imageRefs: prepared.imageRefs,
          recordUserMessage: prepared.options.recordUserMessage !== false,
          isFirstRecordedUserMessage: prepared.isFirstRecordedUserMessage === true,
          requestedPlanAction: prepared.requestedPlanAction || '',
          requestedPlanId: prepared.requestedPlanId || '',
          planArtifactForAction: prepared.planArtifactForAction || null,
        },
      },
    },
  }));
  setApiRequestCorrelation({ runId: run.id });
  await updateRunReplyPublication(run.id, () => buildInitialReplyPublication(run, [prepared.responseId]));
  if (prepared.options.recordUserMessage !== false) {
    await appendEvent(prepared.sessionId, messageEvent(
      'user',
      prepared.recordedUserText,
      prepared.imageRefs.length > 0 ? prepared.imageRefs : undefined,
      {
        requestId: prepared.requestId,
        responseId: prepared.primaryResponseId || undefined,
        runId: run.id,
        ...(prepared.sourceContext ? { sourceContext: prepared.sourceContext } : {}),
      },
    ));
  }
  broadcastSessionInvalidation(prepared.sessionId);
  schedulePreparingRun(prepared.sessionId, run.id);
  return {
    requestId: prepared.requestId,
    duplicate: false,
    queued: false,
    preparing: true,
    run,
    session: null,
    response: buildReplyPublicationSummary({ id: prepared.responseId, responseIds: [prepared.responseId], state: 'preparing' }),
  };
}

const PREPARATION_OPTION_KEYS = Object.freeze([
  'tool', 'model', 'effort', 'serviceTier', 'thinking', 'providerProfile', 'uiLanguage',
  'interactionMode', 'permissionMode',
  'harnessInstructions',
  'planAction', 'planId', 'sourceContext', 'templateId', 'agentId', 'browserMcpEnabled',
  'authenticatedPrincipalKind', 'authenticatedOwnerDevice', 'temporaryControlAuthority', 'internalOperation', 'collaborationCapability',
  'compactionTargetSessionId', 'compactionSourceSeq', 'compactionToolIndex', 'compactionReason',
  'freshThread', 'skipSessionContinuation', 'transientProviderContext', 'codexResume',
  'skipDispatch', 'skipPendingDispatchLookup', 'queueIfBusy', 'deferIfBusy', 'recordUserMessage',
  'replyPublicationRootRunId', 'replyPublicationResponseIds',
]);

function clonePreparationValue(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function buildPreparationOptions(options = {}) {
  const prepared = {};
  for (const key of PREPARATION_OPTION_KEYS) {
    const value = clonePreparationValue(options[key]);
    if (value !== undefined) prepared[key] = value;
  }
  return prepared;
}

function buildPreparationSnapshot(meta) {
  const counts = { ...(meta?.counts || {}) };
  const messageCount = (counts.message_user || 0) + (counts.message_assistant || 0);
  const latestSeq = Number.isInteger(meta?.latestSeq) ? meta.latestSeq : 0;
  return {
    latestSeq,
    lastEventAt: meta?.lastEventAt || null,
    lastActivityAt: meta?.lastActivityAt || null,
    lastAssistantMessageAt: meta?.lastAssistantMessageAt || null,
    size: Number.isInteger(meta?.size) ? meta.size : latestSeq,
    counts,
    messageCount,
    activeMessageCount: messageCount,
    userMessageCount: counts.message_user || 0,
    historyStatsState: meta?.historyStatsState || 'ready',
    hasVisibleHistory: meta?.hasVisibleHistory === true || latestSeq > 0,
    contextMode: 'history',
    activeFromSeq: 0,
    compactedThroughSeq: 0,
  };
}

async function submitPreparingHttpMessage(sessionId, text, images, options = {}) {
  if (deletingSessionIds.has(trimString(sessionId))) {
    throw createSessionDeleteError('Session deletion is in progress', 'SESSION_DELETE_IN_PROGRESS');
  }
  const requestId = typeof options.requestId === 'string' ? options.requestId.trim() : '';
  if (!requestId) throw new Error('requestId is required');
  const normalizedText = typeof text === 'string' ? text.trim() : '';
  if (!normalizedText) throw new Error('text is required');

  setApiRequestCorrelation({ requestId, sessionId });
  let sessionMeta = await measureApiRequestPhase('send.initial_session_meta', () => getSessionMeta(sessionId));
  if (!sessionMeta) throw new Error('Session not found');
  assertManagedInputAllowed({
    session: sessionMeta,
    operation: 'message',
    requestContext: { internalOperation: options?.internalOperation },
  });
  touchSessionRuntimeState(sessionId);

  if (typeof options.uiLanguage === 'string' && options.uiLanguage.trim()) {
    const normalizedLanguage = normalizeUiLanguagePreference(options.uiLanguage);
    if (sessionMeta.uiLanguage !== normalizedLanguage) {
      sessionMeta = await measureApiRequestPhase(
        'send.ui_language_persist',
        () => touchSessionMeta(sessionId, { uiLanguage: normalizedLanguage }),
      ) || sessionMeta;
    }
  }

  const existingRun = await measureApiRequestPhase(
    'send.idempotency_run_lookup',
    () => findRunByRequest(sessionId, requestId),
  );
  if (existingRun) {
    return {
      requestId,
      duplicate: true,
      queued: false,
      run: await getRun(existingRun.id) || existingRun,
      session: await getSession(sessionId),
      response: await getSessionReplyPublication(sessionId, resolveResponseId(requestId, options)),
    };
  }

  const activeRunId = trimString(sessionMeta.activeRunId);
  if (activeRunId) {
    const activeRun = await getRun(activeRunId).catch(() => null);
    if (activeRun && !isTerminalRunState(activeRun.state)) {
      return submitHttpMessageInternal(sessionId, normalizedText, images, {
        ...options,
        deferPromptBuild: false,
      });
    }
  }
  const dispatchSession = {
    ...sessionMeta,
    messageCount: (sessionMeta.counts?.message_user || 0) + (sessionMeta.counts?.message_assistant || 0),
  };
  if ((getFollowUpQueueCount(sessionMeta) > 0 || getPendingPlanningQueueCount(sessionMeta) > 0)
    || (shouldRunDispatch(dispatchSession, options) && shouldUseAsyncDispatchPlanning(dispatchSession, normalizedText))) {
    return submitHttpMessageInternal(sessionId, normalizedText, images, {
      ...options,
      deferPromptBuild: false,
    });
  }
  if (normalizePlanAction(options.planAction)) {
    return submitHttpMessageInternal(sessionId, normalizedText, images, {
      ...options,
      deferPromptBuild: false,
    });
  }
  await assertRunStartsAllowed();

  const responseId = resolveResponseId(requestId, options);
  const snapshot = buildPreparationSnapshot(sessionMeta);
  let savedImages = options.preSavedAttachments?.length > 0
    ? sanitizeQueuedFollowUpAttachments(options.preSavedAttachments)
    : [];
  if (savedImages.length === 0 && Array.isArray(images) && images.length > 0) {
    savedImages = sanitizeQueuedFollowUpAttachments(await saveAttachments(images));
  }
  const sourceAttachmentRefs = toAssetBoundAttachmentRefs(savedImages);
  const recordedUserText = typeof options.recordedUserText === 'string' && options.recordedUserText.trim()
    ? options.recordedUserText.trim()
    : normalizedText;
  const sourceContext = normalizeSourceContext(options.sourceContext);
  const imageRefs = buildMessageAttachmentRefs(sourceAttachmentRefs);
  const isFirstRecordedUserMessage = options.recordUserMessage !== false
    && (snapshot.userMessageCount || 0) === 0;
  const requestedPlanAction = normalizePlanAction(options.planAction);
  const requestedPlanId = normalizePlanId(options.planId);
  const preparationOptions = buildPreparationOptions({
    ...options,
    preSavedAttachments: undefined,
    requestId: undefined,
    responseId,
    recordedUserText,
    sourceContext,
  });
  const run = await createPreparingHttpRun({
    sessionId,
    requestId,
    responseId,
    primaryResponseId: responseId,
    session: sessionMeta,
    normalizedText,
    recordedUserText,
    sourceContext,
    imageRefs,
    options: { ...options, preSavedAttachments: savedImages },
    preparationOptions: {
      ...preparationOptions,
      recordedUserText,
      sourceContext,
    },
    snapshot,
    isFirstRecordedUserMessage,
    requestedPlanAction,
    requestedPlanId,
    planArtifactForAction: null,
  });
  return run;
}

/** Read-only acceptance lookup. Absence of retained evidence never proves a POST failed. */
export async function getMessageSubmissionReceipt(sessionId, requestId) {
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) {
    const error = new Error('A requestId of at most 200 characters is required');
    error.statusCode = 400;
    throw error;
  }
  const normalizedId = requestId.trim();
  const meta = await findSessionMeta(sessionId);
  if (!meta) {
    const error = new Error('Session not found');
    error.statusCode = 404;
    throw error;
  }
  const run = await findRunByRequest(sessionId, normalizedId);
  const queued = Boolean(findQueuedFollowUpByRequest(meta, normalizedId));
  const accepted = Boolean(run || queued || findPendingDispatchByRequest(meta, normalizedId)
    || hasRecentFollowUpRequestId(meta, normalizedId));
  return {
    receiptContractVersion: 1,
    sessionId,
    requestId: normalizedId,
    state: accepted ? 'accepted' : 'unconfirmed',
    // Lookup is neither a new submission nor a replay. Do not invent duplicate=true.
    queued: run ? false : queued,
    runId: run?.id || null,
  };
}

async function submitHttpMessageInternal(sessionId, text, images, options = {}) {
  if (deletingSessionIds.has(trimString(sessionId))) {
    throw createSessionDeleteError('Session deletion is in progress', 'SESSION_DELETE_IN_PROGRESS');
  }
  const requestId = typeof options.requestId === 'string' ? options.requestId.trim() : '';
  if (!requestId) {
    throw new Error('requestId is required');
  }
  const responseId = resolveResponseId(requestId, options);
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new Error('text is required');
  }

  setApiRequestCorrelation({ requestId, sessionId });
  let session = await measureApiRequestPhase(
    'send.initial_session_projection',
    () => getSession(sessionId),
  );
  let sessionMeta = await measureApiRequestPhase('send.initial_session_meta', () => findSessionMeta(sessionId));
  if (!session) throw new Error('Session not found');
  if (sessionMeta?.creationRequest?.state === 'initializing') {
    throw sessionCreationError('SESSION_INITIALIZING', 'Retry Session creation to finish initialization before sending a message', 409);
  }
  // S10 Managed Input enforcement: direct message submission to a managed
  // session is a bypass unless it arrives through the controlled channel
  // (collaboration orchestrator internalOperation marker). No-op when
  // MANAGED_INPUT_ENFORCEMENT is off.
  assertManagedInputAllowed({
    session,
    operation: 'message',
    requestContext: { internalOperation: options?.internalOperation },
  });
  // DS-07: a message submit is the strongest activity signal — keep the
  // session's runtime state alive past the idle TTL.
  touchSessionRuntimeState(sessionId);

  // Persist the client's UI language on the session so subsequent assistant
  // replies (per-message system prompts, etc.) localize for this session.
  if (!currentMessageExecution() && typeof options.uiLanguage === 'string' && options.uiLanguage.trim()) {
    const normalizedLanguage = normalizeUiLanguagePreference(options.uiLanguage);
    if (sessionMeta?.uiLanguage !== normalizedLanguage) {
      sessionMeta = await measureApiRequestPhase(
        'send.ui_language_persist',
        () => touchSessionMeta(sessionId, { uiLanguage: normalizedLanguage }),
      );
      session = await measureApiRequestPhase(
        'send.ui_language_projection',
        () => getSession(sessionId),
      ) || session;
    }
  }

  const existingRun = await measureApiRequestPhase(
    'send.idempotency_run_lookup',
    () => findRunByRequest(sessionId, requestId),
  );
  const preparationRunId = trimString(options.preparationRunId);
  const preparationInputMetadata = options.preparationInputMetadata
    && typeof options.preparationInputMetadata === 'object'
    ? options.preparationInputMetadata
    : null;
  const userMessageAlreadyRecorded = options.userMessageAlreadyRecorded === true;
  if (existingRun && !preparationRunId) {
    return {
      requestId,
      duplicate: true,
      queued: false,
      run: await getRun(existingRun.id) || existingRun,
      session: await getSession(sessionId),
      response: await getSessionReplyPublication(sessionId, responseId),
    };
  }

  await assertRunStartsAllowed();
  const hasRequestedInteractionMode = Object.prototype.hasOwnProperty.call(options, 'interactionMode');
  const requestedInteractionMode = hasRequestedInteractionMode && typeof options.interactionMode === 'string'
    ? options.interactionMode.trim().toLowerCase()
    : '';
  if (hasRequestedInteractionMode && requestedInteractionMode && !['agent', 'plan'].includes(requestedInteractionMode)) {
    throw new Error('interactionMode must be "agent" or "plan"');
  }
  const requestedPlanAction = normalizePlanAction(options.planAction);
  const requestedPlanId = normalizePlanId(options.planId);
  const planActionInteractionMode = resolvePlanActionInteractionMode(requestedPlanAction);
  const effectiveInteractionMode = planActionInteractionMode
    || requestedInteractionMode
    || (typeof session.interactionMode === 'string' && ['agent', 'plan'].includes(session.interactionMode)
      ? session.interactionMode
      : 'agent');

  const existingQueuedFollowUp = findQueuedFollowUpByRequest(sessionMeta, requestId);
  if (existingQueuedFollowUp || hasRecentFollowUpRequestId(sessionMeta, requestId)) {
    return {
      requestId,
      duplicate: true,
      queued: !!existingQueuedFollowUp,
      run: null,
      session: await getSession(sessionId, {
        includeQueuedMessages: !!existingQueuedFollowUp,
      }),
      response: buildReplyPublicationSummary({
        id: responseId,
        responseIds: [responseId],
        state: existingQueuedFollowUp ? 'queued' : 'ready',
      }),
    };
  }

  const normalizedText = text.trim();
  let planArtifactForAction = null;
  let runPromptText = normalizedText;
  if (requestedPlanAction && requestedPlanId) {
    planArtifactForAction = await findLatestPlanArtifact(sessionId, requestedPlanId);
    if (!planArtifactForAction) {
      const error = new Error('Plan artifact not found');
      error.code = 'PLAN_NOT_FOUND';
      throw error;
    }
    runPromptText = buildPlanActionPrompt({
      action: requestedPlanAction,
      artifact: planArtifactForAction,
      userText: normalizedText,
    });
  }
  const existingPendingDispatch = options.skipPendingDispatchLookup === true
    ? null
    : findPendingDispatchByRequest(sessionMeta, requestId);
  if (existingPendingDispatch) {
    return {
      requestId,
      duplicate: true,
      queued: false,
      run: null,
      session: await getSession(sessionId),
      response: buildReplyPublicationSummary({
        id: responseId,
        responseIds: [responseId],
        state: 'checking',
      }),
    };
  }

  let activeRun = null;
  let hasActiveRun = false;
  sessionMeta = (await reconcileSessionActiveRuns(sessionMeta)).meta;
  const hasPendingCompact = sessionRuntimeStateById.get(sessionId)?.pendingCompact === true;
  const activeRunId = typeof sessionMeta?.activeRunId === 'string' ? sessionMeta.activeRunId : null;
  const isPreparingRunContinuation = Boolean(preparationRunId && activeRunId === preparationRunId);

  if (activeRunId && !isPreparingRunContinuation) {
    await measureApiRequestPhase('send.active_run_sync', async () => {
      activeRun = await flushDetachedRunIfNeeded(sessionId, activeRunId) || await getRun(activeRunId);
      if (activeRun && !isTerminalRunState(activeRun.state)) {
        hasActiveRun = true;
      }
      const refreshedSession = await getSession(sessionId);
      if (refreshedSession) {
        session = refreshedSession;
        sessionMeta = await findSessionMeta(sessionId) || sessionMeta;
      }
    }, { activeRunId });
    setApiRequestCorrelation({ runId: activeRunId });
  }

  const sessionBusy = hasActiveRun || hasPendingCompact || getFollowUpQueueCount(sessionMeta) > 0;
  if (sessionBusy && options.deferIfBusy === true) {
    // Internal control-plane work must never be smuggled through the owner
    // follow-up queue.  Its durable owner (for example collaboration
    // aggregation) keeps the command pending and retries when this Session is
    // idle.  This branch deliberately performs no history, attachment, queue
    // or provider mutation.
    return {
      requestId,
      duplicate: false,
      deferred: true,
      queued: false,
      run: null,
      session: await measureApiRequestPhase('send.deferred_response_projection', () => getSession(sessionId)) || session,
      response: buildReplyPublicationSummary({
        id: responseId,
        responseIds: [responseId],
        state: 'waiting',
      }),
    };
  }

  if (sessionBusy && options.queueIfBusy !== false) {
    const queuedImages = options.preSavedAttachments?.length > 0
      ? sanitizeQueuedFollowUpAttachments(options.preSavedAttachments)
      : sanitizeQueuedFollowUpAttachments(await saveAttachments(images));
    const queuedOptions = sanitizeQueuedFollowUpOptions(options);
    const queuedEntry = {
      requestId,
      responseId,
      text: normalizedText,
      queuedAt: nowIso(),
      images: queuedImages,
      ...queuedOptions,
    };
    const queuedMeta = await mutateSessionMeta(sessionId, (draft) => {
      const queue = getFollowUpQueue(draft);
      if (queue.some((entry) => entry.requestId === requestId)) {
        return false;
      }
      draft.followUpQueue = [...queue, queuedEntry];
      draft.updatedAt = nowIso();
      return true;
    });
    const wasDuplicateQueueInsert = queuedMeta.changed === false;
    if (!hasActiveRun && !hasPendingCompact) {
      scheduleQueuedFollowUpDispatch(sessionId);
    }
    broadcastSessionInvalidation(sessionId);
    return {
      requestId,
      duplicate: wasDuplicateQueueInsert,
      queued: true,
      run: null,
      session: await measureApiRequestPhase(
        'send.queued_response_projection',
        () => getSession(sessionId, { includeQueuedMessages: true }),
      ) || (queuedMeta.meta ? await enrichSessionMetaForClient(queuedMeta.meta, {
        includeQueuedMessages: true,
      }) : session),
      response: buildReplyPublicationSummary({
        id: responseId,
        responseIds: [responseId],
        state: wasDuplicateQueueInsert ? 'queued' : 'queued',
      }),
    };
  }

  if (shouldRunDispatch(session, options) && shouldUseAsyncDispatchPlanning(session, normalizedText)) {
    const queuedImages = options.preSavedAttachments?.length > 0
      ? sanitizeQueuedFollowUpAttachments(options.preSavedAttachments)
      : await saveAttachments(images);
    const queuedEntry = {
      requestId,
      responseId,
      text: normalizedText,
      queuedAt: nowIso(),
      images: queuedImages,
      ...sanitizePendingDispatchOptions(options),
    };
    const queuedDispatchMeta = await mutateSessionMeta(sessionId, (draft) => {
      const queue = getPendingPlanningQueue(draft);
      if (queue.some((entry) => trimString(entry?.requestId) === requestId)) {
        return false;
      }
      draft.pendingPlanningQueue = [...queue, queuedEntry];
      draft.updatedAt = nowIso();
      return true;
    });
    const wasDuplicateQueueInsert = queuedDispatchMeta.changed === false;
    schedulePendingDispatchFlush(sessionId, 0);
    broadcastSessionInvalidation(sessionId);
    return {
      requestId,
      duplicate: wasDuplicateQueueInsert,
      queued: false,
      run: null,
      planning: true,
      session: await measureApiRequestPhase(
        'send.planning_response_projection',
        () => getSession(sessionId),
      ) || (queuedDispatchMeta.meta ? await enrichSessionMetaForClient(queuedDispatchMeta.meta) : session),
      response: buildReplyPublicationSummary({
        id: responseId,
        responseIds: [responseId],
        state: 'checking',
      }),
    };
  }

  const snapshot = options.preparationSnapshot
    || await measureApiRequestPhase(
      'send.history_snapshot',
      () => getHistorySnapshot(sessionId, { priority: 'interactive' }),
    );
  const previousTool = trimString(session.tool);
  const requestedTool = trimString(options.tool);
  const sessionRiskMode = resolveSessionRiskMode(session);
  const runtimeBinding = await resolveSessionRuntimeTool(session, {
    requestedTool,
    riskMode: sessionRiskMode,
  });
  const effectiveTool = runtimeBinding.tool || requestedTool || previousTool;
  const recordedUserText = typeof options.recordedUserText === 'string' && options.recordedUserText.trim()
    ? options.recordedUserText.trim()
    : normalizedText;
  const savedImages = await measureApiRequestPhase(
    'send.attachments',
    async () => options.preSavedAttachments?.length > 0
      ? sanitizeQueuedFollowUpAttachments(options.preSavedAttachments)
      : saveAttachments(images),
  );
  const sourceContext = normalizeSourceContext(options.sourceContext);
  const sourceAttachmentRefs = toAssetBoundAttachmentRefs(savedImages);
  const imageRefs = buildMessageAttachmentRefs(sourceAttachmentRefs);
  const isFirstRecordedUserMessage =
    options.recordUserMessage !== false
    && (snapshot.userMessageCount || 0) === 0;

  if (!options.internalOperation) {
    clearRenameState(sessionId);
  }
  const touchedSession = await measureApiRequestPhase(
    'send.session_touch',
    () => touchSessionMeta(sessionId),
  );
  if (touchedSession) {
    session = await measureApiRequestPhase(
      'send.session_touch_projection',
      async () => applyMessageExecutionConfiguration(await enrichSessionMeta(touchedSession)),
    );
  }

  if (!currentMessageExecution() && effectiveTool !== session.tool) {
    const updatedToolSession = await updateSessionTool(sessionId, effectiveTool);
    if (updatedToolSession) {
      session = updatedToolSession;
    }
  }
  const effectiveToolDefinition = runtimeBinding.definition
    || await getToolDefinitionAsync(effectiveTool);
  const effectiveRuntimeFamily = (typeof effectiveToolDefinition?.runtimeFamily === 'string' && effectiveToolDefinition.runtimeFamily.trim())
    || (effectiveTool === 'claude'
      ? 'claude-stream-json'
      : effectiveTool === 'codex'
        ? 'codex-app-server-json'
        : effectiveTool === 'codex-cli'
          ? 'codex-json'
          : null);
  const effectiveProviderContract = buildProviderContractFields(effectiveRuntimeFamily);
  const requestedModelProvider = (effectiveTool === 'agy')
    ? parseScopedCodexModel(trimString(options.model || session.model)).providerId
    : '';
  const sessionAgyBinding = effectiveTool === 'agy' ? trimString(session.agyProviderProfileId) : '';
  // Run override > Session default > the last successful AgY account binding.
  // The native preparation layer supplies rotation only when none of these is
  // present, so an existing AgY conversation can never accidentally resume on
  // another account.
  let effectiveProviderProfile = trimString(options.providerProfile)
    || trimString(session.providerProfile)
    || sessionAgyBinding
    || requestedModelProvider;
  // Resolve implicit AgY rotation while the Run is admitted, not later in the
  // detached runner. This freezes the account before a queued Run waits for
  // the account lock and prevents rotation from changing its target.
  if (effectiveTool === 'agy' && !effectiveProviderProfile) {
    effectiveProviderProfile = await resolveDefaultProviderProfileId('agy', {
      configDir: CONFIG_DIR,
      registry: createNativeProviderRegistry({ configDir: CONFIG_DIR }),
      readFileImpl: readFile,
      rotationStore: createAgyRotationStore({ configDir: CONFIG_DIR }),
    });
  }
  const requestedPermissionMode = normalizeProviderPermissionMode(effectiveRuntimeFamily, options.permissionMode);
  // Gated modes (design §13–§14 Path G + 统一风险门控计划 phase 3): a per-session
  // risk mode forces a provider permission channel so AgentoC can auto-allow
  // routine work and hold danger operations for owner approval. The runtime
  // binding above upgrades the built-in Claude compatibility fallback to Bidi;
  // runtimes without an AgentoC approval channel fail closed below because they
  // cannot accept an approval response.
  const permissionContract = resolveSessionProviderPermissionContract({
    sessionId,
    tool: effectiveTool,
    runtimeFamily: effectiveRuntimeFamily,
    providerContract: effectiveProviderContract,
    session,
    requestedPermissionMode,
    interactionMode: effectiveInteractionMode,
  });
  const {
    sessionPrivilegedMode,
    riskGated,
    effectivePermissionPolicy,
    effectivePermissionMode,
  } = permissionContract;
  const managedActionMcpEligible = isPrivilegeRoutingEnabled(session)
    && effectiveProviderContract.providerCapabilities?.supportsManagedActionMcp === true
    && getGatedPermissionModeId(effectiveRuntimeFamily);
  const authenticatedPrincipalKind = trimString(options.authenticatedPrincipalKind);
  const windowsOwnerDevice = process.platform === 'win32' && Boolean(managedActionMcpEligible) && authenticatedPrincipalKind === 'trusted_device' &&
    canIssueSessionControl({ principalKind: authenticatedPrincipalKind, session,
      temporaryControlAuthority: options.temporaryControlAuthority, internalOperation: options.internalOperation })
    ? await captureWindowsOwnerDevice(options.authenticatedOwnerDevice).catch(() => null) : null;
  const windowsOwnerAuthorized = authenticatedPrincipalKind === 'owner' || Boolean(windowsOwnerDevice);
  const productAgentCreateEligible = managedActionMcpEligible
    && isAgentCreateApprovedActionEnabled()
    && isAgentCreateSessionEligible(session)
    && authenticatedPrincipalKind === 'owner';
  const approvedActionChannelToken = managedActionMcpEligible
    ? randomBytes(32).toString('base64url')
    : '';
  const windowsUserInstallIdentity = process.platform === 'win32' && approvedActionChannelToken
    && windowsOwnerAuthorized && ['recommended', 'full-auto'].includes(sessionRiskMode)
    ? await loadWindowsAutoInstallPublicIdentity().catch(() => null)
    : null;
  const approvedActionChannel = approvedActionChannelToken
    ? {
        endpoint: `http://127.0.0.1:${CHAT_PORT}/api/internal/approved-actions/propose`,
        token: approvedActionChannelToken,
        tokenHash: createHash('sha256').update(approvedActionChannelToken, 'utf8').digest('hex'),
        turnId: trimString(requestId),
        ...(authenticatedPrincipalKind ? { authenticatedPrincipalKind } : {}),
        ...(windowsOwnerDevice ? { windowsOwnerDevice } : {}),
        ...(windowsUserInstallIdentity ? { windowsUserInstallIdentity } : {}),
        ...(productAgentCreateEligible ? { productAgentCreate: true } : {}),
      }
    : null;
  // The first Windows Broker operation gets a separate Run-scoped capability.
  // The Run never receives the privileged pipe or a general command executor.
  const windowsBrokerEligible = process.platform === 'win32'
    && isPrivilegeRoutingEnabled(session)
    && windowsOwnerAuthorized
    && !options.temporaryControlAuthority
    && ['full-auto', 'recommended', 'safe'].includes(sessionRiskMode)
    && ['codex-app-server-json', 'claude-stream-json-bidi'].includes(effectiveRuntimeFamily)
    && effectiveProviderContract.providerCapabilities?.supportsManagedActionMcp === true
    && Boolean(getGatedPermissionModeId(effectiveRuntimeFamily));
  const windowsBrokerToken = windowsBrokerEligible ? randomBytes(32).toString('base64url') : '';
  const windowsBrokerChannel = windowsBrokerToken ? {
    endpoint: `http://127.0.0.1:${CHAT_PORT}/api/internal/windows-broker/service-restart`,
    token: windowsBrokerToken,
    tokenHash: createHash('sha256').update(windowsBrokerToken, 'utf8').digest('hex'),
    turnId: trimString(requestId),
    ...(windowsOwnerDevice ? { windowsOwnerDevice } : {}),
  } : null;
  const nextRunId = preparationRunId || createRunId();
  const attachmentInputStage = await stageRunAttachmentInputs({
    sessionId,
    runId: nextRunId,
    turnId: requestId,
    attachments: sourceAttachmentRefs,
  });
  const sessionControlCapability = canIssueSessionControl({
    principalKind: authenticatedPrincipalKind,
    session,
    temporaryControlAuthority: options.temporaryControlAuthority,
    internalOperation: options.internalOperation,
  })
    ? createRunSessionControlCapability({
      runId: nextRunId,
      sessionId,
      turnId: requestId,
    })
    : null;
  const sessionControlRenewal = sessionControlCapability
    ? createRunSessionControlRenewalCapability({
      runId: nextRunId,
      sessionId,
      turnId: requestId,
      runCreatedAt: Date.now(),
    })
    : null;
  const sessionControlChannel = sessionControlCapability
    ? {
      ...sessionControlCapability,
      ...(sessionControlRenewal ? {
        renewalVersion: sessionControlRenewal.version,
        renewalEndpoint: sessionControlRenewal.endpoint,
        renewalToken: sessionControlRenewal.token,
        renewalTokenHash: sessionControlRenewal.tokenHash,
        renewalExpiresAt: sessionControlRenewal.expiresAt,
      } : {}),
    }
    : null;
  const shouldResumeCodexForPlanAction = requestedPlanAction
    && ['codex-json', 'codex-app-server-json'].includes(effectiveRuntimeFamily);
  const forceFreshProviderThread = options.freshThread === true;
  // Native thread continuity for codex *app-server* normal replies: continue the
  // same provider thread across runs so codex manages its own context (instead of
  // AgentoC re-injecting a text handoff every turn — the source of "old context
  // shown as recent"). The app-server path uses json-rpc `thread/resume`, which is
  // already relied on by the plan→execute flow and is NOT the CLI `exec resume`
  // path that has the documented 0-command no-op bug — so the codex-json/codex-cli
  // (CLI exec) families stay on text-handoff. Kill-switch: set
  // AGENTOC_CODEX_NATIVE_RESUME=0|false|no|off to disable.
  const codexAppServerNativeResume = effectiveRuntimeFamily === 'codex-app-server-json'
    && !/^(0|false|no|off)$/i.test(String(process.env.AGENTOC_CODEX_NATIVE_RESUME ?? 'on').trim());
  const effectiveCodexResume = !forceFreshProviderThread && (
    options.codexResume === true
    || shouldResumeCodexForPlanAction
    || codexAppServerNativeResume
  );
  const effectiveServiceTier = effectiveTool === 'codex' || effectiveTool === 'codex-cli'
    ? normalizeCodexServiceTier(options.serviceTier || session.serviceTier)
    : 'standard';
  // Resolve a one-run Agent/template overlay before computing the binding
  // fingerprint. Its instructions are part of the semantic context and must
  // invalidate native resume when they change.
  const requestedRunTemplateId = normalizeAppId(options.templateId || options.agentId);
  let promptEnvelopeSession = session;
  if (requestedRunTemplateId && requestedRunTemplateId !== normalizeAppId(session.templateId)) {
    const runTemplateApp = await getApp(requestedRunTemplateId).catch(() => null);
    if (runTemplateApp) {
      promptEnvelopeSession = {
        ...session,
        templateId: normalizeAppId(runTemplateApp.id),
        templateName: typeof runTemplateApp.name === 'string' ? runTemplateApp.name.trim() : '',
        systemPrompt: typeof runTemplateApp.systemPrompt === 'string' ? runTemplateApp.systemPrompt : '',
      };
    }
  }
  const targetBindingManifest = {
    provider: effectiveProviderContract.provider || '',
    runtimeFamily: effectiveProviderContract.runtimeFamily || effectiveRuntimeFamily || '',
    providerProfile: effectiveProviderProfile || '',
    providerCapabilities: effectiveProviderContract.providerCapabilities || null,
    options: {
      model: options.model || session.model || session.codexThreadModel || '',
      effort: options.effort || session.effort || session.codexThreadEffort || '',
      serviceTier: options.serviceTier || session.serviceTier || session.codexThreadServiceTier || effectiveServiceTier,
      providerProfile: effectiveProviderProfile || '',
      browserMcpEnabled: options.browserMcpEnabled === true,
    },
  };
  // Model-catalog consistency gate: when the resolved provider exposes a
  // catalog, the requested model must exist in it BEFORE spawn. The run fails
  // with model-not-available instead of silently switching model/provider.
  const requestedScopedModel = trimString(targetBindingManifest.options.model);
  let resolvedModelCatalog = null;
  if (requestedScopedModel) {
    const catalogCheck = await validateRunModelAgainstCatalog({
      tool: effectiveTool,
      model: requestedScopedModel,
      providerProfileId: effectiveProviderProfile
        || parseScopedCodexModel(requestedScopedModel).providerId,
    });
    if (!catalogCheck.ok) {
      const error = new Error(catalogCheck.message || 'Requested model is not available for the selected provider.');
      error.code = catalogCheck.code || 'model-not-available';
      error.statusCode = 400;
      throw error;
    }
    resolvedModelCatalog = catalogCheck.catalog || null;
  }
  const claudeProviderProfile = effectiveProviderProfile
    || parseScopedCodexModel(requestedScopedModel).providerId;
  // Claude Code has its own hidden model invocations (notably automatic
  // session-title generation). Freeze all of those aliases now, before the
  // Run is persisted, rather than letting the runner consult a mutable global
  // modelPolicy after the user-visible work already completed.
  if (isClaudeRunSelection(effectiveTool, effectiveRuntimeFamily) && claudeProviderProfile && !resolvedModelCatalog) {
    resolvedModelCatalog = await getToolModelCatalog(effectiveTool, claudeProviderProfile).catch(() => null);
  }
  const claudeContractResult = await buildRunClaudeModelContract({
    tool: effectiveTool,
    runtimeFamily: effectiveRuntimeFamily,
    model: requestedScopedModel,
    providerProfileId: claudeProviderProfile,
    catalog: resolvedModelCatalog,
    priorContract: session.claudeModelContract || null,
  });
  if (!claudeContractResult.ok) {
    const error = new Error(claudeContractResult.message || 'Claude model mapping is invalid for the selected provider.');
    error.code = claudeContractResult.code || 'claude-model-contract-invalid';
    error.statusCode = 400;
    throw error;
  }
  const claudeModelContract = claudeContractResult.contract;
  const runtimeOptions = {
    ...options,
    interactionMode: effectiveInteractionMode,
    runtimeFamily: effectiveRuntimeFamily,
    providerProfile: effectiveProviderProfile || undefined,
    serviceTier: effectiveServiceTier,
    ...(effectivePermissionMode ? { permissionMode: effectivePermissionMode } : {}),
    riskMode: sessionRiskMode,
    ...(session?.folder ? { projectRoot: session.folder } : {}),
    ...(requestedPlanAction ? { planAction: requestedPlanAction } : {}),
    ...(requestedPlanId ? { planId: requestedPlanId } : {}),
    ...(effectiveCodexResume ? { codexResume: true } : {}),
    ...(claudeModelContract ? { claudeModelContract } : {}),
    runtimeFingerprint: buildProviderRuntimeFingerprint({
      manifest: targetBindingManifest,
      folder: session.folder || '',
    }),
    instructionRevision: buildTargetInstructionRevision({
      session: promptEnvelopeSession,
      runtimeFamily: effectiveRuntimeFamily,
    }),
  };

  const resumeState = resolveResumeState(effectiveTool, session, runtimeOptions);
  const effectiveAgyResume = resumeState.providerKey === 'agy' && resumeState.hasResume;
  if (effectiveAgyResume) runtimeOptions.agyResume = true;
  if (resumeState.hasResume && ['copilot', 'hermes', 'cline', 'kilo'].includes(resumeState.providerKey)) {
    runtimeOptions.providerResumeId = resumeState.providerResumeId;
  } else {
    delete runtimeOptions.providerResumeId;
    delete runtimeOptions.hermesSessionId;
  }
  const {
    claudeSessionId: persistedClaudeSessionId,
    codexThreadId: persistedCodexThreadId,
    agyConversationId: persistedAgyConversationId,
  } = resumeState;
  // codex goal mode: carry the user's goal intent into the run manifest so the
  // sidecar can apply it (threadGoal/clear + threadGoal/set) at turn start.
  const codexGoalIntent = effectiveRuntimeFamily === 'codex-app-server-json'
    ? buildCodexGoalIntent(session?.goal)
    : null;
  const publicationResponseIds = normalizeReplyPublicationResponseIds(
    options.replyPublicationResponseIds,
    responseId,
  );
  const primaryResponseId = publicationResponseIds[0] || responseId;
  const replyPublicationRootRunId = trimString(options.replyPublicationRootRunId);
  let promptEnvelope;
  if (options.backgroundPreparation === true) {
    const promptStartedHr = process.hrtime.bigint();
    try {
      promptEnvelope = await buildPromptEnvelope(
        sessionId,
        promptEnvelopeSession,
        runPromptText,
        previousTool,
        effectiveTool,
        snapshot,
        {
          ...runtimeOptions,
          provider: effectiveProviderContract.provider || null,
          providerCapabilities: effectiveProviderContract.providerCapabilities || null,
          productAgentCreateEligible,
        },
      );
    } finally {
      recordApiRequestPhase('send.prompt_build', Number(process.hrtime.bigint() - promptStartedHr) / 1e6, {
        requestId,
        sessionId,
        runId: nextRunId,
      });
    }
  } else {
    promptEnvelope = await measureApiRequestPhase(
      'send.prompt_build',
      () => buildPromptEnvelope(
        sessionId,
        promptEnvelopeSession,
        runPromptText,
        previousTool,
        effectiveTool,
        snapshot,
        {
          ...runtimeOptions,
          provider: effectiveProviderContract.provider || null,
          providerCapabilities: effectiveProviderContract.providerCapabilities || null,
          productAgentCreateEligible,
        },
      ),
    );
  }

  await assertRunStartsAllowed();

  const status = {
    sessionId,
    requestId,
    responseId: primaryResponseId || null,
    state: 'accepted',
    ...(preparationRunId ? { ackAt: (await getRun(preparationRunId).catch(() => null))?.ackAt || null } : {}),
    promptReadyAt: nowIso(),
    tool: effectiveTool,
    providerProfile: effectiveProviderProfile || null,
    model: options.model || null,
    effort: options.effort || null,
    serviceTier: effectiveServiceTier,
    thinking: options.thinking === true,
    provider: effectiveProviderContract.provider || null,
    runtimeFamily: effectiveProviderContract.runtimeFamily || effectiveRuntimeFamily || null,
    providerCapabilities: effectiveProviderContract.providerCapabilities || null,
    permissionMode: effectivePermissionMode || null,
    claudeSessionId: persistedClaudeSessionId,
    codexThreadId: persistedCodexThreadId,
    agyConversationId: persistedAgyConversationId,
    agyProviderProfileId: effectiveTool === 'agy' ? effectiveProviderProfile || null : null,
    providerResumeId: resumeState.providerResumeId || null,
    providerResumeMode: resumeState.hasResume ? 'native' : 'semantic',
    providerResumeReason: resumeState.reason,
    ...(managedActionMcpEligible ? { approvedActionChannel: { enabled: true } } : {}),
    ...(windowsBrokerChannel ? { windowsBrokerChannel: { enabled: true } } : {}),
    ...(sessionControlChannel ? { sessionControlChannel: { enabled: true } } : {}),
    transientProviderContext: options.transientProviderContext === true,
    internalOperation: options.internalOperation || null,
    replyPublicationRootRunId: replyPublicationRootRunId || null,
    ...(requestedRunTemplateId && promptEnvelopeSession !== session
      ? { agentTemplateId: requestedRunTemplateId }
      : {}),
  };
  // Issue a narrow, server-signed control capability from server-resolved
  // Session/Agent policy. The runner never receives owner credentials or the
  // owner CLI socket. Specialist workers get only read access to their exact
  // collaboration; a manager Agent with canDelegate gets the control surface.
  const { createSessionRunCollaborationCapabilities } = await import('./collaboration-capability.mjs');
  const collaborationCapabilitySet = await createSessionRunCollaborationCapabilities({
    runId: nextRunId,
    sessionId,
    turnId: requestId,
    session,
    internalOperation: options.internalOperation,
    collaborationCapability: options.collaborationCapability,
    getAppImpl: getApp,
    getSessionImpl: getSession,
  });
  const manifest = {
    sessionId,
    requestId,
    responseId: primaryResponseId || null,
    ...(attachmentInputStage.sourceRefs.length > 0
      ? { attachmentRefs: attachmentInputStage.sourceRefs }
      : {}),
    ...(attachmentInputStage.staging ? { attachmentStaging: attachmentInputStage.staging } : {}),
    folder: session.folder,
    tool: effectiveTool,
    ...(requestedRunTemplateId && promptEnvelopeSession !== session
      ? {
          agentTemplateId: requestedRunTemplateId,
          agentTemplateName: typeof promptEnvelopeSession.templateName === 'string'
            ? promptEnvelopeSession.templateName
            : '',
        }
      : {}),
    ...(effectiveProviderContract.provider ? { provider: effectiveProviderContract.provider } : {}),
    ...(effectiveProviderContract.runtimeFamily || effectiveRuntimeFamily
      ? { runtimeFamily: effectiveProviderContract.runtimeFamily || effectiveRuntimeFamily }
      : {}),
    ...(effectiveProviderContract.providerCapabilities
      ? { providerCapabilities: effectiveProviderContract.providerCapabilities }
      : {}),
    instructionRevision: runtimeOptions.instructionRevision,
    providerResumeMode: resumeState.hasResume ? 'native' : 'semantic',
    providerResumeReason: resumeState.reason,
    ...(effectivePermissionMode ? { permissionMode: effectivePermissionMode } : {}),
    prompt: promptEnvelope.prompt,
    contextRenderer: promptEnvelope.metadata || null,
    ...(promptEnvelope.metadata?.rendererVersion ? { contextRendererVersion: promptEnvelope.metadata.rendererVersion } : {}),
    ...(promptEnvelope.metadata?.contextResumeMode ? { contextResumeMode: promptEnvelope.metadata.contextResumeMode } : {}),
    ...(Array.isArray(promptEnvelope.metadata?.includedSections)
      ? { includedContextSections: promptEnvelope.metadata.includedSections }
      : {}),
    ...(promptEnvelope.metadata?.charCounts ? { contextCharCounts: promptEnvelope.metadata.charCounts } : {}),
    ...(promptEnvelope.metadata?.contextBudget ? { contextBudget: promptEnvelope.metadata.contextBudget } : {}),
    ...(promptEnvelope.metadata?.contextReceipt ? { contextReceipt: promptEnvelope.metadata.contextReceipt } : {}),
    ...(promptEnvelope.developerInstructions ? { developerInstructions: promptEnvelope.developerInstructions } : {}),
    ...(promptEnvelope.systemPrefix ? { systemPrefix: promptEnvelope.systemPrefix } : {}),
    ...(promptEnvelope.freshRecoveryPrompt ? { freshRecoveryPrompt: promptEnvelope.freshRecoveryPrompt } : {}),
    ...(promptEnvelope.freshRecoveryDeveloperInstructions ? { freshRecoveryDeveloperInstructions: promptEnvelope.freshRecoveryDeveloperInstructions } : {}),
    ...(promptEnvelope.freshRecoverySystemPrefix ? { freshRecoverySystemPrefix: promptEnvelope.freshRecoverySystemPrefix } : {}),
    ...(options.transientProviderContext === true ? { transientProviderContext: true } : {}),
    internalOperation: options.internalOperation || null,
    ...(replyPublicationRootRunId ? { replyPublicationRootRunId } : {}),
    ...(publicationResponseIds.length > 0 ? { replyPublicationResponseIds: publicationResponseIds } : {}),
    ...(typeof options.compactionTargetSessionId === 'string' && options.compactionTargetSessionId
      ? { compactionTargetSessionId: options.compactionTargetSessionId }
      : {}),
    ...(Number.isInteger(options.compactionSourceSeq)
      ? { compactionSourceSeq: options.compactionSourceSeq }
      : {}),
    ...(typeof options.compactionToolIndex === 'string'
      ? { compactionToolIndex: options.compactionToolIndex }
      : {}),
    ...(typeof options.compactionReason === 'string' && options.compactionReason
      ? { compactionReason: options.compactionReason }
      : {}),
    options: {
      images: attachmentInputStage.stagedAttachments,
      ...(authenticatedPrincipalKind ? { authenticatedPrincipalKind } : {}),
      ...(options.temporaryControlAuthority ? { temporaryControlAuthority: options.temporaryControlAuthority } : {}),
      thinking: options.thinking === true,
      model: options.model || undefined,
      effort: options.effort || undefined,
      serviceTier: effectiveServiceTier,
      providerProfile: effectiveProviderProfile || undefined,
      interactionMode: effectiveInteractionMode,
      permissionMode: effectivePermissionMode || undefined,
      ...(sessionPrivilegedMode ? { privilegedMode: true } : {}),
      riskMode: sessionRiskMode,
      ...(session?.folder ? { projectRoot: session.folder } : {}),
      ...(options.freshThread === true ? { freshThread: true } : {}),
      ...(options.skipSessionContinuation === true ? { skipSessionContinuation: true } : {}),
      ...(options.accessMode === 'read' || options.readOnlyRequired === true ? {
        accessMode: 'read',
        readOnlyRequired: options.readOnlyRequired === true,
        runnerId: trimString(options.runnerId) || undefined,
        runnerUnitScope: trimString(options.runnerUnitScope) || undefined,
      } : {}),
      ...(options.transientProviderContext === true ? { transientProviderContext: true } : {}),
      ...(options.browserMcpEnabled === true ? { browserMcpEnabled: true } : {}),
      ...(requestedPlanAction ? { planAction: requestedPlanAction } : {}),
      ...(requestedPlanId ? { planId: requestedPlanId } : {}),
      ...(effectiveCodexResume ? { codexResume: true } : {}),
      ...(claudeModelContract ? { claudeModelContract } : {}),
      runtimeFamily: effectiveRuntimeFamily || undefined,
      // The runner sidecar runs under a hardened env that never inherits
      // AGENTOC_CONFIG_DIR/HOME, so it cannot re-resolve custom/test tools from
      // the control plane's tools.json.  Carry the resolved command so the
      // sidecar can spawn the provider it was told to run.
      toolCommand: typeof effectiveToolDefinition?.command === 'string' && effectiveToolDefinition.command.trim()
        ? effectiveToolDefinition.command.trim()
        : undefined,
      claudeSessionId: persistedClaudeSessionId || undefined,
      codexThreadId: persistedCodexThreadId || undefined,
      agyConversationId: persistedAgyConversationId || undefined,
      providerResumeId: ['copilot', 'hermes', 'cline', 'kilo'].includes(resumeState.providerKey)
        ? resumeState.providerResumeId || undefined
        : undefined,
      ...(effectiveAgyResume ? { agyResume: true } : {}),
      ...(codexGoalIntent ? { codexGoal: codexGoalIntent } : {}),
      ...(approvedActionChannel ? { approvedActionChannel } : {}),
      ...(windowsBrokerChannel ? { windowsBrokerChannel } : {}),
      ...(sessionControlChannel ? { sessionControlChannel } : {}),
      ...(collaborationCapabilitySet
        ? { collaborationCapabilities: collaborationCapabilitySet.capabilities }
        : {}),
    },
  };
  // S3: allocate the run id up front so the WorkspaceLease can carry it before
  // createRun persists the Run (design 6.4 ordering).
  const admission = await measureApiRequestPhase(
    'send.run_admission',
    () => prepareRunExecution({
      sessionId,
      session,
      manifest,
      options: {
        internalOperation: options.internalOperation || null, runId: nextRunId,
        accessMode: options.accessMode, readOnlyRequired: options.readOnlyRequired === true,
        runnerId: options.runnerId, runnerUnitScope: options.runnerUnitScope,
        executionIsolation: options.executionIsolation,
      },
    }),
  );
  if (preparationRunId && preparationInputMetadata) {
    const preparationRun = await getRun(preparationRunId).catch(() => null) || {
      id: preparationRunId,
      requestId,
      responseId: primaryResponseId || null,
      tool: effectiveTool,
      internalOperation: options.internalOperation || null,
    };
    await finishPreparingRunInputMetadata(sessionId, preparationRun, session, preparationInputMetadata);
  }
  let run;
  const scopedMessageExecution = Boolean(currentMessageExecution());
  const publication = await publishSessionRun(sessionId, preparationRunId || null, async () => {
    if (preparationRunId) {
      const currentPreparation = await getRun(preparationRunId);
      if (isTerminalRunState(currentPreparation?.state) || currentPreparation?.cancelRequested)
        throw Object.assign(new Error('Preparing Run was cancelled before publication'), { code: 'REQUEST_CANCELLED' });
      await updateRunManifest(preparationRunId, () => admission.manifest);
      run = await updateRun(preparationRunId, current => {
        if (isTerminalRunState(current.state) || current.cancelRequested)
          throw Object.assign(new Error('Preparing Run was cancelled before publication'), { code: 'REQUEST_CANCELLED' });
        return {
          ...current,
          ...status,
          id: current.id,
          state: 'accepted',
          ackAt: current.ackAt || status.ackAt || null,
          promptReadyAt: current.promptReadyAt || status.promptReadyAt || nowIso(),
        };
      }) || await getRun(preparationRunId);
    } else {
      run = await measureApiRequestPhase(
        'send.run_create',
        () => createRun({
          status: { ...status, id: nextRunId },
          manifest: admission.manifest,
        }),
      );
    }
    return run;
  }, draft => {
    if (claudeModelContract && !scopedMessageExecution) draft.claudeModelContract = claudeModelContract;
  });
  const activeSession = publication.activeSession;
  setApiRequestCorrelation({ runId: run.id });

  if (!replyPublicationRootRunId) {
    await measureApiRequestPhase(
      'send.run_publication',
      () => updateRunReplyPublication(run.id, () => buildInitialReplyPublication(run, publicationResponseIds)),
    );
  }

  if (activeSession && !preparationRunId) {
    session = await measureApiRequestPhase(
      'send.run_activation_projection',
      () => enrichSessionMeta(activeSession),
    );
  }

  await measureApiRequestPhase('send.history_write', async () => {
    if (options.recordUserMessage !== false && !userMessageAlreadyRecorded) {
      const userEvent = messageEvent('user', recordedUserText, imageRefs.length > 0 ? imageRefs : undefined, {
        requestId,
        responseId: primaryResponseId || undefined,
        runId: run.id,
        ...(sourceContext ? { sourceContext } : {}),
      });
      await appendEvent(sessionId, userEvent);

      const toolDefinition = await getToolDefinitionAsync(effectiveTool);
      const promptMode = toolDefinition?.promptMode === 'bare-user'
        ? 'bare-user'
        : 'default';
      if (promptMode === 'default') {
        const managerTurnContext = await buildManagerTurnContextText(session, normalizedText);
        if (managerTurnContext) {
          await appendEvent(sessionId, managerContextEvent(managerTurnContext, {
            requestId,
            ...(primaryResponseId ? { responseId: primaryResponseId } : {}),
            runId: run.id,
          }));
        }
      }
    }
  });

  if (planArtifactForAction) {
    await appendPlanArtifactStateEvent(sessionId, planArtifactForAction, {
      state: requestedPlanAction === 'execute' ? 'executing' : 'revising',
      run,
      requestId,
      responseId: primaryResponseId || '',
      lastPlanAction: requestedPlanAction,
    });
  }

  if (!options.internalOperation && isSessionAutoRenamePending(session)) {
    const claimed = await claimPendingSessionTitle(sessionId, run.id,
      isFirstRecordedUserMessage ? recordedUserText : '');
    if (claimed) session = claimed;
  }

  // The completion path will parse the foreground assistant's hidden label
  // block after the Run terminalizes; there is no secondary labeling Run.

  const launchRunner = async () => {
    return withoutMessageExecution(() => launchDetachedRunWithAgySlot(sessionId, run, admission.manifest));
  };

  let launchResult = null;
  if (options.skipDispatch === true) {
    // Internal callers and deterministic tests may persist an accepted Run
    // without launching a provider. HTTP ingress never forwards this option.
  } else if (options.deferRunnerLaunch === true) {
    // The Run and user event are already durable. Keep the HTTP acknowledgement
    // independent from broker/provider startup latency, while preserving the
    // same durable failure path if launch cannot be completed.
    const finishDeferredLaunchPhase = beginApiRequestPhase('send.runner_launch', { deferred: true });
    finishDeferredLaunchPhase();
    void launchRunner().then((result) => { launchResult = result; }).catch((error) => {
      console.error(`[runs] Deferred runner launch failed for ${run.id}: ${error?.message || error}`);
    });
  } else {
    launchResult = await measureApiRequestPhase('send.runner_launch', launchRunner, { deferred: false });
  }

  broadcastSessionInvalidation(sessionId);
  const responseProjection = await measureApiRequestPhase(
    'send.response_projection',
    async () => ({
      run: await getRun(run.id) || run,
      session: await getSession(sessionId) || session,
      response: await getSessionReplyPublication(sessionId, responseId),
    }),
  );
  return {
    requestId,
    duplicate: false,
    queued: launchResult?.queued === true,
    run: responseProjection.run,
    session: responseProjection.session,
    response: responseProjection.response,
  };
}

// Public/internal message ingress.  Prompt construction can be expensive
// (history, context rendering, provider preparation), so normal sends first
// create a durable `preparing` Run and continue asynchronously.  Recovery and
// queue paths pass an explicit preparationRunId or disable deferral so they
// can finish the existing Run synchronously and preserve ordering.
export async function submitHttpMessage(sessionId, text, images, options = {}) {
  const requestId = typeof options.requestId === 'string' ? options.requestId.trim() : '';
  return withMessageRequestIdentity(sessionId, requestId, async () => {
    await assertNoMessagePreparationReuse(sessionId, requestId);
    return submitHttpMessageUnlocked(sessionId, text, images, options);
  });
}

async function submitHttpMessageUnlocked(sessionId, text, images, options = {}) {
  // Preserve the established ingress contract (the response contains the
  // concrete provider/runtime Run). Deferred preparation is opt-in for callers
  // that explicitly need a fast acknowledgement; silently changing the
  // default would make existing clients observe a provider-less preparing Run.
  const shouldDefer = options?.deferPromptBuild === true
    && !trimString(options?.preparationRunId)
    && options?.backgroundPreparation !== true;
  return shouldDefer
    ? submitPreparingHttpMessage(sessionId, text, images, options)
    : submitHttpMessageInternal(sessionId, text, images, options);
}

export async function sendMessage(sessionId, text, images, options = {}) {
  return submitHttpMessage(sessionId, text, images, {
    ...options,
    requestId: options.requestId || createInternalRequestId('compat'),
  });
}

// S15 public ingress contract. Legacy callers may continue using
// submitHttpMessage/sendMessage; HTTP and connector user ingress use this
// shared gate so addressability cannot drift between surfaces.
export async function sendUserMessage(sessionId, text, images, options = {}) {
  const {
    forceAddressability = false,
    ...messageOptions
  } = options || {};
  const session = await getSessionMeta(sessionId);
  if (!session) throw new Error('Session not found');
  assertUserAddressable(session, { force: forceAddressability === true });
  return submitHttpMessage(sessionId, text, images, {
    ...messageOptions,
    requestId: messageOptions.requestId || createInternalRequestId('user'),
  });
}

export {
  assertUserAddressable,
  resolveSessionClass,
} from './managed-input.mjs';

// A1 regenerate (branch + fold): re-runs the same user request as a fresh run
// ("same prompt, new attempt"). The new run clones the source run's prompt
// manifest verbatim — deliberately WITHOUT the source run's provider resume
// ids, so the provider starts a fresh thread and never sees its own previous
// reply as context. No user-message echo is emitted (the user message already
// exists); a durable `run_regenerate` marker lets the client fold the previous
// reply into a version rail. The source run is marked superseded and stays
// fully auditable in its run record.
export async function regenerateSessionReply(sessionId, parentRequestId, options = {}) {
  const requestId = typeof options.requestId === 'string' && options.requestId.trim()
    ? options.requestId.trim()
    : createInternalRequestId('regen');
  return withMessageRequestIdentity(sessionId, requestId, async () => {
    const existing = await existingDerivedRunOutcome(sessionId, requestId);
    if (existing) return existing;
    return regenerateSessionReplyUnlocked(sessionId, parentRequestId, { ...options, requestId });
  });
}

async function regenerateSessionReplyUnlocked(sessionId, parentRequestId, options = {}) {
  const normalizedParentRequestId = typeof parentRequestId === 'string' ? parentRequestId.trim() : '';
  if (!normalizedParentRequestId) {
    throw new Error('regenerate requires a source requestId');
  }
  const requestId = typeof options.requestId === 'string' && options.requestId.trim()
    ? options.requestId.trim()
    : createInternalRequestId('regen');
  const responseId = resolveResponseId(requestId, options);

  let session = await getSession(sessionId);
  if (!session) throw new Error('Session not found');
  const parentRun = await findRunByRequest(sessionId, normalizedParentRequestId);
  if (!parentRun) {
    throw new Error('regenerate source run not found');
  }
  if (!isTerminalRunState(parentRun.state)) {
    throw new Error('regenerate requires a finished run');
  }
  // The run status record and its prompt manifest are stored separately
  // (status.json vs manifest.json) — read the manifest explicitly instead of
  // expecting it on the record, which is always empty.
  const parentManifest = (await getRunManifest(parentRun.id)) || {};
  if (typeof parentManifest.prompt !== 'string' || !parentManifest.prompt.trim()) {
    throw new Error('regenerate source run has no prompt manifest');
  }

  await assertRunStartsAllowed();

  const parentOptions = parentManifest.options && typeof parentManifest.options === 'object'
    ? parentManifest.options
    : {};
  const sessionRiskMode = resolveSessionRiskMode(session);
  const parentTool = trimString(parentRun.tool || parentManifest.tool || session.tool);
  const runtimeBinding = await resolveSessionRuntimeTool(
    { ...session, tool: parentTool },
    {
      requestedTool: parentTool,
      fallbackToTemplate: !parentTool,
      riskMode: sessionRiskMode,
    },
  );
  const effectiveTool = runtimeBinding.tool || parentTool || null;
  const effectiveToolDefinition = runtimeBinding.definition
    || await getToolDefinitionAsync(effectiveTool).catch(() => null);
  const derivedRuntimeFamily = trimString(effectiveToolDefinition?.runtimeFamily)
    || (effectiveTool === 'claude'
      ? 'claude-stream-json'
      : effectiveTool === 'codex'
        ? 'codex-app-server-json'
        : effectiveTool === 'codex-cli'
          ? 'codex-json'
          : '');
  const runtimeFamily = trimString(effectiveToolDefinition?.runtimeFamily)
    || trimString(parentRun.runtimeFamily || parentOptions.runtimeFamily)
    || derivedRuntimeFamily;
  const providerContract = buildProviderContractFields(runtimeFamily, {
    provider: parentRun.provider || parentManifest.provider,
    providerCapabilities: parentRun.providerCapabilities
      || parentManifest.providerCapabilities
      || parentOptions.providerCapabilities,
  });
  const permissionContract = resolveSessionProviderPermissionContract({
    sessionId,
    tool: effectiveTool,
    runtimeFamily,
    providerContract,
    session,
    requestedPermissionMode: normalizeProviderPermissionMode(
      runtimeFamily,
      parentOptions.permissionMode || parentRun.permissionMode,
    ),
    interactionMode: parentOptions.interactionMode || session.interactionMode || 'agent',
  });
  // Fresh provider thread: drop every resume id so the new run is a clean
  // re-execution of the original prompt, not a continuation of the old thread.
  const manifestOptions = {
    ...parentOptions,
    freshThread: true,
  };
  if (options.authenticatedPrincipalKind) {
    manifestOptions.authenticatedPrincipalKind = options.authenticatedPrincipalKind;
    delete manifestOptions.temporaryControlAuthority;
    if (options.temporaryControlAuthority) manifestOptions.temporaryControlAuthority = options.temporaryControlAuthority;
  }
  if (runtimeFamily) manifestOptions.runtimeFamily = runtimeFamily;
  if (trimString(effectiveToolDefinition?.command)) {
    manifestOptions.toolCommand = trimString(effectiveToolDefinition.command);
  }
  if (permissionContract.effectivePermissionMode) {
    manifestOptions.permissionMode = permissionContract.effectivePermissionMode;
  } else {
    delete manifestOptions.permissionMode;
  }
  if (permissionContract.sessionPrivilegedMode) manifestOptions.privilegedMode = true;
  else delete manifestOptions.privilegedMode;
  if (permissionContract.riskGated) manifestOptions.riskMode = sessionRiskMode;
  else delete manifestOptions.riskMode;
  const providerOverride = trimString(options.providerProfile);
  const modelOverride = trimString(options.model);
  if (providerOverride) manifestOptions.providerProfile = providerOverride;
  if (modelOverride) manifestOptions.model = modelOverride;
  if (Number.isInteger(options.providerFailoverAttempt)) {
    manifestOptions.providerFailoverAttempt = options.providerFailoverAttempt;
  }
  if (typeof options.providerFailoverFromProvider === 'string'
      && options.providerFailoverFromProvider.trim()) {
    manifestOptions.providerFailoverFromProvider = options.providerFailoverFromProvider.trim();
  }
  if (typeof options.providerFailoverReason === 'string'
      && options.providerFailoverReason.trim()) {
    manifestOptions.providerFailoverReason = options.providerFailoverReason.trim();
  }
  if (options.providerFailover === true) manifestOptions.providerFailover = true;
  delete manifestOptions.claudeSessionId;
  delete manifestOptions.codexThreadId;
  delete manifestOptions.codexResume;
  delete manifestOptions.providerResumeId;
  delete manifestOptions.hermesSessionId;

  // Repeated regenerations keep folding under the ORIGINAL user message, so the
  // client can group v1/v2/v3 under one version rail. The chain root lives on
  // the manifest (the status record only stores a fixed field set).
  const rootParentRequestId = trimString(parentManifest.regenerateParentRequestId) || normalizedParentRequestId;
  const attachmentSourceRefs = getManifestAttachmentSourceRefs(parentManifest);

  const status = {
    sessionId,
    requestId,
    responseId,
    state: 'accepted',
    tool: effectiveTool,
    providerProfile: providerOverride || parentRun.providerProfile || parentOptions.providerProfile || null,
    model: modelOverride || parentRun.model || parentOptions.model || null,
    effort: parentRun.effort ?? parentOptions.effort ?? null,
    thinking: parentRun.thinking === true || parentOptions.thinking === true,
    provider: providerContract.provider || parentRun.provider || null,
    runtimeFamily: runtimeFamily || null,
    providerCapabilities: providerContract.providerCapabilities || parentRun.providerCapabilities || null,
    permissionMode: permissionContract.effectivePermissionMode || null,
    transientProviderContext: parentRun.transientProviderContext === true,
    internalOperation: 'regenerate',
    regenerate: true,
    regenerateParentRequestId: rootParentRequestId,
    regenerateParentRunId: parentRun.id,
    replyPublicationRootRunId: parentRun.replyPublicationRootRunId || null,
    ...(providerOverride ? { providerFailover: true } : {}),
  };

  const manifest = {
    ...manifestForDerivedRun(parentManifest),
    sessionId,
    requestId,
    responseId,
    tool: effectiveTool,
    ...(providerContract.provider ? { provider: providerContract.provider } : {}),
    ...(runtimeFamily ? { runtimeFamily } : {}),
    ...(providerContract.providerCapabilities
      ? { providerCapabilities: providerContract.providerCapabilities }
      : {}),
    ...(permissionContract.effectivePermissionMode
      ? { permissionMode: permissionContract.effectivePermissionMode }
      : {}),
    regenerate: true,
    regenerateParentRequestId: rootParentRequestId,
    regenerateParentRunId: parentRun.id,
    internalOperation: 'regenerate',
    ...(attachmentSourceRefs.length > 0 ? { attachmentRefs: attachmentSourceRefs } : {}),
    options: { ...manifestOptions, images: attachmentSourceRefs },
  };
  delete manifest.claudeSessionId;
  delete manifest.codexThreadId;
  delete manifest.providerResumeId;

  // Regenerate is a NEW run: prepareRunExecution always builds a fresh
  // ExecutionScopeSnapshot and never copies the parent run's scope/digest.
  const nextRunId = createRunId();
  const attachmentInputStage = await stageRunAttachmentInputs({
    sessionId,
    runId: nextRunId,
    turnId: requestId,
    attachments: attachmentSourceRefs,
  });
  const stagedManifest = {
    ...manifest,
    ...(attachmentInputStage.staging ? { attachmentStaging: attachmentInputStage.staging } : {}),
    options: {
      ...manifest.options,
      images: attachmentInputStage.stagedAttachments,
    },
  };
  const admission = await prepareRunExecution({
    sessionId,
    session,
    manifest: stagedManifest,
    options: {
      internalOperation: 'regenerate', runId: nextRunId,
      ...(parentManifest.executionScope?.accessMode === 'read' ? {
        accessMode: 'read', readOnlyRequired: true, runnerId: parentOptions.runnerId,
        runnerUnitScope: parentOptions.runnerUnitScope,
      } : {}),
    },
  });
  const run = await createRun({ status: { ...status, id: nextRunId }, manifest: admission.manifest });
  await updateRunReplyPublication(run.id, () => buildInitialReplyPublication(run, [responseId]));

  await updateRun(parentRun.id, (current) => ({
    ...current,
    supersededByRequestId: requestId,
    supersededByRunId: run.id,
    supersededAt: nowIso(),
  }));

  const activeSession = (await mutateSessionMeta(sessionId, (draft) => {
    draft.activeRunId = run.id;
    delete draft.lastAuthRecovery;
    draft.updatedAt = nowIso();
    return true;
  })).meta;
  if (activeSession) {
    session = await enrichSessionMeta(activeSession);
  }

  await appendEvent(sessionId, {
    type: 'run_regenerate',
    timestamp: Date.now(),
    requestId,
    responseId,
    runId: run.id,
    parentRequestId: rootParentRequestId,
    parentRunId: parentRun.id,
    state: 'accepted',
    ...(providerOverride ? {
      providerProfile: providerOverride,
      model: modelOverride || null,
      providerFailover: options.providerFailover === true,
    } : {}),
  });

  const launchResult = options.skipDispatch
    ? null
    : await launchDetachedRunWithAgySlot(sessionId, run, admission.manifest);

  broadcastSessionInvalidation(sessionId);
  return {
    requestId,
    duplicate: false,
    queued: launchResult?.queued === true,
    run: await getRun(run.id) || run,
    session: await getSession(sessionId) || session,
    response: await getSessionReplyPublication(sessionId, responseId),
  };
}

/**
 * A1 edit-resend: replace the LAST user message's run in place. Same
 * version-rail semantics as regenerate (fresh provider thread, old run
 * superseded, replies fold under the original user message requestId), but
 * the new run's prompt envelope is built from the EDITED text instead of the
 * original. History stays append-only: the run_regenerate event carries the
 * edited `prompt`, so the client can patch the user bubble while the original
 * message text remains auditable in the event log. Edits keep the source
 * run's runtime contract (tool, model, modes, attachments unless replaced).
 */
export async function resendEditedMessage(sessionId, parentRequestId, options = {}) {
  const requestId = typeof options.requestId === 'string' && options.requestId.trim()
    ? options.requestId.trim()
    : createInternalRequestId('edit');
  return withMessageRequestIdentity(sessionId, requestId, async () => {
    const existing = await existingDerivedRunOutcome(sessionId, requestId);
    if (existing) return existing;
    return resendEditedMessageUnlocked(sessionId, parentRequestId, { ...options, requestId });
  });
}

async function resendEditedMessageUnlocked(sessionId, parentRequestId, options = {}) {
  const normalizedParentRequestId = typeof parentRequestId === 'string' ? parentRequestId.trim() : '';
  if (!normalizedParentRequestId) {
    throw new Error('resend-edited requires a source requestId');
  }
  const editedText = typeof options.prompt === 'string' ? options.prompt.trim() : '';
  if (!editedText) {
    throw new Error('edited prompt is required');
  }
  const requestId = typeof options.requestId === 'string' && options.requestId.trim()
    ? options.requestId.trim()
    : createInternalRequestId('edit');
  const responseId = resolveResponseId(requestId, options);

  let session = await getSession(sessionId);
  if (!session) throw new Error('Session not found');
  const parentRun = await findRunByRequest(sessionId, normalizedParentRequestId);
  if (!parentRun) {
    throw new Error('resend-edited source run not found');
  }
  if (!isTerminalRunState(parentRun.state)) {
    throw new Error('resend-edited requires a finished run');
  }
  // The run status record and its prompt manifest are stored separately
  // (status.json vs manifest.json) — read the manifest explicitly instead of
  // expecting it on the record, which is always empty.
  const parentManifest = (await getRunManifest(parentRun.id)) || {};
  const parentOptions = parentManifest.options && typeof parentManifest.options === 'object'
    ? parentManifest.options
    : {};

  await assertRunStartsAllowed();

  // Edits inherit the source run's runtime contract but always run on a fresh
  // provider thread — the new answer must not continue the old thread it is
  // replacing. The client may override the agent (cross-agent resend, e.g.
  // codex → claude) plus model/effort; overrides are per-run only and never
  // rebind the session's own defaults.
  const requestedTool = typeof options.tool === 'string' && options.tool.trim()
    ? options.tool.trim()
    : '';
  const sessionRiskMode = resolveSessionRiskMode(session);
  const sourceTool = requestedTool || trimString(parentRun.tool || parentManifest.tool || session.tool);
  const runtimeBinding = await resolveSessionRuntimeTool(
    { ...session, tool: sourceTool },
    {
      requestedTool: sourceTool,
      fallbackToTemplate: !sourceTool,
      riskMode: sessionRiskMode,
    },
  );
  const effectiveTool = runtimeBinding.tool || sourceTool || null;
  const effectiveToolDefinition = runtimeBinding.definition
    || await getToolDefinitionAsync(effectiveTool).catch(() => null);
  const derivedRuntimeFamily = trimString(effectiveToolDefinition?.runtimeFamily)
    || (effectiveTool === 'claude'
      ? 'claude-stream-json'
      : effectiveTool === 'codex'
        ? 'codex-app-server-json'
        : effectiveTool === 'codex-cli'
          ? 'codex-json'
          : null);
  const runtimeFamily = trimString(effectiveToolDefinition?.runtimeFamily)
    || (requestedTool
      ? derivedRuntimeFamily
      : (parentRun.runtimeFamily || parentOptions.runtimeFamily || derivedRuntimeFamily));
  const providerContract = buildProviderContractFields(runtimeFamily, {
    provider: parentRun.provider || parentManifest.provider,
    providerCapabilities: parentRun.providerCapabilities
      || parentManifest.providerCapabilities
      || parentOptions.providerCapabilities,
  });
  const permissionContract = resolveSessionProviderPermissionContract({
    sessionId,
    tool: effectiveTool,
    runtimeFamily,
    providerContract,
    session,
    requestedPermissionMode: normalizeProviderPermissionMode(
      runtimeFamily,
      parentOptions.permissionMode || parentRun.permissionMode,
    ),
    interactionMode: parentOptions.interactionMode || session.interactionMode || 'agent',
  });
  const hasRequestedModel = typeof options.model === 'string' && options.model.trim() !== '';
  const effectiveModel = hasRequestedModel
    ? options.model.trim()
    : (parentRun.model || parentOptions.model || null);
  const hasRequestedEffort = typeof options.effort === 'string' && options.effort.trim() !== '';
  const effectiveEffort = hasRequestedEffort
    ? options.effort.trim()
    : (parentRun.effort ?? parentOptions.effort ?? null);
  const hasRequestedThinking = typeof options.thinking === 'boolean';
  const effectiveThinking = hasRequestedThinking
    ? options.thinking
    : (parentRun.thinking === true || parentOptions.thinking === true);
  const effectiveServiceTier = effectiveTool === 'codex' || effectiveTool === 'codex-cli'
    ? normalizeCodexServiceTier(
      typeof options.serviceTier === 'string'
        ? options.serviceTier
        : (parentRun.serviceTier || parentOptions.serviceTier || session.serviceTier),
    )
    : 'standard';
  const runtimeOptions = {
    ...parentOptions,
    freshThread: true,
    interactionMode: parentOptions.interactionMode || 'agent',
    permissionMode: permissionContract.effectivePermissionMode || null,
    serviceTier: effectiveServiceTier,
    ...(effectiveModel ? { model: effectiveModel } : {}),
    ...(effectiveEffort ? { effort: effectiveEffort } : {}),
    ...(typeof effectiveThinking === 'boolean' ? { thinking: effectiveThinking } : {}),
  };
  if (options.authenticatedPrincipalKind) {
    runtimeOptions.authenticatedPrincipalKind = options.authenticatedPrincipalKind;
    delete runtimeOptions.temporaryControlAuthority;
    if (options.temporaryControlAuthority) runtimeOptions.temporaryControlAuthority = options.temporaryControlAuthority;
  }
  if (permissionContract.sessionPrivilegedMode) runtimeOptions.privilegedMode = true;
  else delete runtimeOptions.privilegedMode;
  if (permissionContract.riskGated) runtimeOptions.riskMode = sessionRiskMode;
  else delete runtimeOptions.riskMode;
  if (runtimeFamily) runtimeOptions.runtimeFamily = runtimeFamily;
  if (trimString(effectiveToolDefinition?.command)) {
    runtimeOptions.toolCommand = trimString(effectiveToolDefinition.command);
  }
  delete runtimeOptions.claudeSessionId;
  delete runtimeOptions.codexThreadId;
  delete runtimeOptions.codexResume;
  delete runtimeOptions.providerResumeId;
  delete runtimeOptions.hermesSessionId;

  // Reuse the original message's attachments unless the edit replaces them.
  const savedImages = Array.isArray(options.preSavedAttachments) && options.preSavedAttachments.length > 0
    ? toAssetBoundAttachmentRefs(options.preSavedAttachments)
    : getManifestAttachmentSourceRefs(parentManifest);
  const attachmentSourceRefs = toAssetBoundAttachmentRefs(savedImages);
  const imageRefs = buildMessageAttachmentRefs(attachmentSourceRefs);

  const snapshot = await getHistorySnapshot(sessionId);
  const promptEnvelope = await buildPromptEnvelope(
    sessionId,
    session,
    editedText,
    session.tool,
    effectiveTool,
    snapshot,
    {
      ...runtimeOptions,
      provider: providerContract.provider || parentRun.provider || parentManifest.provider || null,
      providerCapabilities: providerContract.providerCapabilities
        || parentRun.providerCapabilities
        || parentManifest.providerCapabilities
        || null,
    },
  );

  // Repeated edits keep folding under the ORIGINAL user message requestId, so
  // the client groups v1/v2/v3 under one version rail. The chain root lives on
  // the manifest (the status record only stores a fixed field set).
  const rootParentRequestId = trimString(parentManifest.regenerateParentRequestId) || normalizedParentRequestId;

  const status = {
    sessionId,
    requestId,
    responseId,
    state: 'accepted',
    tool: effectiveTool,
    model: effectiveModel,
    effort: effectiveEffort,
    serviceTier: effectiveServiceTier,
    thinking: effectiveThinking,
    provider: providerContract.provider || parentRun.provider || null,
    runtimeFamily: runtimeFamily || parentRun.runtimeFamily || null,
    providerCapabilities: providerContract.providerCapabilities || parentRun.providerCapabilities || null,
    permissionMode: permissionContract.effectivePermissionMode || null,
    internalOperation: 'editResend',
    regenerate: true,
    regenerateParentRequestId: rootParentRequestId,
    regenerateParentRunId: parentRun.id,
    editResend: true,
    editResendParentRequestId: normalizedParentRequestId,
    replyPublicationRootRunId: parentRun.replyPublicationRootRunId || null,
  };

  const manifest = {
    ...manifestForDerivedRun(parentManifest),
    sessionId,
    requestId,
    responseId,
    tool: effectiveTool,
    ...(providerContract.provider ? { provider: providerContract.provider } : {}),
    ...(runtimeFamily ? { runtimeFamily } : {}),
    ...(providerContract.providerCapabilities
      ? { providerCapabilities: providerContract.providerCapabilities }
      : {}),
    ...(permissionContract.effectivePermissionMode
      ? { permissionMode: permissionContract.effectivePermissionMode }
      : {}),
    prompt: promptEnvelope.prompt,
    contextRenderer: promptEnvelope.metadata || null,
    ...(promptEnvelope.metadata?.rendererVersion ? { contextRendererVersion: promptEnvelope.metadata.rendererVersion } : {}),
    ...(promptEnvelope.metadata?.contextResumeMode ? { contextResumeMode: promptEnvelope.metadata.contextResumeMode } : {}),
    ...(Array.isArray(promptEnvelope.metadata?.includedSections)
      ? { includedContextSections: promptEnvelope.metadata.includedSections }
      : {}),
    ...(promptEnvelope.metadata?.charCounts ? { contextCharCounts: promptEnvelope.metadata.charCounts } : {}),
    ...(promptEnvelope.metadata?.contextBudget ? { contextBudget: promptEnvelope.metadata.contextBudget } : {}),
    ...(promptEnvelope.developerInstructions ? { developerInstructions: promptEnvelope.developerInstructions } : {}),
    ...(promptEnvelope.systemPrefix ? { systemPrefix: promptEnvelope.systemPrefix } : {}),
    ...(promptEnvelope.freshRecoveryPrompt ? { freshRecoveryPrompt: promptEnvelope.freshRecoveryPrompt } : {}),
    ...(promptEnvelope.freshRecoveryDeveloperInstructions ? { freshRecoveryDeveloperInstructions: promptEnvelope.freshRecoveryDeveloperInstructions } : {}),
    ...(promptEnvelope.freshRecoverySystemPrefix ? { freshRecoverySystemPrefix: promptEnvelope.freshRecoverySystemPrefix } : {}),
    regenerate: true,
    regenerateParentRequestId: rootParentRequestId,
    regenerateParentRunId: parentRun.id,
    editResend: true,
    editResendParentRequestId: normalizedParentRequestId,
    internalOperation: 'editResend',
    ...(attachmentSourceRefs.length > 0 ? { attachmentRefs: attachmentSourceRefs } : {}),
    options: {
      ...runtimeOptions,
      images: attachmentSourceRefs,
      model: effectiveModel || undefined,
      effort: effectiveEffort ?? undefined,
      serviceTier: effectiveServiceTier,
      runtimeFamily: runtimeFamily || undefined,
    },
  };
  delete manifest.claudeSessionId;
  delete manifest.codexThreadId;
  delete manifest.providerResumeId;

  // Edit-resend is a NEW run: prepareRunExecution always builds a fresh
  // ExecutionScopeSnapshot and never copies the parent run's scope/digest.
  const nextRunId = createRunId();
  const attachmentInputStage = await stageRunAttachmentInputs({
    sessionId,
    runId: nextRunId,
    turnId: requestId,
    attachments: attachmentSourceRefs,
  });
  const stagedManifest = {
    ...manifest,
    ...(attachmentInputStage.staging ? { attachmentStaging: attachmentInputStage.staging } : {}),
    options: {
      ...manifest.options,
      images: attachmentInputStage.stagedAttachments,
    },
  };
  const admission = await prepareRunExecution({
    sessionId,
    session,
    manifest: stagedManifest,
    options: {
      internalOperation: 'editResend', runId: nextRunId,
      ...(parentManifest.executionScope?.accessMode === 'read' ? {
        accessMode: 'read', readOnlyRequired: true, runnerId: parentOptions.runnerId,
        runnerUnitScope: parentOptions.runnerUnitScope,
      } : {}),
    },
  });
  const run = await createRun({ status: { ...status, id: nextRunId }, manifest: admission.manifest });
  await updateRunReplyPublication(run.id, () => buildInitialReplyPublication(run, [responseId]));

  await updateRun(parentRun.id, (current) => ({
    ...current,
    supersededByRequestId: requestId,
    supersededByRunId: run.id,
    supersededAt: nowIso(),
  }));

  const activeSession = (await mutateSessionMeta(sessionId, (draft) => {
    draft.activeRunId = run.id;
    delete draft.lastAuthRecovery;
    draft.updatedAt = nowIso();
    return true;
  })).meta;
  if (activeSession) {
    session = await enrichSessionMeta(activeSession);
  }

  await appendEvent(sessionId, {
    type: 'run_regenerate',
    timestamp: Date.now(),
    requestId,
    responseId,
    runId: run.id,
    parentRequestId: rootParentRequestId,
    parentRunId: parentRun.id,
    state: 'accepted',
    editResend: true,
    prompt: editedText,
    ...(imageRefs.length > 0 ? { images: imageRefs } : {}),
  });

  const launchResult = options.skipDispatch
    ? null
    : await launchDetachedRunWithAgySlot(sessionId, run, admission.manifest);

  broadcastSessionInvalidation(sessionId);
  return {
    requestId,
    duplicate: false,
    queued: launchResult?.queued === true,
    run: await getRun(run.id) || run,
    session: await getSession(sessionId) || session,
    response: await getSessionReplyPublication(sessionId, responseId),
  };
}

function normalizeRuntimeApprovalId(value) {
  const normalized = trimString(value);
  return normalized ? normalized.slice(0, 240) : '';
}

// A parent Run manifest contains publication and input-staging identities
// that are valid only for that exact Run. Keep its reusable prompt/runtime
// configuration, but let prepareRunExecution/createRun establish fresh
// per-Run identities for every derived Run.
function manifestForDerivedRun(parentManifest) {
  const manifest = parentManifest && typeof parentManifest === 'object' && !Array.isArray(parentManifest)
    ? { ...parentManifest }
    : {};
  delete manifest.id;
  delete manifest.runPublication;
  delete manifest.attachmentStaging;
  // This binding is scoped to the original prepared message/request. An
  // explicit edit or regeneration is admitted through its own owner route.
  delete manifest.appApiMessage;
  return manifest;
}

async function existingDerivedRunOutcome(sessionId, requestId) {
  const run = await findRunByRequest(sessionId, requestId);
  if (!run) return null;
  return {
    requestId,
    duplicate: true,
    queued: false,
    run,
    session: await getSession(sessionId),
    response: run.responseId ? await getSessionReplyPublication(sessionId, run.responseId) : null,
  };
}

/**
 * Pure scan over normalized run events: every approval_request whose
 * approvalId has no matching approval_response in the same event list and is
 * not already covered by the caller's cancel set. Used by finalizeDetachedRun
 * so a terminal run always cancels stream-level pending approvals even when
 * the run-state tracking was lost.
 */
export function collectUnansweredApprovalRequests(events, options = {}) {
  const cancelIds = options.cancelIds instanceof Set
    ? options.cancelIds
    : new Set((options.cancelIds || []).map((id) => normalizeRuntimeApprovalId(String(id || ''))).filter(Boolean));
  const respondedIds = new Set();
  for (const event of events) {
    if (!event || typeof event !== 'object' || event.type !== 'approval_response') continue;
    const id = normalizeRuntimeApprovalId(String(event?.approvalId || ''));
    if (id) respondedIds.add(id);
  }
  const results = [];
  for (const event of events) {
    if (!event || typeof event !== 'object' || event.type !== 'approval_request') continue;
    const approvalId = String(event?.approvalId || '').trim();
    if (!approvalId) continue;
    const normalized = normalizeRuntimeApprovalId(approvalId);
    if (!normalized || cancelIds.has(normalized) || respondedIds.has(normalized)) continue;
    results.push(event);
  }
  return results;
}

/**
 * Pure scan over a session history (index events only): every approval_request
 * for the given run whose approvalId has no matching approval_response in the
 * same history and is not already covered by the caller's cancel set. Used by
 * finalizeDetachedRun to cancel auto-allowed approvals that the stream-replay
 * sweep cannot see — the adapter suppresses them on replay, yet live delta
 * ticks may already have persisted them as pending in session history.
 */
export function collectUnansweredApprovalRequestsFromHistory(history, runId, options = {}) {
  const cancelIds = options.cancelIds instanceof Set
    ? options.cancelIds
    : new Set((options.cancelIds || []).map((id) => normalizeRuntimeApprovalId(String(id || ''))).filter(Boolean));
  const respondedIds = new Set();
  for (const event of history) {
    if (!event || typeof event !== 'object' || event.type !== 'approval_response') continue;
    const id = normalizeRuntimeApprovalId(String(event?.approvalId || ''));
    if (id) respondedIds.add(id);
  }
  const results = [];
  for (const event of history) {
    if (!event || typeof event !== 'object' || event.type !== 'approval_request') continue;
    if (runId && String(event?.runId || '') !== runId) continue;
    const normalized = normalizeRuntimeApprovalId(String(event?.approvalId || ''));
    if (!normalized || cancelIds.has(normalized) || respondedIds.has(normalized)) continue;
    results.push(event);
  }
  return results;
}

/**
 * Session-wide stale approval sweep (server-internal, so appended events share
 * the server's seq/meta state — no external-writer race): unresolved provider,
 * privileged-batch, and approved-action requests whose owning run is terminal
 * receive their protocol-specific cancellation response. Runs after every
 * finalization and at boot to backfill historical leaks for all clients.
 */
async function sweepStaleApprovalsInSession(sessionId, options = {}) {
  const cancelIds = options.cancelIds instanceof Set ? options.cancelIds : new Set();
  const skipRunId = trimString(options.skipRunId || '');
  const respondedApprovalIds = new Set();
  const approvalRequests = new Map();
  const privilegedBatchRequests = new Map();
  const resolvedPrivilegedCategories = new Map();
  const approvedActionRequests = new Map();
  const resolvedApprovedActions = new Map();
  const approvedActionStates = new Map();
  const approvalEvents = await readAllRuntimeApprovalEvents(sessionId);
  for (const event of approvalEvents) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'approval_response') {
      const id = normalizeRuntimeApprovalId(String(event?.approvalId || ''));
      if (id) respondedApprovalIds.add(id);
      continue;
    }
    if (event.type === 'approval_request') {
      const approvalId = String(event?.approvalId || '').trim();
      const normalized = normalizeRuntimeApprovalId(approvalId);
      if (!approvalId || !normalized) continue;
      approvalRequests.set(normalized, {
        approvalId,
        runId: trimString(event?.runId || ''),
      });
      continue;
    }
    if (event.type === 'privileged_batch_request') {
      const batchId = trimString(event?.batchId || '');
      if (batchId) privilegedBatchRequests.set(batchId, event);
      continue;
    }
    if (event.type === 'privileged_batch_response') {
      const batchId = trimString(event?.batchId || '');
      const category = trimString(event?.category || '');
      if (!batchId || !category) continue;
      if (!resolvedPrivilegedCategories.has(batchId)) resolvedPrivilegedCategories.set(batchId, new Set());
      resolvedPrivilegedCategories.get(batchId).add(category);
      continue;
    }
    if (event.type === 'approved_action_batch_request') {
      const batchId = trimString(event?.batchId || '');
      if (batchId) approvedActionRequests.set(batchId, event);
      continue;
    }
    if (event.type === 'approved_action_batch_response') {
      const batchId = trimString(event?.batchId || '');
      const decisions = event?.decisions && typeof event.decisions === 'object' ? event.decisions : {};
      if (!batchId) continue;
      if (!resolvedApprovedActions.has(batchId)) resolvedApprovedActions.set(batchId, new Set());
      for (const actionId of Object.keys(decisions)) resolvedApprovedActions.get(batchId).add(actionId);
      continue;
    }
    if (event.type === 'approved_action_state') {
      const actionId = trimString(event?.actionId || '');
      const state = trimString(event?.state || '').toLowerCase();
      if (actionId && state) approvedActionStates.set(actionId, state);
    }
  }
  let cancelled = 0;
  const runCache = new Map();
  const isTerminalApprovalRun = async (runId) => {
    if (!runId || (skipRunId && runId === skipRunId)) return false;
    if (!runCache.has(runId)) {
      try { runCache.set(runId, await getRun(runId) || null); } catch { runCache.set(runId, null); }
    }
    return isTerminalRunState(runCache.get(runId)?.state);
  };
  for (const request of approvalRequests.values()) {
    const approvalId = request.approvalId;
    if (!approvalId) continue;
    const normalized = normalizeRuntimeApprovalId(approvalId);
    if (!normalized || respondedApprovalIds.has(normalized) || cancelIds.has(normalized)) continue;
    const approvalRunId = request.runId;
    if (!await isTerminalApprovalRun(approvalRunId)) continue;
    const responseEvent = approvalResponseEvent({
      approvalId,
      decision: 'cancelled',
      status: 'cancelled',
      source: options.source || 'run-finalize',
      ...(options.requestId ? { requestId: options.requestId } : {}),
    });
    if (responseEvent) {
      await appendEvent(sessionId, { ...responseEvent, runId: approvalRunId || '' });
      if (options.broadcast !== false) broadcastSessionInvalidation(sessionId);
      cancelled += 1;
    }
  }
  for (const [batchId, request] of privilegedBatchRequests) {
    const runId = trimString(request?.runId || '');
    if (!await isTerminalApprovalRun(runId)) continue;
    const resolved = resolvedPrivilegedCategories.get(batchId) || new Set();
    for (const category of ['other', 'delete', 'installAuto']) {
      if (!Array.isArray(request?.[category]) || request[category].length === 0 || resolved.has(category)) continue;
      const responseEvent = privilegedBatchResponseEvent({
        batchId,
        category,
        decisions: {},
        source: options.source || 'run-finalize',
      });
      if (!responseEvent) continue;
      await appendEvent(sessionId, { ...responseEvent, runId });
      if (options.broadcast !== false) broadcastSessionInvalidation(sessionId);
      cancelled += 1;
    }
  }
  for (const [batchId, request] of approvedActionRequests) {
    const runId = trimString(request?.runId || '');
    if (!await isTerminalApprovalRun(runId)) continue;
    const resolved = resolvedApprovedActions.get(batchId) || new Set();
    const decisions = {};
    for (const action of Array.isArray(request?.actions) ? request.actions : []) {
      const actionId = trimString(action?.actionId || '');
      const state = approvedActionStates.get(actionId) || trimString(action?.state || '').toLowerCase();
      if (!actionId || resolved.has(actionId) || ['denied', 'cancelled', 'expired', 'completed', 'failed'].includes(state)) continue;
      decisions[actionId] = 'cancelled';
    }
    if (Object.keys(decisions).length === 0) continue;
    await appendEvent(sessionId, {
      type: 'approved_action_batch_response',
      role: 'system',
      channel: request.channel || 'approved_action',
      schemaVersion: request.schemaVersion,
      batchId,
      sessionId,
      ...(request.turnId ? { turnId: request.turnId } : {}),
      runId,
      decisions,
      source: options.source || 'run-finalize',
    });
    if (options.broadcast !== false) broadcastSessionInvalidation(sessionId);
    cancelled += 1;
  }
  return cancelled;
}

/**
 * One-time boot backfill: sweep every session for stale pending approvals in
 * terminal runs (the historical leaks from before the cross-tick suppression
 * fix) and cancel them in-process. Fire-and-forget after startup; idempotent
 * (already-responded approvals are skipped) and non-blocking.
 */
export async function sweepStaleApprovalsAcrossSessions(options = {}) {
  // This is a storage repair, not a client-list request. Calling listSessions
  // here enriched every session (including timeline/run/connector surfaces)
  // and retained a large amount of transient data during every boot. Work
  // from the compact metadata index and let the per-session sweep read only
  // the event fields it needs.
  const sessions = await loadSessionsMeta();
  const batchSize = Number.isInteger(options.batchSize) && options.batchSize > 0
    ? options.batchSize
    : STARTUP_RECOVERY_BATCH_SIZE;
  let cancelled = 0;
  let swept = 0;
  for (let index = 0; index < sessions.length; index += 1) {
    if (index > 0 && index % batchSize === 0) await yieldToEventLoop();
    const session = sessions[index];
    const sessionId = trimString(session?.id || session || '');
    if (!sessionId) continue;
    swept += 1;
    try {
      cancelled += await sweepStaleApprovalsInSession(sessionId, { source: 'boot-backfill' });
    } catch (err) {
      console.error(`[backfill] stale approval sweep failed for ${sessionId}:`, err?.message || err);
    }
  }
  console.log(`[backfill] stale approval sweep complete: ${cancelled} cancelled across ${swept} sessions`);
  return cancelled;
}

function findRunPendingApproval(run, approvalId) {
  const normalizedApprovalId = normalizeRuntimeApprovalId(approvalId);
  if (!normalizedApprovalId) return null;
  const pending = Array.isArray(run?.appServerPendingApprovals)
    ? run.appServerPendingApprovals
    : [];
  return pending.find((entry) => normalizeRuntimeApprovalId(entry?.approvalId) === normalizedApprovalId) || null;
}

/**
 * Recover a run approval whose tracking was lost (sidecar gate edge cases or
 * crash races). Looks the live pending approval_request up in the session
 * event stream (same run + approvalId, no response yet) and returns a
 * run-record-shaped entry so the click can queue and the sidecar drain can
 * deliver it. Returns null when the stream has no such request — the caller
 * then fails with APPROVAL_NOT_FOUND as before.
 */
async function seedRunApprovalFromSessionStream(run, normalizedApprovalId) {
  const sessionId = trimString(run?.sessionId || '');
  if (!sessionId || !normalizedApprovalId) return null;
  // The request/response pair is indexed by run + approval id. This avoids
  // hydrating every provider body in a large session during a retry or after
  // a control-plane restart.
  const requestEvent = await findRuntimeApprovalRequest(sessionId, run.id, normalizedApprovalId);
  if (!requestEvent) return null;
  const providerRequestId = String(
    requestEvent.providerRequestId || requestEvent.providerRequestIdString || '',
  ).trim();
  return {
    approvalId: String(requestEvent.approvalId).trim(),
    providerRequestId: providerRequestId || null,
    providerRequestIdString: providerRequestId,
    providerMethod: String(requestEvent.providerMethod || '').trim() || null,
    kind: String(requestEvent.kind || '').trim() || null,
    params: requestEvent.params || {},
    request: requestEvent.request || null,
    state: 'pending',
    createdAt: nowIso(),
  };
}

function findRunQueuedApprovalResponse(run, approvalId) {
  const normalizedApprovalId = normalizeRuntimeApprovalId(approvalId);
  if (!normalizedApprovalId) return null;
  const queue = Array.isArray(run?.appServerApprovalResponseQueue)
    ? run.appServerApprovalResponseQueue
    : [];
  return queue.find((entry) => normalizeRuntimeApprovalId(entry?.approvalId) === normalizedApprovalId) || null;
}

// Per-question selected option indices for an AskUserQuestion approval (single-select for now).
// Negative/non-integer entries mean "unanswered". Kept normalized so the runner sidecar can pass
// them straight to buildClaudeBidiApprovalResponseMessage without re-trusting client input.
function normalizeRuntimeApprovalChoices(choices) {
  if (!Array.isArray(choices)) return [];
  return choices
    .map((value) => (Number.isInteger(value) ? value : Number.parseInt(String(value ?? ''), 10)))
    .filter((value) => Number.isInteger(value))
    .map((value) => (value >= 0 ? value : -1));
}

function normalizeRuntimeApprovalCustomAnswer(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 8000);
}

export async function submitRuntimeApproval(runId, approvalId, options = {}) {
  const assertApproval = () => temporaryApprovalDelegation(options.approvalActor, 'approval.resolve');
  const temporaryApproval = assertApproval();
  const normalizedRunId = trimString(runId);
  const normalizedApprovalId = normalizeRuntimeApprovalId(approvalId);
  const normalizedDecision = normalizeCodexAppServerApprovalDecision(options.decision || options.action);
  if (!normalizedDecision) {
    const error = new Error('approval decision must be approve, approve_for_session, deny, or cancel');
    error.code = 'INVALID_APPROVAL_DECISION';
    throw error;
  }
  if (!normalizedRunId || !normalizedApprovalId) {
    const error = new Error('runId and approvalId are required');
    error.code = 'APPROVAL_TARGET_REQUIRED';
    throw error;
  }

  const run = await getRun(normalizedRunId);
  if (!run) {
    const error = new Error('Run not found');
    error.code = 'RUN_NOT_FOUND';
    throw error;
  }
  if (!['codex-app-server-json', 'claude-stream-json-bidi', 'openhands-agent-server'].includes(run.runtimeFamily)) {
    const error = new Error('Runtime approval responses are not supported for this provider runtime');
    error.code = 'APPROVAL_UNSUPPORTED_RUNTIME';
    throw error;
  }
  if (isTerminalRunState(run.state)) {
    const error = new Error('Run is no longer active');
    error.code = 'RUN_TERMINAL';
    throw error;
  }

  let pending = findRunPendingApproval(run, normalizedApprovalId);
  const queued = findRunQueuedApprovalResponse(run, normalizedApprovalId);
  if (pending?.state === 'responded' || queued) {
    return {
      requestId: trimString(options.requestId) || null,
      duplicate: true,
      approval: pending || queued,
      run,
      session: await getSession(run.sessionId),
    };
  }
  if (!pending) {
    // Fallback: the sidecar may have lost its run-state tracking of this
    // approval (gate edge cases / crash races). If the session stream still
    // carries a live pending request for this run + approvalId, seed a pending
    // record from it so the response still queues and reaches the provider —
    // the click must land instead of 404ing.
    assertApproval();
    pending = await seedRunApprovalFromSessionStream(run, normalizedApprovalId);
    if (!pending) {
      const error = new Error('Approval request not found');
      error.code = 'APPROVAL_NOT_FOUND';
      throw error;
    }
    await updateRun(normalizedRunId, (current) => { assertApproval(); return ({
      ...current,
      appServerPendingApprovals: [
        ...(Array.isArray(current?.appServerPendingApprovals) ? current.appServerPendingApprovals : []),
        pending,
      ],
    }); }, { beforeWrite: assertApproval, beforeCommit: assertApproval });
  }

  let multiChoices;
  if (Object.hasOwn(options, 'multiChoices')) {
    const questions = pending?.params?.input?.questions;
    const choices = options.multiChoices;
    const answers = options.customAnswers;
    const valid = run.runtimeFamily === 'claude-stream-json-bidi'
      && pending?.params?.tool_name === 'AskUserQuestion'
      && Array.isArray(questions) && questions.length > 0 && questions.length <= 6
      && Array.isArray(choices) && choices.length === questions.length
      && Array.isArray(answers) && answers.length === questions.length
      && new Set(questions.map((q) => q?.question?.trim())).size === questions.length
      && questions.every((question, index) => {
        const selected = choices[index];
        const text = answers[index];
        const available = question?.options;
        return typeof question?.question === 'string' && question.question.trim()
          && Array.isArray(available) && Array.isArray(selected) && typeof text === 'string'
          && new Set(selected).size === selected.length
          && selected.every((i) => Number.isInteger(i) && i >= 0 && i < available.length
            && typeof available[i]?.label === 'string' && available[i].label.trim())
          && (question.multiSelect === true || selected.length <= 1)
          && (question.multiSelect === true || !selected.length || !text.trim())
          && (selected.length > 0 || text.trim());
      });
    if (!valid) {
      const error = new Error('Invalid per-question choices or answers');
      error.code = 'INVALID_APPROVAL_CHOICES';
      throw error;
    }
    multiChoices = choices.map((selected) => [...selected]);
  }

  const responseEntry = {
    id: generateId(),
    approvalId: normalizedApprovalId,
    decision: normalizedDecision,
    displayDecision: formatCodexAppServerApprovalDecision(normalizedDecision),
    requestId: trimString(options.requestId) || '',
    choices: normalizeRuntimeApprovalChoices(options.choices),
    customAnswer: normalizeRuntimeApprovalCustomAnswer(options.customAnswer),
    customAnswers: Array.isArray(options.customAnswers) ? options.customAnswers.slice(0, 6).map(normalizeRuntimeApprovalCustomAnswer) : [],
    ...(multiChoices ? { multiChoices } : {}),
    state: 'pending',
    createdAt: nowIso(),
    ...(temporaryApproval ? { decisionSource: temporaryApproval.source,
      temporaryControlGrantId: temporaryApproval.grantId } : {}),
  };
  assertApproval();
  let enqueued = false;
  const updatedRun = await updateRun(normalizedRunId, (current) => {
    assertApproval();
    if (isTerminalRunState(current?.state)) return current;
    const existing = Array.isArray(current?.appServerApprovalResponseQueue) ? current.appServerApprovalResponseQueue : [];
    if (existing.some(entry => normalizeRuntimeApprovalId(entry?.approvalId) === normalizedApprovalId)) return current;
    const currentPending = findRunPendingApproval(current, normalizedApprovalId);
    if (!currentPending || currentPending.state === 'responded') return current;
    // Capture the group under the same run mutation lock as the queue write.
    // A later matching request remains independent once the owner has decided.
    const group = equivalentPendingApprovals(current, normalizedApprovalId);
    const additional = group.filter(entry => entry.approvalId !== normalizedApprovalId).map(entry => ({
      ...responseEntry, id: generateId(), approvalId: entry.approvalId,
    }));
    enqueued = true;
    return { ...current, appServerApprovalResponseQueue: [...existing, responseEntry, ...additional] };
  }, { beforeWrite: assertApproval, beforeCommit: assertApproval }) || run;
  if (!enqueued) {
    if (isTerminalRunState(updatedRun?.state)) {
      const error = new Error('Run is no longer active');
      error.code = 'RUN_TERMINAL';
      throw error;
    }
    const existing = findRunQueuedApprovalResponse(updatedRun, normalizedApprovalId);
    const currentPending = findRunPendingApproval(updatedRun, normalizedApprovalId);
    if (!existing && !currentPending) {
      const error = new Error('Approval request not found');
      error.code = 'APPROVAL_NOT_FOUND';
      throw error;
    }
    return { requestId: responseEntry.requestId || null, duplicate: true,
      approval: existing || currentPending, run: updatedRun, session: await getSession(updatedRun.sessionId) };
  }
  await resumeHarnessRunBudget(updatedRun);
  observeDetachedRun(updatedRun.sessionId, updatedRun.id);
  broadcastSessionInvalidation(updatedRun.sessionId);
  return {
    requestId: responseEntry.requestId || null,
    duplicate: false,
    approval: responseEntry,
    run: updatedRun,
    session: await getSession(updatedRun.sessionId),
  };
}

function normalizePrivilegedApprovalCategory(value) {
  const normalized = trimString(value);
  if (normalized === CATEGORY_OTHER || normalized === CATEGORY_DELETE) return normalized;
  // The mobile batch sheet iterates the request event's group keys
  // (other/delete) end-to-end — DOM, i18n, and the resolve URL. Accept the
  // short names here so submissions from the shipped surface don't 400.
  if (normalized === 'other') return CATEGORY_OTHER;
  if (normalized === 'delete') return CATEGORY_DELETE;
  return '';
}

function findPrivilegedBatchRequest(events = [], batchId = '') {
  const normalizedBatchId = trimString(batchId);
  if (!normalizedBatchId) return null;
  return (Array.isArray(events) ? events : []).find((event) =>
    event?.type === 'privileged_batch_request'
    && trimString(event?.batchId) === normalizedBatchId) || null;
}

function buildPrivilegedApprovalQueueEntry({ batchId, category, op, approved, requestId }) {
  const approvalId = normalizeRuntimeApprovalId(op?.approvalId);
  if (!approvalId) return null;
  const decision = approved ? 'approve' : 'deny';
  const command = trimString(op?.command);
  const wrapperCommand = trimString(op?.wrapperCommand);
  return {
    id: generateId(),
    approvalId,
    decision,
    displayDecision: formatCodexAppServerApprovalDecision(decision),
    requestId: trimString(requestId),
    choices: [],
    state: 'pending',
    createdAt: nowIso(),
    privilegedBatchId: trimString(batchId),
    privilegedOpId: trimString(op?.opId),
    privilegedCategory: trimString(category),
    privilegedCommand: command,
    ...(wrapperCommand ? { privilegedWrapperCommand: wrapperCommand } : {}),
    ...(approved && wrapperCommand && command ? { updatedInput: { command } } : {}),
  };
}

function buildPrivilegedApprovalQueueEntries(resolved, requestId = '') {
  const entries = [];
  const decisions = resolved?.decisions && typeof resolved.decisions === 'object'
    ? resolved.decisions
    : {};
  for (const op of Array.isArray(resolved?.categoryOps) ? resolved.categoryOps : []) {
    const decision = decisions[op?.opId];
    if (decision !== 'approved' && decision !== 'denied') continue;
    const entry = buildPrivilegedApprovalQueueEntry({
      batchId: resolved.batchId,
      category: resolved.category,
      op,
      approved: decision === 'approved',
      requestId,
    });
    if (entry) entries.push(entry);
  }
  return entries;
}

async function submitPrivilegedCategoryApprovalUnlocked(runId, batchId, category, options = {}) {
  const temporaryApproval = temporaryApprovalDelegation(options.approvalActor, 'approval.privileged.resolve');
  const normalizedRunId = trimString(runId);
  const normalizedBatchId = trimString(batchId);
  const normalizedCategory = normalizePrivilegedApprovalCategory(category);
  if (!normalizedRunId || !normalizedBatchId || !normalizedCategory) {
    const error = new Error('runId, batchId, and supported category are required');
    error.code = 'PRIVILEGED_APPROVAL_TARGET_REQUIRED';
    throw error;
  }

  const run = await getRun(normalizedRunId);
  if (!run) {
    const error = new Error('Run not found');
    error.code = 'RUN_NOT_FOUND';
    throw error;
  }
  if (!['codex-app-server-json', 'claude-stream-json-bidi'].includes(run.runtimeFamily)) {
    const error = new Error('Privileged approval responses are not supported for this provider runtime');
    error.code = 'PRIVILEGED_APPROVAL_UNSUPPORTED_RUNTIME';
    throw error;
  }
  if (isTerminalRunState(run.state)) {
    const error = new Error('Run is no longer active');
    error.code = 'RUN_TERMINAL';
    throw error;
  }

  const session = await getSession(run.sessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.code = 'SESSION_NOT_FOUND';
    throw error;
  }
  // Gate on either the legacy privilegedMode opt-in or a risk-gated mode
  // (safe/recommended — the polarity-flip default), so danger approvals in
  // risk-gated sessions can actually be submitted.
  if (session.privilegedMode !== true
    && session.riskMode !== 'safe'
    && session.riskMode !== 'recommended') {
    const error = new Error('Session privileged mode is not enabled');
    error.code = 'PRIVILEGED_MODE_OFF';
    throw error;
  }

  const readSessionEvents = async () => readPrivilegedBatchEvents(run.sessionId, normalizedBatchId);
  const existingEvents = await readSessionEvents();
  const batchRequest = findPrivilegedBatchRequest(existingEvents, normalizedBatchId);
  if (!batchRequest) {
    const error = new Error('Privileged batch request not found');
    error.code = 'PRIVILEGED_BATCH_NOT_FOUND';
    throw error;
  }
  if (trimString(batchRequest.runId) !== normalizedRunId) {
    const error = new Error('Privileged batch does not belong to this run');
    error.code = 'PRIVILEGED_BATCH_RUN_MISMATCH';
    throw error;
  }

  const realStore = {
    readEvents: readSessionEvents,
    appendEvent: async (event) => appendEvent(run.sessionId, {
      ...event,
      runId: normalizedRunId,
      requestId: trimString(options.requestId) || undefined,
    }),
    invalidate: async () => { broadcastSessionInvalidation(run.sessionId); },
  };

  // The owner decision is an authorization for the exact checked subset, not
  // permission for the provider to run raw sudo. The batch helper consumes the
  // WebAuthn proof, signs one-shot tokens, and dispatches each selected op to
  // the root-only executor before queuing the provider response.
  const executed = await executePrivilegedPasskeyBatch(
    run.sessionId,
    run,
    batchRequest,
    normalizedCategory,
    realStore,
    {
      checkedOpIds: Array.isArray(options.checkedOpIds) ? options.checkedOpIds : [],
      requestId: trimString(options.requestId),
      webauthnProof: options.webauthnProof,
      source: temporaryApproval?.source || trimString(options.source) || undefined,
      approvalActor: options.approvalActor,
    },
    {
      loadSigningKeys: loadOrCreatePrivilegedSigningKeys,
      executeOpAsEvent: executePrivilegedOpAsEvent,
      verifyOwnerWebAuthnAssertion,
    },
  );
  let updatedRun = await getRun(normalizedRunId) || run;
  const shimUpdate = buildPrivilegedShimCategoryUpdate(updatedRun, normalizedBatchId, executed.resolved, executed.execResults);
  if (shimUpdate) updatedRun = await updateRun(normalizedRunId, shimUpdate) || updatedRun;
  await resumeHarnessRunBudget(updatedRun);
  observeDetachedRun(updatedRun.sessionId, updatedRun.id);
  broadcastSessionInvalidation(updatedRun.sessionId);
  return {
    requestId: trimString(options.requestId) || null,
    duplicate: executed.resolved?.duplicate === true,
    batchId: normalizedBatchId,
    category: normalizedCategory,
    approved: executed.resolved?.approved || [],
    denied: executed.resolved?.denied || [],
    responseEvent: executed.resolved?.responseEvent || null,
    queuedApprovals: executed.queuedApprovals || [],
    run: updatedRun,
    session,
  };
}

// Browser retries, reconnect replay and mobile double taps can submit the same
// category concurrently. Serialize by the exact run/batch/category target so
// only one executor pass can consume the proof or append response entries.
export async function submitPrivilegedCategoryApproval(runId, batchId, category, options = {}) {
  const key = [trimString(runId), trimString(batchId), normalizePrivilegedApprovalCategory(category)].join(':');
  return privilegedCategoryApprovalQueue(key, () => submitPrivilegedCategoryApprovalUnlocked(runId, batchId, category, options));
}

// Phase 4 — WebAuthn assertion challenge for a passkey-approved privileged
// category. The challenge binds exactly the approved batch subset
// (manifestHash = computeBatchManifestHash over the checked ops), so the proof
// returned after the user's phone assertion can only be consumed for that same
// subset (see executePrivilegedPasskeyBatch).
export async function createPrivilegedCategoryWebAuthnChallenge(runId, batchId, category, options = {}) {
  const normalizedRunId = trimString(runId);
  const normalizedBatchId = trimString(batchId);
  const normalizedCategory = normalizePrivilegedApprovalCategory(category);
  if (!normalizedRunId || !normalizedBatchId || !normalizedCategory) {
    const error = new Error('runId, batchId, and supported category are required');
    error.code = 'PRIVILEGED_APPROVAL_TARGET_REQUIRED';
    throw error;
  }
  const run = await getRun(normalizedRunId);
  if (!run) {
    const error = new Error('Run not found');
    error.code = 'RUN_NOT_FOUND';
    throw error;
  }
  const session = await getSession(run.sessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.code = 'SESSION_NOT_FOUND';
    throw error;
  }
  if (session.privilegedMode !== true
    && session.riskMode !== 'safe'
    && session.riskMode !== 'recommended') {
    const error = new Error('Session privileged mode is not enabled');
    error.code = 'PRIVILEGED_MODE_OFF';
    throw error;
  }
  const existingEvents = await readPrivilegedBatchEvents(run.sessionId, normalizedBatchId);
  const batchRequest = findPrivilegedBatchRequest(existingEvents, normalizedBatchId);
  if (!batchRequest) {
    const error = new Error('Privileged batch request not found');
    error.code = 'PRIVILEGED_BATCH_NOT_FOUND';
    throw error;
  }
  if (trimString(batchRequest.runId) !== normalizedRunId) {
    const error = new Error('Privileged batch does not belong to this run');
    error.code = 'PRIVILEGED_BATCH_RUN_MISMATCH';
    throw error;
  }
  const categoryOps = (normalizedCategory === CATEGORY_DELETE ? batchRequest.delete : batchRequest.other) || [];
  const checked = new Set((Array.isArray(options.checkedOpIds) ? options.checkedOpIds : [])
    .map((id) => trimString(id))
    .filter(Boolean));
  const approved = categoryOps.filter((op) => checked.has(trimString(op?.opId)));
  const knownOpIds = new Set(categoryOps.map((op) => trimString(op?.opId)).filter(Boolean));
  const unknownCheckedOpId = [...checked].find((opId) => !knownOpIds.has(opId));
  if (unknownCheckedOpId) {
    const error = new Error(`Unknown privileged operation ${unknownCheckedOpId}`);
    error.code = 'PRIVILEGED_APPROVAL_OPERATION_INVALID';
    throw error;
  }
  if (approved.length === 0) {
    const error = new Error('At least one privileged operation must be selected for Passkey approval');
    error.code = 'PRIVILEGED_APPROVAL_EMPTY_SELECTION';
    throw error;
  }
  const manifestHash = computeBatchManifestHash(approved, normalizedCategory);
  return createOwnerWebAuthnAssertionOptions(options.request || {}, {
    purpose: PRIVILEGED_PASSKEY_APPROVAL_PURPOSE,
    sessionId: run.sessionId,
    requestId: trimString(options.requestId),
    manifestHash,
  });
}

const SESSION_CONFIRMATION_SOURCE = 'agentoc-confirmation';

// WebAuthn assertion purpose for passkey-approved privileged categories. The
// challenge (createOwnerWebAuthnAssertionOptions) and the proof consumption
// (consumeOwnerWebAuthnProof) must agree on this exact string.
const PRIVILEGED_PASSKEY_APPROVAL_PURPOSE = 'privileged-category-approval';

function normalizeSessionConfirmationDecision(value) {
  const normalized = trimString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (['approve', 'approved', 'accept', 'accepted', 'yes', 'confirm', 'confirmed', 'ok'].includes(normalized)) {
    return 'approve';
  }
  if (['deny', 'denied', 'decline', 'declined', 'reject', 'rejected', 'no', 'cancel', 'cancelled', 'canceled'].includes(normalized)) {
    return 'deny';
  }
  return '';
}

function normalizeSessionConfirmationId(value) {
  return trimString(value).slice(0, 200);
}

function isSessionConfirmationRequest(event) {
  return event?.type === 'approval_request'
    && trimString(event.source) === SESSION_CONFIRMATION_SOURCE;
}

function isSessionConfirmationResponse(event) {
  return event?.type === 'approval_response'
    && trimString(event.source) === SESSION_CONFIRMATION_SOURCE;
}

function resolveSessionConfirmationMessage(request, decision) {
  const key = decision === 'approve' ? 'approveMessage' : 'denyMessage';
  const message = trimString(request?.[key]);
  if (message) return message;
  return '';
}

// Confirmation idempotency is a control-plane lookup. Do not rebuild the
// complete session timeline (and its Run/plan enrichment) just to find one
// approval request/response in a potentially very large transcript. The
// append-maintained approval index is authoritative enough for this decision;
// event files remain the source of truth and the index self-rebuilds lazily.
async function readSessionConfirmationEvents(sessionId) {
  const events = await readAllRuntimeApprovalEvents(sessionId);
  return events.filter((event) => isSessionConfirmationRequest(event) || isSessionConfirmationResponse(event));
}

export async function requestSessionConfirmation(sessionId, options = {}) {
  const normalizedSessionId = trimString(sessionId);
  if (!normalizedSessionId) {
    const error = new Error('sessionId is required');
    error.code = 'SESSION_REQUIRED';
    throw error;
  }
  const session = await getSession(normalizedSessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.code = 'SESSION_NOT_FOUND';
    throw error;
  }
  const approvalId = normalizeSessionConfirmationId(options.approvalId) || `confirm_${generateId()}`;
  const history = await readSessionConfirmationEvents(normalizedSessionId);
  const existing = history.find((event) =>
    isSessionConfirmationRequest(event)
    && normalizeSessionConfirmationId(event.approvalId) === approvalId);
  if (existing) {
    return {
      duplicate: true,
      confirmation: existing,
      session,
    };
  }

  const event = approvalRequestEvent({
    approvalId,
    kind: 'confirmation',
    title: trimString(options.title) || 'Confirmation needed',
    reason: trimString(options.reason || options.message),
    status: 'pending',
    source: SESSION_CONFIRMATION_SOURCE,
    providerMethod: trimString(options.providerMethod),
    runId: trimString(options.runId),
    turnId: trimString(options.turnId),
    operation: trimString(options.operation),
    question: trimString(options.question || options.prompt),
    questions: Array.isArray(options.questions) ? options.questions : [],
    options: Array.isArray(options.options)
      ? options.options
      : (Array.isArray(options.choices) ? options.choices : []),
    confirmLabel: trimString(options.confirmLabel) || 'Approve',
    denyLabel: trimString(options.denyLabel) || 'Deny',
    approveMessage: trimString(options.approveMessage),
    denyMessage: trimString(options.denyMessage),
  });
  if (!event) {
    const error = new Error('Failed to create confirmation request');
    error.code = 'CONFIRMATION_INVALID';
    throw error;
  }
  const stored = await appendEvent(normalizedSessionId, event);
  broadcastSessionInvalidation(normalizedSessionId);
  return {
    duplicate: false,
    confirmation: stored,
    session: await getSession(normalizedSessionId) || session,
  };
}

export async function submitSessionConfirmationDecision(sessionId, approvalId, options = {}) {
  const normalizedSessionId = trimString(sessionId);
  const normalizedApprovalId = normalizeSessionConfirmationId(approvalId);
  const decision = normalizeSessionConfirmationDecision(options.decision || options.action);
  if (!normalizedSessionId || !normalizedApprovalId) {
    const error = new Error('sessionId and confirmation id are required');
    error.code = 'CONFIRMATION_TARGET_REQUIRED';
    throw error;
  }
  if (!decision) {
    const error = new Error('confirmation decision must be approve or deny');
    error.code = 'INVALID_CONFIRMATION_DECISION';
    throw error;
  }
  const session = await getSession(normalizedSessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.code = 'SESSION_NOT_FOUND';
    throw error;
  }
  const history = await readSessionConfirmationEvents(normalizedSessionId);
  const request = history.find((event) =>
    isSessionConfirmationRequest(event)
    && normalizeSessionConfirmationId(event.approvalId) === normalizedApprovalId);
  if (!request) {
    const error = new Error('Confirmation request not found');
    error.code = 'CONFIRMATION_NOT_FOUND';
    throw error;
  }
  const existingResponse = history.find((event) =>
    isSessionConfirmationResponse(event)
    && normalizeSessionConfirmationId(event.approvalId) === normalizedApprovalId);
  if (existingResponse) {
    return {
      requestId: trimString(options.requestId) || null,
      duplicate: true,
      confirmation: request,
      responseEvent: existingResponse,
      session,
    };
  }

  const responseEvent = approvalResponseEvent({
    approvalId: normalizedApprovalId,
    decision,
    status: decision === 'approve' ? 'approved' : 'denied',
    source: SESSION_CONFIRMATION_SOURCE,
  });
  const storedResponse = await appendEvent(normalizedSessionId, responseEvent);
  const followUpMessage = resolveSessionConfirmationMessage(request, decision);
  let messageOutcome = null;
  if (followUpMessage) {
    const requestId = trimString(options.requestId) || `confirmation_${generateId()}`;
    messageOutcome = await submitHttpMessage(normalizedSessionId, followUpMessage, [], {
      requestId,
      authenticatedPrincipalKind: options.authenticatedPrincipalKind,
      authenticatedOwnerDevice: options.authenticatedOwnerDevice,
      temporaryControlAuthority: options.temporaryControlAuthority,
      sourceContext: {
        kind: 'session_confirmation',
        confirmationId: normalizedApprovalId,
        decision,
      },
    });
  } else {
    broadcastSessionInvalidation(normalizedSessionId);
  }

  return {
    requestId: trimString(options.requestId) || messageOutcome?.requestId || null,
    duplicate: false,
    confirmation: request,
    responseEvent: storedResponse,
    message: messageOutcome,
    run: messageOutcome?.run || null,
    session: messageOutcome?.session || await getSession(normalizedSessionId) || session,
  };
}

export async function submitPlanAction(sessionId, planId, options = {}) {
  const action = normalizePlanAction(options.action || options.planAction);
  if (!action) {
    const error = new Error('plan action must be "revise" or "execute"');
    error.code = 'INVALID_PLAN_ACTION';
    throw error;
  }
  const normalizedPlanId = normalizePlanId(planId || options.planId);
  if (!normalizedPlanId) {
    const error = new Error('planId is required');
    error.code = 'PLAN_ID_REQUIRED';
    throw error;
  }
  const text = trimString(options.text)
    || (action === 'execute' ? 'Execute approved plan.' : 'Revise approved plan.');
  return submitHttpMessage(sessionId, text, [], {
    requestId: trimString(options.requestId) || createInternalRequestId(`plan_${action}`),
    authenticatedPrincipalKind: options.authenticatedPrincipalKind,
    authenticatedOwnerDevice: options.authenticatedOwnerDevice,
    temporaryControlAuthority: options.temporaryControlAuthority,
    tool: trimString(options.tool) || undefined,
    model: trimString(options.model) || undefined,
    effort: trimString(options.effort) || undefined,
    serviceTier: trimString(options.serviceTier) || undefined,
    permissionMode: trimString(options.permissionMode) || undefined,
    thinking: options.thinking === true,
    interactionMode: resolvePlanActionInteractionMode(action),
    planAction: action,
    planId: normalizedPlanId,
    codexResume: true,
    recordedUserText: text,
    sourceContext: {
      type: 'plan_action',
      action,
      planId: normalizedPlanId,
    },
  });
}

export async function cancelActiveRun(sessionId, { expectedRunId = null, reconcile = true, beforeWrite = null, authorizeWrite = null } = {}) {
  const session = await findSessionMeta(sessionId);
  if (!session) return null;
  // An explicit Run target remains the target even if another concurrent Run
  // owns the Session's legacy pointer. A Session-level stop still captures
  // that pointer once, so it cannot switch to a later Run during reconciliation.
  const activeRunId = expectedRunId !== null ? expectedRunId : session.activeRunId;
  if (!activeRunId) return null;
  // Conditional effects must not await a reconciliation started outside
  // their metadata transaction. That observer may already await this lock.
  let run = await getRun(activeRunId);
  if (!run) return null;
  if (run.id !== activeRunId || run.sessionId !== sessionId) {
    throw Object.assign(new Error("Run identity changed before cancellation"),
      { code: "RUN_IDENTITY_CONFLICT", statusCode: 409 });
  }
  if (reconcile) run = await flushDetachedRunIfNeeded(sessionId, activeRunId) || run;
  if (run.id !== activeRunId || run.sessionId !== sessionId) {
    throw Object.assign(new Error("Run identity changed before cancellation"),
      { code: "RUN_IDENTITY_CONFLICT", statusCode: 409 });
  }
  if (isTerminalRunState(run.state)) {
    return run;
  }
  if (run.state === 'queued') {
    // A queued AgY Run has no provider process to interrupt. Terminalize it
    // immediately so it cannot be selected by the next queue drain.
    const completedAt = nowIso();
    const cancelled = await updateRun(run.id, (current) => {
      // Queue admission can race the earlier read. Only terminalize a Run
      // that is still queued under its own mutation lock.
      if (current.state !== 'queued') return current;
      return {
        ...current,
        state: 'cancelled',
        cancelRequested: true,
        cancelRequestedAt: current.cancelRequestedAt || completedAt,
        completedAt: current.completedAt || completedAt,
        result: current.result || {
          completedAt,
          exitCode: 1,
          signal: null,
          cancelled: true,
        },
      };
    }, { beforeWrite, authorizeWrite });
    if (cancelled && isTerminalRunState(cancelled.state)) {
      const cancelledRun = (reconcile ? await syncDetachedRun(sessionId, run.id) : null) || cancelled;
      broadcastSessionInvalidation(sessionId);
      return cancelledRun;
    }
    // A newly admitted provider receives a cancellation request below;
    // its stop acknowledgement owns the terminal state.
  }
  const updated = await requestRunCancel(run.id, { beforeWrite, authorizeWrite });
  let settled = updated;
  if (updated && reconcile) {
    // Do not wait for the detached observer tick after Stop.  This is also
    // what closes the accepted/no-runner crash window synchronously for the
    // button request; live runners remain non-terminal until their sidecar
    // acknowledges the cancellation.
    settled = await syncDetachedRun(sessionId, run.id) || await getRun(run.id) || updated;
  }
  if (settled && hasPendingApprovedActionPause(settled)) {
    settled = await updateRun(run.id, (current) => ({
      ...current,
      state: 'cancelled',
      completedAt: current.completedAt || nowIso(),
      result: current.result || {
        completedAt: current.completedAt || nowIso(),
        exitCode: 1,
        signal: null,
        cancelled: true,
      },
    }), { beforeWrite, authorizeWrite }) || updated;
    if (reconcile) await syncDetachedRun(sessionId, run.id);
    settled = await getRun(run.id) || settled;
  }
  if (settled) {
    broadcastSessionInvalidation(sessionId);
  }
  return settled;
}

export async function getHistory(sessionId) {
  await reconcileSessionMeta(await findSessionMeta(sessionId));
  return loadHistory(sessionId);
}

// Bounded completion/reply history reader shared with collaboration and
// connector side effects. Keep the full getHistory() API for explicit exports,
// but make the hot completion path available without materializing transcripts.
export { loadRecentTurnHistory };

async function maybeForkNativeCodexThread(source) {
  const sourceThreadId = trimString(source?.codexThreadId);
  if (!sourceThreadId) return '';
  const toolId = trimString(source?.tool);
  const toolDefinition = toolId ? await getToolDefinitionAsync(toolId) : null;
  const runtimeFamily = trimString(toolDefinition?.runtimeFamily)
    || (toolId === 'codex'
      ? 'codex-app-server-json'
      : toolId === 'codex-cli'
        ? 'codex-json'
        : '');
  if (runtimeFamily !== 'codex-app-server-json') return '';

  try {
    const result = await forkCodexAppServerThread({
      toolId,
      threadId: sourceThreadId,
      providerProfileId: source.providerProfile || undefined,
      cwd: source.folder,
      model: source.model || undefined,
      interactionMode: source.interactionMode || undefined,
      permissionMode: source.permissionMode || undefined,
      riskMode: resolveSessionRiskMode(source),
    });
    return trimString(result?.threadId);
  } catch (error) {
    console.warn(`[session-fork] Codex native thread/fork failed for ${source.id}: ${error?.message || error}`);
    return '';
  }
}

export async function forkSession(sessionId) {
  const preparation = await prepareSessionForFork(sessionId);
  const source = preparation?.source;
  if (!source) return null;
  // S10 Managed Input enforcement: forking a managed session is a creation
  // bypass (constitution §2.10/§2.16). No-op when the flag is off.
  assertManagedInputAllowed({ session: source, operation: 'fork' });
  if (source.visitorId) return null;
  if (preparation.running) return null;

  const runtimeTool = preparation.runtimeBinding?.tool || trimString(source.tool);

  const [sourceHistoryMeta, contextHead] = await Promise.all([
    loadMeta(sessionId),
    getContextHead(sessionId),
  ]);
  const snapshot = {
    latestSeq: sourceHistoryMeta.latestSeq || 0,
  };
  const forkContext = await getOrPrepareForkContext(sessionId, snapshot, contextHead);
  const forkedCodexThreadId = await maybeForkNativeCodexThread(source);

  const child = await createSession(source.folder, runtimeTool, buildForkSessionName(source), {
    ...(source.projectId ? { projectId: source.projectId } : {}),
    group: source.group || '',
    description: source.description || '',
    sourceId: source.sourceId || '',
    sourceName: source.sourceName || '',
    templateId: source.templateId || '',
    templateName: source.templateName || '',
    systemPrompt: source.systemPrompt || '',
    providerProfile: source.providerProfile || '',
    activeAgreements: source.activeAgreements || [],
    userId: source.userId || '',
    userName: source.userName || '',
    forkedFromSessionId: source.id,
    forkedFromSeq: sourceHistoryMeta.latestSeq || 0,
    historyStorage: 'shared-prefix-v1',
    rootSessionId: source.rootSessionId || source.id,
    forkedAt: nowIso(),
    suppressBroadcast: true,
    ...(forkedCodexThreadId ? { codexThreadId: forkedCodexThreadId } : {}),
  });
  if (!child) return null;

  try {
    await initializeForkHistory(child.id, {
      sourceSessionId: source.id,
      throughSeq: sourceHistoryMeta.latestSeq || 0,
      sourceLatestSeqAtFork: sourceHistoryMeta.latestSeq || 0,
    });
    if (contextHead) {
      await setContextHead(child.id, {
        ...contextHead,
        updatedAt: contextHead.updatedAt || nowIso(),
      });
    } else {
      await clearContextHead(child.id);
    }

    if (forkContext) {
      await setForkContext(child.id, {
        ...forkContext,
        updatedAt: nowIso(),
      });
    } else {
      await clearForkContext(child.id);
    }
  } catch (error) {
    await removePartiallyCreatedFork(child.id);
    throw error;
  }

  broadcastSessionsInvalidation();
  return getSession(child.id);
}

function createForkError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function removePartiallyCreatedFork(sessionId) {
  // Session deletion releases the memoized timeline bundle, its generation
  // counter, and any skip reason before the durable state goes away (DS-10).
  releaseSessionTimelineCache(sessionId);
  try {
    await removeSessionMeta(sessionId);
  } finally {
    await removeSessionHistory(sessionId);
  }
}

async function findForkByIdempotencyKey(sourceSessionId, key) {
  if (!key) return null;
  const metas = await loadSessionsMeta();
  const match = metas.find((meta) => (
    meta?.forkedFromSessionId === sourceSessionId
      && meta?.forkIdempotencyKey === key
  ));
  return match ? getSession(match.id) : null;
}

async function readHistoricalForkPage(sessionId, afterSeq, throughSeq) {
  const page = await readEventsPage(sessionId, {
    afterSeq,
    direction: 'after',
    includeBodies: true,
    limit: Math.min(HISTORICAL_FORK_PAGE_SIZE, Math.max(1, throughSeq - afterSeq)),
  });
  return {
    events: (page.events || []).filter((event) => Number.isInteger(event?.seq) && event.seq <= throughSeq),
    latestSeq: page.pagination?.latestSeq || 0,
  };
}

export async function forkSessionAt(sessionId, options = {}) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  const rawAnchorSeq = options?.anchorSeq;
  const anchorSeq = Number.isInteger(rawAnchorSeq)
    ? rawAnchorSeq
    : (typeof rawAnchorSeq === 'string' && /^\d+$/.test(rawAnchorSeq.trim())
      ? Number(rawAnchorSeq.trim())
      : NaN);
  const requestedMode = typeof options?.mode === 'string' ? options.mode.trim() : '';
  // Older clients called the user-message branch action "user-replay".
  // Forking is a history-only operation, including for those clients.
  const mode = requestedMode === 'user-replay' ? 'user-continue' : (requestedMode || 'assistant-continue');
  const rawIdempotencyKey = typeof options?.idempotencyKey === 'string'
    ? options.idempotencyKey.trim()
    : '';

  if (!normalizedSessionId) throw createForkError('FORK_SESSION_INVALID', 'Session id is required');
  if (!Number.isInteger(anchorSeq) || anchorSeq < 1) {
    throw createForkError('FORK_ANCHOR_INVALID', 'anchorSeq must be a positive integer');
  }
  if (!['user-continue', 'assistant-continue'].includes(mode)) {
    throw createForkError('FORK_ANCHOR_INVALID', 'mode must be user-continue or assistant-continue');
  }
  if (rawIdempotencyKey.length > 128) {
    throw createForkError('FORK_REQUEST_INVALID', 'idempotencyKey is too long');
  }
  const idempotencyKey = rawIdempotencyKey;

  return historicalForkQueue(normalizedSessionId, async () => {
    const existing = await findForkByIdempotencyKey(normalizedSessionId, idempotencyKey);
    if (existing) return existing;

    const preparation = await prepareSessionForFork(normalizedSessionId);
    const source = preparation?.source;
    if (!source) throw createForkError('SESSION_NOT_FOUND', 'Session not found');
    // S10 Managed Input enforcement: fork-at from a managed session is a
    // creation bypass. No-op when the flag is off.
    assertManagedInputAllowed({ session: source, operation: 'fork-at' });
    if (source.visitorId) throw createForkError('FORK_FORBIDDEN', 'Visitor sessions cannot be forked');
    if (source.isInternalSession === true || source.internalRole) {
      throw createForkError('FORK_FORBIDDEN', 'Internal sessions cannot be forked');
    }
    if (preparation.running) throw createForkError('SESSION_RUNNING', 'Session is running');

    const runtimeTool = preparation.runtimeBinding?.tool || trimString(source.tool);

    const sourceHistoryMeta = await loadMeta(normalizedSessionId);
    if (anchorSeq > sourceHistoryMeta.latestSeq) {
      throw createForkError('FORK_ANCHOR_INVALID', 'Fork anchor is outside the session history');
    }
    const anchorPage = await readHistoricalForkPage(normalizedSessionId, anchorSeq - 1, anchorSeq);
    const anchor = anchorPage.events.find((event) => event?.seq === anchorSeq);
    if (!anchor || anchor.type !== 'message' || !['user', 'assistant'].includes(anchor.role)) {
      throw createForkError('FORK_ANCHOR_INVALID', 'Fork anchor must be a user or assistant message');
    }
    if (mode === 'user-continue' && anchor.role !== 'user') {
      throw createForkError('FORK_ANCHOR_INVALID', 'user-continue requires a user message');
    }
    if (mode === 'assistant-continue' && anchor.role !== 'assistant') {
      throw createForkError('FORK_ANCHOR_INVALID', 'assistant-continue requires an assistant message');
    }

    const throughSeq = anchorSeq;
    const contextHead = await getContextHead(normalizedSessionId);
    const contextIsValid = !contextHead
      || ((contextHead.activeFromSeq || 0) <= throughSeq
        && (contextHead.compactedThroughSeq || 0) <= throughSeq);
    const historicalContext = contextIsValid
      ? await prepareForkContextSnapshot(normalizedSessionId, { latestSeq: throughSeq }, contextHead)
      : await prepareForkContextSnapshot(normalizedSessionId, { latestSeq: throughSeq }, null);

    const child = await createSession(source.folder, runtimeTool, buildForkSessionName(source), {
      ...(source.projectId ? { projectId: source.projectId } : {}),
      group: source.group || '',
      description: source.description || '',
      sourceId: source.sourceId || '',
      sourceName: source.sourceName || '',
      templateId: source.templateId || '',
      templateName: source.templateName || '',
      systemPrompt: source.systemPrompt || '',
      providerProfile: source.providerProfile || '',
      activeAgreements: source.activeAgreements || [],
      model: source.model || '',
      effort: source.effort || '',
      thinking: source.thinking === true,
      interactionMode: source.interactionMode || undefined,
      riskMode: source.riskMode || undefined,
      userId: source.userId || '',
      userName: source.userName || '',
      forkedFromSessionId: source.id,
      forkedFromSeq: throughSeq,
      forkedAnchorSeq: anchorSeq,
      forkMode: mode,
      forkIdempotencyKey: idempotencyKey,
      historyStorage: 'shared-prefix-v1',
      rootSessionId: source.rootSessionId || source.id,
      forkedAt: nowIso(),
      suppressBroadcast: true,
    });
    if (!child) throw createForkError('FORK_CREATE_FAILED', 'Unable to create fork session');

    try {
      await initializeForkHistory(child.id, {
        sourceSessionId: normalizedSessionId,
        throughSeq,
        sourceLatestSeqAtFork: sourceHistoryMeta.latestSeq,
      });
      if (contextIsValid && contextHead) {
        await setContextHead(child.id, {
          ...contextHead,
          updatedAt: contextHead.updatedAt || nowIso(),
        });
      } else {
        await clearContextHead(child.id);
      }
      if (historicalContext) {
        await setForkContext(child.id, {
          ...historicalContext,
          updatedAt: nowIso(),
        });
      }

      broadcastScopedSessionsInvalidation(child);
      broadcastSessionsInvalidation();
      return await getSession(child.id);
    } catch (error) {
      await removePartiallyCreatedFork(child.id);
      throw error;
    }
  });
}

export async function delegateSession(sessionId, payload = {}) {
  const source = await getSession(sessionId);
  if (!source) return null;
  // S10 Managed Input enforcement: a managed session is an execution leaf and
  // cannot recursively delegate (constitution §2.11/§2.16); the CLI
  // `session-spawn` command posts to the delegate endpoint, so this also
  // rejects spawning from a managed source. No-op when the flag is off.
  assertManagedInputAllowed({ session: source, operation: 'delegate' });
  if (source.visitorId) return null;

  const task = typeof payload?.task === 'string' ? payload.task.trim() : '';
  if (!task) {
    throw new Error('task is required');
  }

  // Guard: delegation depth limit to prevent recursive spawn chains
  const sourceDepth = typeof source.delegationDepth === 'number' ? source.delegationDepth : 0;
  if (sourceDepth >= MAX_DELEGATION_DEPTH) {
    throw new Error(`Delegation depth limit reached (${MAX_DELEGATION_DEPTH}). Child sessions should not recursively delegate further.`);
  }

  // Guard: rate limiter to prevent burst session creation
  const now = Date.now();
  while (_delegationTimestamps.length > 0 && _delegationTimestamps[0] < now - DELEGATION_RATE_WINDOW_MS) {
    _delegationTimestamps.shift();
  }
  if (_delegationTimestamps.length >= DELEGATION_RATE_MAX_PER_WINDOW) {
    throw new Error(`Delegation rate limit exceeded (${DELEGATION_RATE_MAX_PER_WINDOW} per ${DELEGATION_RATE_WINDOW_MS / 1000}s). Try again later.`);
  }
  _delegationTimestamps.push(now);

  const requestedName = typeof payload?.name === 'string' ? payload.name.trim() : '';
  const requestedTool = typeof payload?.tool === 'string' ? payload.tool.trim() : '';
  const runInternally = payload?.internal === true;
  const nextTool = requestedTool || source.tool;
  const inheritRuntimePreferences = !requestedTool || requestedTool === source.tool;

  const reusableChild = await findReusableDelegatedChild(source.id, task);
  if (reusableChild) {
    await ensureDelegatedChildCompletionWake(source.id, reusableChild.id);
    const activeRunId = typeof reusableChild.activeRunId === 'string' ? reusableChild.activeRunId.trim() : '';
    const reusableRun = activeRunId
      ? await flushDetachedRunIfNeeded(reusableChild.id, activeRunId) || await getRun(activeRunId)
      : await findLatestRunForSession(reusableChild.id);
    return {
      session: reusableChild,
      run: reusableRun || null,
    };
  }

  const child = await createSession(source.folder, nextTool, requestedName || '', {
    sourceId: source.sourceId || '',
    sourceName: source.sourceName || '',
    templateId: source.templateId || '',
    templateName: source.templateName || '',
    systemPrompt: source.systemPrompt || '',
    providerProfile: inheritRuntimePreferences ? source.providerProfile || '' : '',
    activeAgreements: source.activeAgreements || [],
    model: inheritRuntimePreferences ? source.model || '' : '',
    effort: inheritRuntimePreferences ? source.effort || '' : '',
    thinking: inheritRuntimePreferences && source.thinking === true,
    userId: source.userId || '',
    userName: source.userName || '',
    delegatedFromSessionId: source.id,
    parentSessionId: source.id,
    rootSessionId: source.rootSessionId || source.id,
    delegationDepth: sourceDepth + 1,
    ...(runInternally ? { internalRole: INTERNAL_SESSION_ROLE_AGENT_DELEGATE } : {}),
  });
  if (!child) return null;

  const handoffText = buildDelegationHandoff({
    source,
    task,
  });
  const outcome = await submitHttpMessage(child.id, handoffText, [], {
    requestId: createInternalRequestId('delegate'),
    skipDispatch: true,
    tool: requestedTool || undefined,
    model: inheritRuntimePreferences ? source.model || undefined : undefined,
    effort: inheritRuntimePreferences ? source.effort || undefined : undefined,
    thinking: inheritRuntimePreferences && source.thinking === true,
  });

  const resultSession = outcome.session || await getSession(child.id) || child;
  await appendEvent(source.id, buildDelegationContextOperation(task, resultSession));
  if (!runInternally) {
    await appendEvent(source.id, messageEvent('assistant', buildDelegationNoticeMessage(task, resultSession), undefined, {
      messageKind: 'session_delegate_notice',
    }));
  }
  // A delegated child must wake its parent when its first Run reaches a
  // terminal state. Keep this as a normal durable event trigger so the
  // relationship survives a chat-server restart and the parent uses the same
  // queue/idempotency path as every other deferred wake-up.
  await ensureDelegatedChildCompletionWake(source.id, resultSession.id);
  broadcastSessionInvalidation(source.id);

  return {
    session: resultSession,
    run: outcome.run || null,
  };
}

export async function dropToolUse(sessionId) {
  const session = await getSession(sessionId);
  if (!session) return false;

  const MAX_DROP_TOOL_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
  const MAX_DROP_TOOL_TRANSCRIPT_MESSAGES = 2048;
  const transcriptParts = [];
  let transcriptBytes = 0;
  let omittedMessages = 0;
  let kept = 0;
  let dropped = 0;
  await scanStoredEvents(sessionId, async (event) => {
    if (event?.type === 'message') {
      kept += 1;
      const part = `[${event.role === 'user' ? 'User' : 'Assistant'}]: ${clipScopedBody(event.content || '')}`;
      const partBytes = Buffer.byteLength(part, 'utf8');
      if (transcriptParts.length >= MAX_DROP_TOOL_TRANSCRIPT_MESSAGES
        || transcriptBytes + partBytes > MAX_DROP_TOOL_TRANSCRIPT_BYTES) {
        omittedMessages += 1;
      } else {
        transcriptParts.push(part);
        transcriptBytes += partBytes;
      }
    } else if (['tool_use', 'tool_result', 'file_change'].includes(event?.type)) {
      dropped += 1;
    }
    return true;
  }, { includeMessageBodies: true });
  const transcript = [
    ...transcriptParts,
    ...(omittedMessages > 0
      ? [`[Ragent note: ${omittedMessages} additional message(s) were omitted while dropping tool results to keep the context bounded.]`]
      : []),
  ].join('\n\n');

  await clearPersistedResumeIds(sessionId);
  if (transcript.trim()) {
    const snapshot = await getHistorySnapshot(sessionId);
    await setContextHead(sessionId, {
      mode: 'summary',
      summary: `[Previous conversation — tool results removed]\n\n${transcript}`,
      activeFromSeq: snapshot.latestSeq,
      compactedThroughSeq: snapshot.latestSeq,
      updatedAt: nowIso(),
      source: 'drop_tool_use',
    });
  } else {
    await clearContextHead(sessionId);
  }

  const dropEvent = statusEvent(`Tool results dropped — ${dropped} tool events removed from context, ${kept} messages kept`);
  await appendEvent(sessionId, dropEvent);
  broadcastSessionInvalidation(sessionId);
  return true;
}

export async function compactSession(sessionId) {
  const session = await getSession(sessionId);
  if (!session) return false;
  if (getSessionQueueCount(session) > 0) return false;
  const runId = getSessionRunId(session);
  if (runId) {
    const run = await getRun(runId);
    if (run && !isTerminalRunState(run.state)) return false;
  }
  return queueContextCompaction(sessionId, session, null, { automatic: false }, getCompactionServices());
}

export function killAll() {
  scopedMessageEpoch += 1;
  for (const timer of scopedMessageTimers.values()) clearTimeout(timer);
  scopedMessageTimers.clear();
  for (const sessionId of sessionRuntimeStateById.keys()) {
    clearFollowUpFlushTimer(sessionId);
  }
  sessionRuntimeStateById.clear();
  timelineInvalidationGeneration.clear();
  runtimeStateReleaseInFlight.clear();
  stopSessionRuntimeStateSweep();
  timelineBundleSkipReasons.clear();
  for (const runId of observedRuns.keys()) {
    stopObservedRun(runId);
  }
}

export {
  hasPendingRunApproval as __hasPendingRunApprovalForTest,
  yieldHarnessRunBudget as __yieldHarnessRunBudgetForTest,
  resumeHarnessRunBudget as __resumeHarnessRunBudgetForTest,
  harnessRunLeases as __harnessRunLeasesForTest,
  yieldedRunLeaseIds as __yieldedRunLeaseIdsForTest,
};
