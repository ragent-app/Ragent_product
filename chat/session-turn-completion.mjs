import { normalizeReplyPublicationResponseIds } from './reply-publication.mjs';
import { withMessageTimelineIdentity } from './message-timeline.mjs';
import { mutateSessionMeta } from './session-meta-store.mjs';
import { classifyOrchestrationOutput } from './orchestration-ingress.mjs';
import {
  buildMergedSuggestionSessionMeta,
  isMergedSuggestionEnabled,
  isSuggestionKindEnabled,
  triggerSessionMergedSuggestion,
} from './summarizer.mjs';
import {
  shouldContinueGoal,
  buildGoalContinuationPrompt,
  normalizeSessionGoal,
  applyGoalSnapshot,
  GOAL_CONTINUE_INTERNAL_OPERATION,
  MAX_GOAL_CONTINUATIONS,
  isPromptGoalRuntimeFamily,
  isGoalAchievementHeuristicHit,
  synthesizePromptGoalSnapshot,
} from './session-goal.mjs';

const STARTUP_COMPLETION_SCAN_BATCH_SIZE = 32;

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

export function createSessionTurnCompletionHelpers(services) {
  const {
    REPLY_SELF_CHECK_ACCEPT_STATUS,
    REPLY_SELF_CHECK_DEFAULT_REASON,
    REPLY_SELF_CHECK_REVIEWING_STATUS,
    REPLY_SELF_REPAIR_INTERNAL_OPERATION,
    allowsSessionTurnCompletionEffects,
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
    dispatchSessionConnectorActions,
    dispatchSessionEmailCompletionTargets,
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
    publishDelegatedResult,
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
    sanitizeAllCompletionTargets,
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
  } = services;

  // Injectable for factory-level tests; falls back to the module import.
  const mutateSessionMetaFn = services.mutateSessionMeta || mutateSessionMeta;
  const goalContinuationInFlight = new Map();

  function trimString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function hasNativeSteerEntries(run) {
    const queue = Array.isArray(run?.appServerSteerQueue) ? run.appServerSteerQueue : [];
    return queue.some((entry) => (
      !!trimString(entry?.id)
      || !!trimString(entry?.requestId)
      || !!trimString(entry?.text)
    ));
  }

  function getReplyPublicationRootRunId(run) {
    return trimString(run?.replyPublicationRootRunId) || trimString(run?.id);
  }

  async function updateReplyPublication(run, updater) {
    const rootRunId = getReplyPublicationRootRunId(run);
    if (!rootRunId || typeof updater !== 'function') return null;
    return updateRun(rootRunId, (existing) => {
      const current = existing?.replyPublication && typeof existing.replyPublication === 'object'
        ? existing.replyPublication
        : {
            responseIds: normalizeReplyPublicationResponseIds([], trimString(existing?.responseId || existing?.requestId || run?.responseId || run?.requestId)),
            state: 'running',
            resolution: '',
            rootRunId,
            finalRunId: rootRunId,
            continuationRunIds: [],
            updatedAt: nowIso(),
            readyAt: null,
            failedAt: null,
            lastError: null,
          };
      const next = updater(current, existing);
      if (!next || typeof next !== 'object') {
        return existing;
      }
      return {
        ...existing,
        replyPublication: {
          ...current,
          ...next,
          responseIds: normalizeReplyPublicationResponseIds(
            next.responseIds,
            trimString(existing?.responseId || existing?.requestId || run?.responseId || run?.requestId),
          ),
          updatedAt: trimString(next.updatedAt) || nowIso(),
        },
      };
    });
  }

  async function queueSessionCompletionTargets(session, run, manifest) {
    if (!session?.id || !run?.id) return false;
    if (manifest?.internalOperation && !isReplySelfRepairOperation(manifest)) return false;
    if (isReplySelfRepairOperation(manifest)) {
      const rootRunId = getReplyPublicationRootRunId(run);
      const rootRun = rootRunId && rootRunId !== run.id
        ? await getRun(rootRunId)
        : run;
      const publication = rootRun?.replyPublication;
      if (!publication || trimString(publication.state).toLowerCase() !== 'ready') {
        return false;
      }
      if (trimString(publication.finalRunId) !== trimString(run.id)) {
        return false;
      }
    } else {
      const publication = run?.replyPublication;
      if (!publication || trimString(publication.state).toLowerCase() !== 'ready') {
        return false;
      }
      if (trimString(publication.finalRunId) !== trimString(run.id)) {
        return false;
      }
    }
    const targets = sanitizeAllCompletionTargets(session.completionTargets || []);
    if (targets.length === 0) return false;
    dispatchSessionConnectorActions({
      ...session,
      completionTargets: targets,
    }, run).catch((error) => {
      console.error(`[connector-action-dispatcher] ${session.id}/${run.id}: ${error.message}`);
    });
    return true;
  }

  async function maybeSendSessionCompletionPush(sessionId, fallbackSession = null, terminalRun = null) {
    const currentSession = await getSession(sessionId) || fallbackSession;
    if (!currentSession?.id) return false;
    if (isSessionRunning(currentSession)) return false;
    if (getSessionQueueCount(currentSession) > 0) return false;
    const runId = String(terminalRun?.id || terminalRun?.runId || '').trim();
    // A run that landed in "waiting_user" has not finished from the user's
    // perspective: it is blocked on an approval or a question. Push that as an
    // attention notification instead of a completion, so the user knows they
    // must respond. Otherwise fall back to the completion push.
    const normalizedWaiting = String(currentSession?.workflowState || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const isWaiting = ['waiting', 'waiting_user', 'waiting_for_user', 'waiting_on_user', 'needs_user', 'needs_input'].includes(normalizedWaiting);
    if (isWaiting && typeof sendUserAttentionPush === 'function') {
      sendUserAttentionPush({ ...currentSession, id: sessionId }, { kind: 'attention', key: 'waiting_user', label: 'needs your attention', runId }).catch(() => {});
      return true;
    }
    sendCompletionPush({ ...currentSession, id: sessionId }, { runId, eventId: runId }).catch(() => {});
    return true;
  }

  async function resumePendingCompletionTargets({ targetSessionIds = null, batchSize = STARTUP_COMPLETION_SCAN_BATCH_SIZE } = {}) {
    const sessionFilter = targetSessionIds instanceof Set ? targetSessionIds : null;
    if (sessionFilter && sessionFilter.size === 0) return 0;
    // Startup completion recovery only needs terminal Runs. Prefer the
    // durable summary index so a restart does not hydrate every Run status
    // file (which is especially expensive after large fan-out sessions).
    // Factory tests and older callers may not inject the index helper, so keep
    // the previous id-only scan as a compatibility fallback.
    const indexedRuns = typeof listRunIndexEntries === 'function'
      ? await listRunIndexEntries({
        states: ['completed', 'failed', 'cancelled'],
        reverse: true,
      })
      : null;
    const candidates = indexedRuns || (await listRunIds()).map((id) => ({ id }));
    const runIds = candidates
      .filter((entry) => {
        if (!sessionFilter) return true;
        const indexedSessionId = trimString(entry?.sessionId);
        return !indexedSessionId || sessionFilter.has(indexedSessionId);
      })
      .map((entry) => trimString(entry?.id))
      .filter(Boolean);
    const safeBatchSize = Number.isInteger(batchSize) && batchSize > 0
      ? batchSize
      : STARTUP_COMPLETION_SCAN_BATCH_SIZE;
    let queued = 0;
    for (let index = 0; index < runIds.length; index += 1) {
      if (index > 0 && index % safeBatchSize === 0) await yieldToEventLoop();
      const runId = runIds[index];
      const run = await getRun(runId);
      if (!run || !isTerminalRunState(run.state)) continue;
      if (sessionFilter && !sessionFilter.has(run.sessionId)) continue;
      const session = await getSession(run.sessionId);
      if (!session?.completionTargets?.length) continue;
      const manifest = await getRunManifest(runId);
      if (manifest?.internalOperation && !isReplySelfRepairOperation(manifest)) continue;
      await queueSessionCompletionTargets(session, run, manifest);
      queued += 1;
    }
    return queued;
  }

  function normalizeReplySelfCheckSetting(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return 'all';
    if (['0', 'false', 'off', 'disabled', 'disable', 'none'].includes(normalized)) {
      return 'off';
    }
    if (['1', 'true', 'on', 'enabled', 'enable', 'all'].includes(normalized)) {
      return 'all';
    }
    return normalized;
  }

  function buildReplySelfCheckReviewingOperation() {
    return contextOperationEvent({
      operation: 'continue_turn',
      phase: 'queued',
      trigger: 'automatic',
      title: 'Automatic continuation reviewing',
      summary: 'Ragent is checking whether the latest reply stopped too early.',
    });
  }

  function buildReplySelfCheckSkippedOperation(title, summary, reason = '') {
    return contextOperationEvent({
      operation: 'continue_turn',
      phase: 'skipped',
      trigger: 'automatic',
      title,
      summary,
      reason,
    });
  }

  function buildReplySelfCheckAppliedOperation(reason = '') {
    return contextOperationEvent({
      operation: 'continue_turn',
      phase: 'applied',
      trigger: 'automatic',
      title: 'Automatic continuation started',
      summary: 'Ragent launched a follow-up turn to finish avoidable unfinished work.',
      reason,
    });
  }

  function buildReplySelfCheckFailedOperation(title, summary, reason = '') {
    return contextOperationEvent({
      operation: 'continue_turn',
      phase: 'failed',
      trigger: 'automatic',
      title,
      summary,
      reason,
    });
  }

  async function shouldRunReplySelfCheck(session, run, manifest) {
    if (!session?.id || !run?.id) return false;
    if (manifest?.internalOperation) return false;
    const interactionMode = trimString(manifest?.options?.interactionMode).toLowerCase();
    const planAction = trimString(manifest?.options?.planAction).toLowerCase();
    if (interactionMode === 'plan' || planAction === 'revise') return false;
    if (isInternalSession(session)) return false;
    // Reply self-check only auto-continues inside goal-chasing sessions. In any
    // other session (no goal, or a goal that is not currently chasing) the
    // assistant's reply ends the turn and the session waits for the user.
    if (session?.goal?.chasing !== true) return false;
    if (run.state !== 'completed') return false;
    // Native same-run steer intentionally changes the target reply without
    // creating a replacement run, which makes the generic self-check prone to
    // false "continue" decisions against already-correct steered output.
    if (hasNativeSteerEntries(run)) return false;
    const setting = normalizeReplySelfCheckSetting(process.env.AGENTOC_REPLY_SELF_CHECK);
    if (setting === 'off') return false;
    if (setting === 'all') return true;
    const toolDefinition = await getToolDefinitionAsync(run.tool || session.tool || '');
    if (!toolDefinition) return false;
    if (setting === 'micro-agent') {
      return toolDefinition.id === 'micro-agent' || toolDefinition.toolProfile === 'micro-agent';
    }
    const enabledTools = new Set(setting.split(',').map((entry) => entry.trim()).filter(Boolean));
    return enabledTools.has(toolDefinition.id || '') || enabledTools.has(toolDefinition.toolProfile || '');
  }

  async function prepareReplySelfCheck(sessionId, session, run, manifest) {
    if (!await shouldRunReplySelfCheck(session, run, manifest)) {
      return null;
    }
    const latestSession = await getSession(sessionId);
    if (!latestSession || latestSession.activeRunId || getSessionQueueCount(latestSession) > 0) {
      return null;
    }

    const { userMessage, assistantTurnText } = await loadReplySelfCheckTurnContext(sessionId, run.id, {
      loadSessionHistory: services.loadRecentTurnHistory || services.loadHistory,
    });
    if (!assistantTurnText) {
      return null;
    }
    if (typeof isReplySelfCheckClearlyComplete === 'function' && isReplySelfCheckClearlyComplete({
      userMessage,
      assistantTurnText,
    })) {
      return null;
    }
    if (typeof isReplySelfCheckWaitingForUser === 'function' && isReplySelfCheckWaitingForUser({
      userMessage,
      assistantTurnText,
    })) {
      return null;
    }

    await updateReplyPublication(run, (current) => ({
      ...current,
      state: 'reviewing',
      lastError: null,
    }));
    await appendEvent(sessionId, statusEvent(REPLY_SELF_CHECK_REVIEWING_STATUS));
    await appendEvent(sessionId, buildReplySelfCheckReviewingOperation());
    broadcastSessionInvalidation(sessionId);

    return {
      session: latestSession,
      userMessage,
      assistantTurnText,
    };
  }

  async function maybeRunReplySelfCheck(sessionId, session, run, manifest, preparedCheck = null) {
    if (!preparedCheck) {
      return { attempted: false, continued: false };
    }

    const { userMessage, assistantTurnText } = preparedCheck;
    const effectiveSession = preparedCheck.session || session;

    let reviewText = '';
    try {
      reviewText = await runDetachedAssistantPrompt({
        ...effectiveSession,
        id: sessionId,
        tool: run.tool || effectiveSession.tool,
        model: run.model || undefined,
        effort: run.effort || undefined,
        thinking: false,
      }, buildReplySelfCheckPrompt({ userMessage, assistantTurnText }), {
        usageTracking: {
          operation: 'reply_self_check_review',
        },
      });
    } catch (error) {
      const reason = summarizeReplySelfCheckReason(error.message, 'background reviewer error');
      await updateReplyPublication(run, (current) => ({
        ...current,
        state: 'ready',
        resolution: 'accepted_as_is',
        finalRunId: trimString(current.finalRunId) || trimString(run.id),
        readyAt: current.readyAt || nowIso(),
        failedAt: null,
        lastError: reason,
      }));
      await appendEvent(sessionId, statusEvent(`Assistant self-check: review failed — ${reason}`));
      await appendEvent(sessionId, buildReplySelfCheckFailedOperation(
        'Automatic continuation review failed',
        'Ragent could not complete the background early-stop review.',
        reason,
      ));
      broadcastSessionInvalidation(sessionId);
      return { attempted: true, continued: false };
    }

    const reviewDecision = parseReplySelfCheckDecision(reviewText);
    const refreshed = await getSession(sessionId);
    if (!refreshed || refreshed.activeRunId || getSessionQueueCount(refreshed) > 0) {
      await updateReplyPublication(run, (current) => ({
        ...current,
        state: 'ready',
        resolution: 'accepted_after_interruption',
        finalRunId: trimString(current.finalRunId) || trimString(run.id),
        readyAt: current.readyAt || nowIso(),
        failedAt: null,
        lastError: null,
      }));
      await appendEvent(sessionId, statusEvent('Assistant self-check: skipped automatic continuation because new work arrived first.'));
      await appendEvent(sessionId, buildReplySelfCheckSkippedOperation(
        'Automatic continuation skipped',
        'New work arrived before Ragent could launch the follow-up turn.',
        'new work arrived first',
      ));
      broadcastSessionInvalidation(sessionId);
      return { attempted: true, continued: false };
    }

    if (reviewDecision.action !== 'continue') {
      const reason = summarizeReplySelfCheckReason(reviewDecision.reason, 'the latest reply already finished the requested work');
      await updateReplyPublication(run, (current) => ({
        ...current,
        state: 'ready',
        resolution: 'accepted_as_is',
        finalRunId: trimString(current.finalRunId) || trimString(run.id),
        readyAt: current.readyAt || nowIso(),
        failedAt: null,
        lastError: null,
      }));
      await appendEvent(sessionId, statusEvent(REPLY_SELF_CHECK_ACCEPT_STATUS));
      await appendEvent(sessionId, buildReplySelfCheckSkippedOperation(
        'Automatic continuation not needed',
        'Ragent kept the latest reply as-is after review.',
        reason,
      ));
      broadcastSessionInvalidation(sessionId);
      return { attempted: true, continued: false };
    }

    const reason = summarizeReplySelfCheckReason(reviewDecision.reason, REPLY_SELF_CHECK_DEFAULT_REASON);
    await appendEvent(sessionId, statusEvent(`Assistant self-check: continuing automatically — ${reason}`));
    await appendEvent(sessionId, buildReplySelfCheckAppliedOperation(reason));
    broadcastSessionInvalidation(sessionId);

    try {
      const continuation = await sendMessage(sessionId, buildReplySelfRepairPrompt({
        userMessage,
        assistantTurnText,
        reviewDecision,
      }), [], {
        tool: run.tool || session.tool,
        model: run.model || undefined,
        effort: run.effort || undefined,
        thinking: !!run.thinking,
        recordUserMessage: false,
        queueIfBusy: false,
        internalOperation: REPLY_SELF_REPAIR_INTERNAL_OPERATION,
        responseId: trimString(run.responseId || run.requestId),
        replyPublicationRootRunId: getReplyPublicationRootRunId(run),
      });
      await updateReplyPublication(run, (current) => ({
        ...current,
        state: 'continuing',
        continuationRunIds: normalizeReplyPublicationResponseIds(
          [
            ...(Array.isArray(current.continuationRunIds) ? current.continuationRunIds : []),
            trimString(continuation?.run?.id),
          ],
        ),
        lastError: null,
      }));
    } catch (error) {
      const failureReason = summarizeReplySelfCheckReason(error.message, 'unable to launch follow-up reply');
      await updateReplyPublication(run, (current) => ({
        ...current,
        state: 'ready',
        resolution: 'fallback_original_after_continue_failure',
        finalRunId: trimString(current.rootRunId) || trimString(run.id),
        readyAt: current.readyAt || nowIso(),
        failedAt: null,
        lastError: failureReason,
      }));
      await appendEvent(sessionId, statusEvent(`Assistant self-check: failed to continue automatically — ${failureReason}`));
      await appendEvent(sessionId, buildReplySelfCheckFailedOperation(
        'Automatic continuation failed',
        'Ragent could not launch the follow-up turn.',
        failureReason,
      ));
      broadcastSessionInvalidation(sessionId);
      return { attempted: true, continued: false };
    }

    return { attempted: true, continued: true };
  }

  async function loadLatestTurnBodyEvents(sessionId) {
    const history = await (typeof loadRecentTurnHistory === 'function'
      ? loadRecentTurnHistory(sessionId, { includeBodies: true })
      : loadHistory(sessionId, { includeBodies: true }));
    const body = [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const event = history[index];
      if (event?.type === 'message' && event.role === 'user') {
        return body.reverse();
      }
      body.push(event);
    }
    return body.reverse();
  }

  async function reportUnresolvedResultFileReferences(sessionId, unresolved) {
    const failures = (unresolved || []).slice(0, 3);
    if (failures.length === 0) return;
    const paths = failures.map((failure) => failure.candidate).join('、');
    const extra = unresolved.length > failures.length ? ` 等 ${unresolved.length} 项` : '';
    await appendEvent(sessionId, statusEvent(
      `Auto-publish skipped ${unresolved.length} referenced file(s): ${paths}${extra}. The file may not exist, may be empty, or may be outside the allowed delivery roots. Regenerate or fix the path, then reference it again in a reply.`,
    ));
  }

  async function maybePublishRunResultAssets(sessionId, run, manifest, normalizedEvents) {
    if (manifest?.internalOperation) {
      return false;
    }
    if (await findAssistantAttachmentMessageForRun(sessionId, run.id)) {
      return false;
    }

    const unresolvedReferences = await collectUnresolvedAssistantFileReferences(manifest, normalizedEvents);

    let publishedResultAssets = Array.isArray(run?.publishedResultAssets)
      ? run.publishedResultAssets
      : [];
    let attachments = normalizePublishedResultAssetAttachments(publishedResultAssets);
    if (attachments.length === 0) {
      const generatedFiles = await collectGeneratedResultFilesFromRun(run, manifest, normalizedEvents);
      if (generatedFiles.length === 0) {
        await reportUnresolvedResultFileReferences(sessionId, unresolvedReferences);
        return false;
      }

      const publishedAssets = [];
      for (const file of generatedFiles) {
        try {
          const published = await publishLocalFileAssetFromPath({
            sessionId,
            localPath: file.localPath,
            originalName: file.originalName,
            mimeType: file.mimeType,
            createdBy: 'assistant',
          });
          publishedAssets.push({
            assetId: published.id,
            localPath: file.localPath,
            originalName: published.originalName || file.originalName,
            mimeType: published.mimeType || file.mimeType,
            ...(normalizeAttachmentSizeBytes(published.sizeBytes) ? { sizeBytes: normalizeAttachmentSizeBytes(published.sizeBytes) } : {}),
          });
        } catch (error) {
          console.error(`[result-file-assets] Failed to publish ${file.localPath}: ${error?.message || error}`);
        }
      }

      if (publishedAssets.length === 0) {
        await reportUnresolvedResultFileReferences(sessionId, unresolvedReferences);
        return false;
      }

      const updatedRun = await updateRun(run.id, (current) => ({
        ...current,
        publishedResultAssets: Array.isArray(current.publishedResultAssets) && current.publishedResultAssets.length > 0
          ? current.publishedResultAssets
          : publishedAssets,
        publishedResultAssetsAt: current.publishedResultAssetsAt || nowIso(),
      })) || run;
      publishedResultAssets = Array.isArray(updatedRun.publishedResultAssets) && updatedRun.publishedResultAssets.length > 0
        ? updatedRun.publishedResultAssets
        : publishedAssets;
      attachments = normalizePublishedResultAssetAttachments(publishedResultAssets);
    }

    if (attachments.length === 0) {
      await reportUnresolvedResultFileReferences(sessionId, unresolvedReferences);
      return false;
    }

    let didPublish = false;
    const latestTurnBodyEvents = await loadLatestTurnBodyEvents(sessionId);
    const localMarkdownImageRewrites = await collectAssistantLocalMarkdownImageRewrites(
      manifest,
      latestTurnBodyEvents,
      publishedResultAssets,
    );
    const localResultFileRewrites = await collectAssistantLocalResultFileRewrites(
      manifest,
      latestTurnBodyEvents,
      publishedResultAssets,
    );

    // Product decision (2026-08-04): no longer surface the
    // "Generated file ready to download." status line — artifact deliveries
    // render as file rows only (the attachment_delivery projection card).
    // The message is still appended with an EMPTY body so it keeps carrying
    // the published attachments and the local-path rewrite metadata; the
    // display projection hides empty-text messages whose attachments are
    // mirrored into the delivery card, so the client never renders it.
    if (!(await findResultAssetMessageForRun(sessionId, run.id))) {
      const finalMessage = [...latestTurnBodyEvents].reverse().find((event) =>
        event.type === 'message' && event.role === 'assistant' && event.runId === run.id);
      const canonicalMessageId = finalMessage ? withMessageTimelineIdentity(finalMessage).canonicalMessageId : null;
      await appendAssistantMessage(sessionId, '', [], {
        preSavedAttachments: attachments,
        source: 'result_file_assets',
        resultRunId: run.id,
        runId: run.id,
        ...(canonicalMessageId ? { canonicalMessageId, textMode: 'metadata' } : {}),
        ...(run.responseId ? { responseId: run.responseId } : {}),
        ...(localMarkdownImageRewrites.length > 0 ? { localMarkdownImageRewrites } : {}),
        ...(localResultFileRewrites.length > 0 ? { localResultFileRewrites } : {}),
        ...(run.requestId ? { requestId: run.requestId } : {}),
      });
      didPublish = true;
    }

    await reportUnresolvedResultFileReferences(sessionId, unresolvedReferences);
    return didPublish;
  }

  function scheduleSessionWorkflowStateSuggestion(session, run) {
    if (!session?.id || !run || isInternalSession(session)) {
      return false;
    }

    // DS-05: when merged suggestions are enabled, this scheduler coalesces
    // with the task-card scheduler into one model call per completed turn;
    // the per-kind trigger stays as the legacy path.
    const suggestionDone = isMergedSuggestionEnabled()
      ? triggerSessionMergedSuggestion(buildMergedSuggestionSessionMeta(session, run, {
          queuedCount: getSessionQueueCount(session),
        }))
      : triggerSessionWorkflowStateSuggestion({
          id: session.id,
          folder: session.folder,
          name: session.name || '',
          group: session.group || '',
          description: session.description || '',
          workflowState: session.workflowState || '',
          workflowPriority: session.workflowPriority || '',
          tool: run.tool || session.tool,
          model: run.model || undefined,
          thinking: false,
          runState: run.state,
          queuedCount: getSessionQueueCount(session),
        });

    suggestionDone.then(async (result) => {
      if (!isSuggestionKindEnabled('workflow-state')) return;
      const nextWorkflowState = normalizeSessionWorkflowState(result?.workflowState || '');
      const nextWorkflowPriority = normalizeSessionWorkflowPriority(result?.workflowPriority || '');
      const shouldClearWorkflowState = result?.shouldClearWorkflowState === true;
      if (!nextWorkflowState && !nextWorkflowPriority && !shouldClearWorkflowState) return;
      await updateSessionWorkflowClassification(session.id, {
        ...(nextWorkflowState || shouldClearWorkflowState ? { workflowState: nextWorkflowState } : {}),
        ...(nextWorkflowPriority || shouldClearWorkflowState ? { workflowPriority: nextWorkflowPriority } : {}),
      });
    }).catch((error) => {
      console.error(`[workflow-state] Failed to update workflow state for ${session.id?.slice(0, 8)}: ${error.message}`);
    });

    return true;
  }

  async function runSessionTurnCompletionEffects(sessionId, latestSession, finalizedRun, manifest) {
    let session = latestSession;
    let sessionChanged = false;
    const allowCompletionEffects = allowsSessionTurnCompletionEffects(manifest);

    if (allowCompletionEffects && typeof publishDelegatedResult === 'function') {
      await publishDelegatedResult({ session, finalizedRun, manifest }).catch((error) => {
        if (error?.code === 'LINUX_RUN_RESULT_UNAVAILABLE') throw error;
        console.error(`[delegation] result publication failed for ${sessionId?.slice(0, 8)}: ${error.message}`);
      });
    }

    if (isReplySelfRepairOperation(manifest)) {
      if (finalizedRun.state === 'completed') {
        await updateReplyPublication(finalizedRun, (current) => ({
          ...current,
          state: 'ready',
          resolution: 'auto_continued',
          finalRunId: trimString(finalizedRun.id),
          continuationRunIds: normalizeReplyPublicationResponseIds(
            [
              ...(Array.isArray(current.continuationRunIds) ? current.continuationRunIds : []),
              trimString(finalizedRun.id),
            ],
          ),
          readyAt: current.readyAt || nowIso(),
          failedAt: null,
          lastError: null,
        }));
      } else {
        await updateReplyPublication(finalizedRun, (current) => ({
          ...current,
          state: 'ready',
          resolution: 'fallback_original_after_continue_failure',
          finalRunId: trimString(current.rootRunId) || trimString(finalizedRun.replyPublicationRootRunId),
          readyAt: current.readyAt || nowIso(),
          failedAt: null,
          lastError: trimString(finalizedRun.failureReason),
        }));
      }
    } else if (finalizedRun.state === 'failed' || finalizedRun.state === 'cancelled') {
      await updateReplyPublication(finalizedRun, (current) => ({
        ...current,
        state: finalizedRun.state,
        resolution: '',
        finalRunId: trimString(current.finalRunId) || trimString(finalizedRun.id),
        failedAt: current.failedAt || nowIso(),
        readyAt: null,
        lastError: trimString(finalizedRun.failureReason),
      }));
    } else if (finalizedRun.state === 'completed') {
      await updateReplyPublication(finalizedRun, (current) => {
        if (trimString(current.state).toLowerCase() === 'ready') {
          return current;
        }
        return {
          ...current,
          state: 'ready',
          resolution: trimString(current.resolution) || 'accepted_as_is',
          finalRunId: trimString(current.finalRunId) || trimString(finalizedRun.id),
          readyAt: current.readyAt || nowIso(),
          failedAt: null,
          lastError: null,
        };
      });
    }

    if (allowCompletionEffects
      && finalizedRun.state === 'completed'
      && !manifest?.internalOperation
      && (typeof processRootLeadershipProposal === 'function' || typeof processCollaborationPlan === 'function')) {
      try {
        const turnContext = await loadReplySelfCheckTurnContext(sessionId, finalizedRun.id, {
          loadSessionHistory: services.loadRecentTurnHistory || loadHistory,
        });
        const assistantText = turnContext?.assistantControlText || turnContext?.assistantTurnText || '';
        const orchestration = classifyOrchestrationOutput(assistantText);
        if (orchestration.error) {
          const status = orchestration.error.code === 'ORCHESTRATION_MODE_CONFLICT'
            ? 'Root Leadership turn rejected: choose exactly one orchestration mode; no organization or collaboration was started.'
            : `Root Leadership control block rejected: ${orchestration.error.message}.`;
          await appendEvent(sessionId, statusEvent(status));
          broadcastSessionInvalidation(sessionId);
        } else if (orchestration.mode === 'organization' && typeof processRootLeadershipProposal === 'function') {
          const proposalResult = await processRootLeadershipProposal({
            session,
            assistantText,
            projectId: session?.projectId || '',
            turnId: finalizedRun.id,
          });
          if (proposalResult?.attempted) {
            const provisioning = proposalResult.provisioning || {};
            const status = proposalResult.state === 'frozen' && provisioning.state === 'provisioned'
              ? `Organization proposal frozen: Revision ${proposalResult.revision} (${proposalResult.digest}). Automatic provisioning confirmed; Managed Sessions created: ${proposalResult.createdManagedSessions || 0}.`
              : proposalResult.state === 'frozen' && provisioning.state === 'failed'
                ? `Organization proposal frozen: Revision ${proposalResult.revision} (${proposalResult.digest}). Automatic provisioning failed: ${provisioning.message || provisioning.reason || 'runtime failure'}.`
                : proposalResult.state === 'frozen'
                  ? `Organization proposal frozen: Revision ${proposalResult.revision} (${proposalResult.digest}). Provisioning has not been started.`
                  : `Organization proposal rejected: ${proposalResult.message || proposalResult.reason || 'validation failed'}.`;
            await appendEvent(sessionId, statusEvent(status));
            broadcastSessionInvalidation(sessionId);
          }
        }
      } catch (error) {
        console.error(`[orchestration] control block processing failed for ${sessionId?.slice(0, 8)}: ${error.message}`);
        await appendEvent(sessionId, statusEvent('Root Leadership orchestration could not be processed; no additional orchestration was started.'));
        broadcastSessionInvalidation(sessionId);
      }
    }

    if (allowCompletionEffects
      && finalizedRun.state === 'completed'
      && !manifest?.internalOperation
      && typeof processCollaborationPlan === 'function') {
      try {
        const turnContext = await loadReplySelfCheckTurnContext(sessionId, finalizedRun.id, {
          loadSessionHistory: services.loadRecentTurnHistory || loadHistory,
        });
        const assistantText = turnContext?.assistantControlText || turnContext?.assistantTurnText || '';
        if (classifyOrchestrationOutput(assistantText).mode === 'collaboration') {
          const collaborationResult = await processCollaborationPlan({
            session,
            assistantText,
            turnId: finalizedRun.id,
          });
          if (collaborationResult?.attempted) {
            const status = collaborationResult.state === 'rejected'
              ? `Durable Collaboration plan rejected: ${collaborationResult.message || collaborationResult.reason || 'validation failed'}.`
              : `Durable Collaboration accepted: ${collaborationResult.collaborationId}. Runtime state: ${collaborationResult.state}. Tasks: ${collaborationResult.taskCount || 0}.`;
            await appendEvent(sessionId, statusEvent(status));
            broadcastSessionInvalidation(sessionId);
          }
        }
      } catch (error) {
        console.error(`[collaboration-leader] plan processing failed for ${sessionId?.slice(0, 8)}: ${error.message}`);
        await appendEvent(sessionId, statusEvent('Durable Collaboration plan could not be processed; no collaboration was accepted.'));
      }
    }

    // The foreground assistant turn owns title generation. Its hidden control
    // block is parsed from the raw durable message and applied before queues,
    // compaction, pushes, or Goal continuation can advance the session. This
    // replaces the former post-turn second-harness request entirely.
    if (allowCompletionEffects
      && finalizedRun.state === 'completed'
      && !manifest?.internalOperation
      && typeof maybeApplyAssistantSessionLabels === 'function') {
      try {
        const labeledSession = await maybeApplyAssistantSessionLabels(
          sessionId,
          finalizedRun.id,
          session,
          services,
        );
        if (labeledSession) {
          session = labeledSession;
          sessionChanged = true;
        }
      } catch (error) {
        // Metadata is best effort and must never change a successful Run into
        // a failed one. The semantic provisional title remains usable and the
        // pending bit allows a later foreground turn to retry.
        console.error(`[session-labels] inline metadata apply failed for ${sessionId?.slice(0, 8)}: ${error.message}`);
      }
    }

    if (allowCompletionEffects) {
      const taskCardSession = await maybeApplyAssistantTaskCard(sessionId, finalizedRun.id, session, getTaskCardFollowupServices());
      if (taskCardSession) {
        session = taskCardSession;
        sessionChanged = true;
      }
    }

    const hasQueuedFollowUps = getSessionQueueCount(session) > 0;
    if (hasQueuedFollowUps) {
      scheduleQueuedFollowUpDispatch(sessionId);
    }

    const budgetApplied = allowCompletionEffects && !hasQueuedFollowUps
      ? await maybeApplyContextBudget(sessionId, session, finalizedRun, manifest, getCompactionServices())
      : false;

    if (budgetApplied) {
      return { session, sessionChanged };
    }

    if (allowCompletionEffects) {
      scheduleSessionTaskCardSuggestion(session, finalizedRun, getTaskCardFollowupServices());
    }

    if (allowCompletionEffects && !hasQueuedFollowUps) {
      await queueSessionCompletionTargets(session, finalizedRun, manifest);
      scheduleSessionWorkflowStateSuggestion(session, finalizedRun);
    }

    // Session labels are now already settled (or safely left provisional), so
    // completion delivery never waits for another provider process.
    if (allowCompletionEffects && !hasQueuedFollowUps) {
      void maybeSendSessionCompletionPush(sessionId, session, finalizedRun);
    }

    if (!hasQueuedFollowUps) {
      try {
        await maybeRunGoalContinuation(sessionId, session, finalizedRun, manifest);
      } catch (error) {
        console.error(`[goal-chase] continuation check failed for ${sessionId?.slice(0, 8)}: ${error.message}`);
      }
    }

    return { session, sessionChanged };
  }

  function isGoalDrivingTurn(manifest) {
    const op = trimString(manifest?.internalOperation);
    // Only a normal user turn (no internalOperation) or a goal_continue turn
    // feeds the chase loop. Compaction ('context_compaction[_worker]'),
    // reply-self-repair, regenerate, editResend, trigger_delivery and the
    // other internal delivery pipes are all excluded via their internalOperation tag.
    return !op || op === GOAL_CONTINUE_INTERNAL_OPERATION;
  }

  function readRunRuntimeFamily(run, manifest) {
    return trimString(
      manifest?.runtimeFamily
      || manifest?.options?.runtimeFamily
      || run?.runtimeFamily
      || run?.providerCapabilities?.runtimeFamily,
    );
  }

  function goalChaseHaltMessage(reason, goal) {
    const budget = goal && Number.isFinite(goal.tokenBudget) ? goal.tokenBudget : null;
    if (reason === 'status:completed') {
      return 'Goal chasing: the goal was reported complete — chase finished.';
    }
    if (reason === 'budget-exhausted') {
      return `Goal chasing paused: token budget reached${budget ? ` (${budget})` : ''}.`;
    }
    if (reason === 'max-continuations') {
      return `Goal chasing paused: reached the auto-continuation limit (${MAX_GOAL_CONTINUATIONS}).`;
    }
    if (reason === 'rate-limited') {
      return 'Goal chasing paused: continuations fired too quickly.';
    }
    if (reason === 'no-progress') {
      return 'Goal chasing paused: no progress detected across recent turns.';
    }
    if (typeof reason === 'string' && reason.startsWith('status:')) {
      return `Goal chasing paused: goal status is ${reason.slice('status:'.length)}.`;
    }
    return 'Goal chasing paused.';
  }

  async function clearGoalChasing(sessionId) {
    const result = await mutateSessionMetaFn(sessionId, (draft) => {
      const goal = normalizeSessionGoal(draft.goal);
      if (!goal || goal.chasing !== true) return false;
      goal.chasing = false;
      draft.goal = goal;
      draft.updatedAt = nowIso();
      return true;
    });
    if (result.changed) broadcastSessionInvalidation(sessionId);
  }

  async function claimGoalContinuation(sessionId, expectedGoal, streak) {
    let claimedGoal = null;
    const expected = normalizeSessionGoal(expectedGoal);
    const result = await mutateSessionMetaFn(sessionId, (draft) => {
      const goal = normalizeSessionGoal(draft.goal);
      // The decision and accounting update must observe the same goal version.
      // This prevents two finalizers (or a user pause/edit racing a finalizer)
      // from both launching a continuation from the same completed turn.
      if (!goal || !expected || JSON.stringify(goal) !== JSON.stringify(expected)) {
        return false;
      }
      const decision = shouldContinueGoal({ goal, nowMs: Date.now() });
      if (!decision.continue) return false;
      goal.continuationCount = (Number.isFinite(goal.continuationCount) ? goal.continuationCount : 0) + 1;
      goal.continuationLastAt = nowIso();
      goal.continuationLastTokensUsed = Number.isFinite(goal.tokensUsed) ? goal.tokensUsed : null;
      goal.continuationNoProgress = streak;
      draft.goal = goal;
      draft.updatedAt = nowIso();
      claimedGoal = goal;
      return true;
    });
    return {
      claimed: !!claimedGoal && result?.changed !== false,
      goal: claimedGoal,
    };
  }

  // Goal chasing: when a goal is in chasing mode and a goal-driving turn just
  // finalized, decide whether to auto-launch the next continuation turn.
  // Supported runtimes: codex app-server (goal snapshot mirrored from
  // thread/goal/updated at finalize) and prompt-only providers such as Claude
  // Code and AgY (snapshot synthesized here). Guardrails (count/rate/budget/no-progress)
  // live in shouldContinueGoal; any hard stop clears goal.chasing and posts a
  // status event so the user must tap "重新开始" to resume. A busy session
  // (active run or queued work) soft-skips.
  async function runGoalContinuation(sessionId, session, run, manifest, family) {
    const isCodexAppServer = family === 'codex-app-server-json';
    const isPromptGoalRuntime = isPromptGoalRuntimeFamily(family);
    if (!isCodexAppServer && !isPromptGoalRuntime) return { attempted: false };
    if (!isGoalDrivingTurn(manifest)) return { attempted: false };

    const latest = await getSession(sessionId);
    if (!latest) return { attempted: false };
    if (latest.activeRunId || getSessionQueueCount(latest) > 0) {
      return { attempted: false, skipped: 'busy' };
    }
    let goal = latest.goal;
    if (!goal || goal.enabled === false || goal.chasing !== true) {
      return { attempted: false };
    }

    // A freshly configured Codex goal starts with an empty provider snapshot.
    // Usually thread/goal/updated arrives during the turn, but older Codex
    // runtimes (and a few interrupted first turns) can finish without one.
    // Treat that missing snapshot as active rather than mistaking it for a
    // terminal state (`status: none`) and stopping the chase on turn one.
    if (isCodexAppServer && !goal.status) {
      const inferred = applyGoalSnapshot(goal, {
        status: 'in_progress',
        updatedAt: nowIso(),
      });
      if (inferred) {
        await mutateSessionMetaFn(sessionId, (draft) => {
          draft.goal = inferred;
          draft.updatedAt = nowIso();
          return true;
        });
        goal = inferred;
      }
    }

    if (isPromptGoalRuntime) {
      // Prompt-only providers have no thread/goal/updated channel: derive the
      // snapshot from the finalized turn. Usage totals feed the
      // budget/no-progress guards and the completion heuristic on the final
      // assistant text feeds the status (a missed match just continues to the
      // count/budget caps).
      let turnTokensUsed = null;
      let assistantTurnText = '';
      try {
        const turnContext = await loadReplySelfCheckTurnContext(sessionId, run.id, {
          loadSessionHistory: services.loadRecentTurnHistory || services.loadHistory,
        });
        assistantTurnText = turnContext?.assistantTurnText || '';
        turnTokensUsed = Number.isFinite(turnContext?.usage?.totalTokens)
          ? turnContext.usage.totalTokens
          : null;
      } catch (error) {
        console.error(`[goal-chase] prompt-only snapshot for ${sessionId?.slice(0, 8)}: ${error.message}`);
      }
      const synthesized = synthesizePromptGoalSnapshot(goal, {
        turnTokensUsed,
        achieved: isGoalAchievementHeuristicHit(assistantTurnText),
        updatedAt: nowIso(),
      });
      if (synthesized) {
        await mutateSessionMetaFn(sessionId, (draft) => {
          draft.goal = synthesized;
          draft.updatedAt = nowIso();
          return true;
        });
        goal = synthesized;
      }
    }

    const decision = shouldContinueGoal({ goal, nowMs: Date.now() });

    if (decision.hardStop) {
      await clearGoalChasing(sessionId);
      await appendEvent(sessionId, statusEvent(goalChaseHaltMessage(decision.reason, goal)));
      broadcastSessionInvalidation(sessionId);
      return { attempted: true, halted: decision.reason };
    }
    if (!decision.continue) {
      return { attempted: false };
    }

    // Claim the exact goal version before firing. A second finalizer that read
    // the old version loses the claim and must not clear or relaunch the chase.
    const claim = await claimGoalContinuation(sessionId, goal, decision.streak);
    if (!claim.claimed) {
      return { attempted: false, skipped: 'claim-lost' };
    }
    try {
      await sendMessage(sessionId, buildGoalContinuationPrompt(claim.goal || goal), [], {
        tool: run.tool || latest.tool,
        model: run.model || undefined,
        effort: run.effort || undefined,
        thinking: !!run.thinking,
        recordUserMessage: false,
        queueIfBusy: false,
        internalOperation: GOAL_CONTINUE_INTERNAL_OPERATION,
      });
      await appendEvent(sessionId, statusEvent('Goal chasing: continuing automatically.'));
      broadcastSessionInvalidation(sessionId);
      return { attempted: true, continued: true };
    } catch (error) {
      await clearGoalChasing(sessionId);
      await appendEvent(sessionId, statusEvent(`Goal chasing paused: could not launch the next turn — ${error?.message || 'unknown error'}.`));
      broadcastSessionInvalidation(sessionId);
      return { attempted: true, halted: 'launch-failed' };
    }
  }

  async function maybeRunGoalContinuation(sessionId, session, run, manifest) {
    const family = readRunRuntimeFamily(run, manifest);
    if (!isGoalDrivingTurn(manifest)) return { attempted: false };
    const existing = goalContinuationInFlight.get(sessionId);
    if (existing) return existing;
    const operation = runGoalContinuation(sessionId, session, run, manifest, family);
    goalContinuationInFlight.set(sessionId, operation);
    try {
      return await operation;
    } finally {
      if (goalContinuationInFlight.get(sessionId) === operation) {
        goalContinuationInFlight.delete(sessionId);
      }
    }
  }

  return {
    maybePublishRunResultAssets,
    maybeRunGoalContinuation,
    maybeRunReplySelfCheck,
    maybeSendSessionCompletionPush,
    prepareReplySelfCheck,
    queueSessionCompletionTargets,
    resumePendingCompletionTargets,
    runSessionTurnCompletionEffects,
    scheduleSessionWorkflowStateSuggestion,
  };
}
