// Translate the stable external-harness event vocabulary into Ragent's
// existing normalized event vocabulary. The bridge is deliberately stateless:
// lifecycle ownership, persistence, approvals and terminal Run transitions
// remain with the control plane.

import {
  approvalRequestEvent,
  approvalResponseEvent,
  fileChangeEvent,
  messageEvent,
  reasoningEvent,
  statusEvent,
  textDeltaEvent,
  toolResultEvent,
  toolUseEvent,
  usageEvent,
} from './normalizer.mjs';
import { acceptHarnessEvent } from './harness-contract.mjs';
import {
  normalizeProviderToolLifecycle,
  readProviderToolCallId,
  serializeProviderToolValue,
} from './provider-tool-normalization.mjs';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function payloadOf(event) {
  return object(event?.data || event?.payload || event);
}

function metadata(event, context) {
  const source = text(context?.source || event?.source) || 'external-harness';
  return {
    source,
    ...(text(context?.provider || event?.provider) ? { provider: text(context?.provider || event.provider) } : {}),
    ...(text(context?.runtimeFamily || event?.runtimeFamily)
      ? { runtimeFamily: text(context?.runtimeFamily || event.runtimeFamily) }
      : {}),
    ...(text(event?.eventId || event?.id) ? { harnessEventId: text(event.eventId || event.id) } : {}),
    ...(Number.isInteger(event?.seq) ? { harnessSeq: event.seq } : {}),
    ...(text(event?.runId || context?.runId) ? { harnessRunId: text(event.runId || context.runId) } : {}),
    ...(text(event?.turnId || context?.turnId) ? { harnessTurnId: text(event.turnId || context.turnId) } : {}),
  };
}

function contentOf(data) {
  return text(data.content || data.text || data.message || data.delta || data.output);
}

function numberFields(data, keys) {
  const result = {};
  for (const key of keys) {
    const value = Number(data[key]);
    if (Number.isFinite(value)) result[key] = value;
  }
  return result;
}

/**
 * Convert one Harness Adapter Contract event into zero or one existing
 * normalized Ragent event. Unknown/empty events are ignored intentionally;
 * the adapter contract validator handles declaration errors separately.
 */
export function bridgeHarnessEvent(event, context = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const type = text(event.type);
  const data = payloadOf(event);
  const extra = metadata(event, context);
  const providerToolUseId = readProviderToolCallId(event, data);
  const toolExtra = {
    ...extra,
    ...(providerToolUseId ? { providerToolUseId } : {}),
  };

  switch (type) {
    case 'run.started':
      return statusEvent(contentOf(data) || 'Run started', extra);
    case 'turn.started':
      return statusEvent(contentOf(data) || 'Thinking', extra);
    case 'assistant.delta':
      return textDeltaEvent(
        Number.isInteger(data.blockIndex) ? data.blockIndex : 0,
        contentOf(data),
        extra,
      );
    case 'assistant.message':
      return messageEvent('assistant', contentOf(data), undefined, extra);
    case 'reasoning.delta':
      return reasoningEvent(contentOf(data), {
        ...extra,
        providerBlockId: text(data.blockId || data.block_id || event.id || event.eventId) || 'thinking:0',
        blockIndex: Number.isInteger(data.blockIndex) ? data.blockIndex : 0,
        providerLifecycle: 'delta',
        reasoningLifecycle: 'delta',
        operationLifecycle: 'delta',
        state: 'running',
      });
    case 'tool.started':
      return toolUseEvent(
        text(data.toolName || data.name) || 'tool',
        data.input ?? data.arguments ?? data.command ?? '',
        { ...toolExtra, operationLifecycle: 'started' },
      );
    case 'tool.approval_required':
      return approvalRequestEvent({
        approvalId: data.approvalId || data.id,
        providerRequestId: data.providerRequestId,
        providerMethod: data.providerMethod,
        kind: data.kind,
        title: data.title || data.toolName || data.name,
        reason: data.reason || data.description,
        command: data.command,
        cwd: data.cwd,
        filePaths: data.filePaths,
        grantRoot: data.grantRoot,
        permissions: data.permissions,
        status: data.status || 'pending',
        source: extra.source,
        questions: data.questions,
        options: data.options,
        risk: data.risk,
        explanation: data.explanation,
        ...toolExtra,
      });
    case 'approval.responded':
      return approvalResponseEvent({
        approvalId: data.approvalId || data.id,
        decision: data.decision || data.status,
        status: data.status,
        providerRequestId: data.providerRequestId,
        providerMethod: data.providerMethod,
        source: extra.source,
        ...toolExtra,
      });
    case 'tool.progress':
      return toolResultEvent(
        text(data.toolName || data.name) || 'tool',
        serializeProviderToolValue(data.output ?? data.result ?? data.content ?? data.message ?? data.delta ?? ''),
        undefined,
        { ...toolExtra, operationLifecycle: 'delta' },
      );
    case 'tool.completed': {
      const exitCode = Number.isFinite(Number(data.exitCode)) ? Number(data.exitCode) : (data.error ? 1 : 0);
      const lifecycle = data.error || exitCode !== 0
        ? 'failed'
        : normalizeProviderToolLifecycle(data.status || data.lifecycle || 'completed', { update: true });
      return toolResultEvent(
        text(data.toolName || data.name) || 'tool',
        serializeProviderToolValue(data.output ?? data.result ?? data.error ?? ''),
        exitCode,
        { ...toolExtra, operationLifecycle: lifecycle === 'delta' ? 'completed' : lifecycle },
      );
    }
    case 'file.changed':
      return fileChangeEvent(
        text(data.filePath || data.path),
        data.changeType || data.kind || 'update',
        data,
        toolExtra,
      );
    case 'usage.updated':
      return usageEvent({
        ...numberFields(data, [
          'contextTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens',
          'reasoningTokens', 'costUsd', 'estimatedCostUsd', 'contextWindowTokens',
        ]),
        estimatedCostModel: data.estimatedCostModel,
        contextSource: data.contextSource,
        costSource: data.costSource,
        provider: extra.provider,
        runtimeFamily: extra.runtimeFamily,
        providerSessionId: data.providerSessionId,
      });
    case 'run.waiting':
      return statusEvent(contentOf(data) || 'Run waiting', extra);
    case 'run.cancel_requested':
      return statusEvent(contentOf(data) || 'Cancellation requested', { ...extra, runState: 'cancelling', cancelRequested: true });
    case 'run.cancel_acknowledged':
      return statusEvent(contentOf(data) || 'Cancellation acknowledged', { ...extra, runState: 'cancelled', cancelAcknowledged: true });
    case 'run.resumed':
      return statusEvent(contentOf(data) || 'Run resumed', {
        ...extra,
        runState: 'running',
        resumeAnchor: data.resumeAnchor || data.anchor || data.checkpoint || undefined,
      });
    case 'checkpoint.created':
      return statusEvent(contentOf(data) || 'Checkpoint created', {
        ...extra,
        checkpoint: data.checkpoint || data.resumeAnchor || data.anchor || undefined,
      });
    case 'artifact.created':
    case 'artifact.published': {
      const artifactId = text(data.artifactId || data.id);
      const filePath = text(data.filePath || data.path);
      if (filePath) {
        return fileChangeEvent(filePath, 'update', data, {
          ...extra,
          artifactId,
          artifactState: type === 'artifact.published' ? 'published' : 'created',
          sha256: text(data.sha256 || data.digest) || undefined,
          mimeType: text(data.mimeType) || undefined,
          sizeBytes: Number.isFinite(Number(data.sizeBytes)) ? Number(data.sizeBytes) : undefined,
        });
      }
      return statusEvent(`${type === 'artifact.published' ? 'Artifact published' : 'Artifact created'}${artifactId ? `: ${artifactId}` : ''}`, {
        ...extra,
        artifactId,
        artifactState: type === 'artifact.published' ? 'published' : 'created',
        artifact: data.artifact || data,
      });
    }
    case 'run.completed':
      return statusEvent(contentOf(data) || 'completed', { ...extra, runState: 'completed' });
    case 'run.failed':
      return statusEvent(`error: ${contentOf(data) || 'Run failed'}`, { ...extra, runState: 'failed' });
    case 'run.cancelled':
      return statusEvent(contentOf(data) || 'cancelled', { ...extra, runState: 'cancelled' });
    default:
      return null;
  }
}

export function bridgeHarnessEvents(events, context = {}) {
  const ledger = context?.ledger;
  const bridgeContext = { ...context };
  delete bridgeContext.ledger;
  const accepted = (Array.isArray(events) ? events : []).map((event) => {
    if (!ledger) return event;
    const result = acceptHarnessEvent(event, ledger);
    return result.accepted ? result.event : null;
  }).filter(Boolean);
  return accepted
    .map((event) => bridgeHarnessEvent(event, bridgeContext))
    .filter(Boolean);
}
