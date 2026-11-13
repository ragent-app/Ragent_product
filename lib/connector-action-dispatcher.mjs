import { sanitizeEmailCompletionTargets, dispatchSessionEmailCompletionTargets } from './agent-mail-completion-targets.mjs';
import { createHash } from 'node:crypto';
import { createCalendarEvent, findCalendarEventReceipt } from './connector-calendar.mjs';
import { dispatchCalendarToFeed } from './connector-calendar-feed.mjs';
import { createConnectorActionResult } from './connector-state.mjs';
import { getRun, updateRun } from '../chat/runs.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTargetType(target) {
  return trimString(target?.type || target?.kind).toLowerCase() || 'email';
}

function sanitizeCalendarTarget(target, index) {
  const title = trimString(target?.title || target?.summary);
  if (!title) return null;
  const id = trimString(target?.id) || `calendar_target_${index + 1}`;
  return {
    id,
    type: 'calendar',
    enabled: target?.enabled !== false,
    requestId: trimString(target?.requestId),
    bindingId: trimString(target?.bindingId),
    title,
    startTime: trimString(target?.startTime || target?.start),
    endTime: trimString(target?.endTime || target?.end),
    location: trimString(target?.location),
    description: trimString(target?.description),
    calendarId: trimString(target?.calendarId),
    timezone: trimString(target?.timezone),
    credentialsPath: trimString(target?.credentialsPath),
    reminders: target?.reminders,
    reminderMinutesBefore: target?.reminderMinutesBefore,
  };
}

export function sanitizeCompletionTargets(targets = []) {
  if (!Array.isArray(targets)) return [];
  return targets
    .map((target, index) => {
      const type = normalizeTargetType(target);
      if (type === 'email') return null;
      if (type === 'calendar') return sanitizeCalendarTarget(target, index);
      return null;
    })
    .filter(Boolean);
}

export function sanitizeAllCompletionTargets(targets = []) {
  if (!Array.isArray(targets)) return [];
  const emailTargets = sanitizeEmailCompletionTargets(targets);
  const otherTargets = sanitizeCompletionTargets(targets);
  return [...emailTargets, ...otherTargets];
}

function groupTargetsByType(targets) {
  const groups = new Map();
  for (const target of targets) {
    const type = normalizeTargetType(target);
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(target);
  }
  return groups;
}

async function dispatchCalendarTarget(target, { sessionId, runId, baseUrl } = {}) {
  const actionDigest = createHash('sha256').update(JSON.stringify({ sessionId, runId, target })).digest('hex');
  const eventId = createHash('sha256').update(JSON.stringify([sessionId, runId, target.id])).digest('hex');
  try {
    const result = target.bindingId && target.credentialsPath
      ? await createCalendarEvent({
          bindingId: target.bindingId,
          credentialsPath: target.credentialsPath,
          title: target.title,
          startTime: target.startTime,
          endTime: target.endTime,
          description: target.description,
          location: target.location,
          calendarId: target.calendarId,
          timezone: target.timezone,
          reminderMinutesBefore: target.reminderMinutesBefore,
          eventId,
          actionDigest,
        })
      : await dispatchCalendarToFeed(target, { sessionId, runId, baseUrl });
    return {
      id: target.id,
      connectorId: 'calendar',
      state: result.deliveryState === 'delivered' ? 'sent' : 'failed',
      result,
    };
  } catch (error) {
    if (target.bindingId && target.credentialsPath) {
      const receipt = await findCalendarEventReceipt({ bindingId: target.bindingId, credentialsPath: target.credentialsPath,
        calendarId: target.calendarId, eventId, actionDigest }).catch(() => null);
      if (receipt) return { id: target.id, connectorId: 'calendar', state: 'sent', result: receipt };
    }
    return {
      id: target.id,
      connectorId: 'calendar',
      state: 'unknown_outcome',
      error: error.message,
      result: createConnectorActionResult({
        actionId: target.id,
        connectorId: 'calendar',
        bindingId: target.bindingId,
        capabilityState: target.bindingId ? 'ready' : 'connector_unavailable',
        deliveryState: 'unknown_outcome',
        retryable: false,
        message: `Calendar delivery could not be confirmed: ${error.message}`,
      }),
    };
  }
}

export async function dispatchSessionConnectorActions(session, run, options = {}) {
  const allTargets = sanitizeAllCompletionTargets(session?.completionTargets || []);
  if (!session?.id || !run?.id || allTargets.length === 0) {
    return [];
  }

  const grouped = groupTargetsByType(allTargets);
  const results = [];

  const emailTargets = grouped.get('email') || [];
  if (emailTargets.length > 0) {
    const emailSession = {
      ...session,
      completionTargets: emailTargets,
    };
    const emailResults = await dispatchSessionEmailCompletionTargets(emailSession, run, options);
    results.push(...emailResults.map((result) => ({
      ...result,
      connectorId: 'email',
    })));
  }

  const calendarTargets = grouped.get('calendar') || [];
  for (const target of calendarTargets) {
    if (!target.enabled) continue;
    let claimed = false;
    await updateRun(run.id, (existing) => {
      const previous = existing.completionTargets?.[target.id];
      if (['sending', 'sent', 'unknown_outcome'].includes(previous?.state)
          || (previous?.state === 'failed' && previous.safeToRetry !== true)) return existing;
      claimed = true;
      return { ...existing, completionTargets: { ...(existing.completionTargets || {}),
        [target.id]: { ...previous, state: 'sending', startedAt: new Date().toISOString() } } };
    });
    if (!claimed) {
      const latest = await getRun(run.id);
      const previous = latest?.completionTargets?.[target.id];
      if (previous?.state === 'failed' && previous.safeToRetry !== true) {
        await updateRun(run.id, (existing) => {
          const current = existing.completionTargets?.[target.id];
          if (current?.state !== 'failed' || current.safeToRetry === true) return existing;
          return { ...existing, completionTargets: { ...existing.completionTargets,
            [target.id]: { ...current, state: 'unknown_outcome', lastError: 'Earlier calendar failure did not establish the external outcome.' } } };
        });
        continue;
      }
      if (['sending', 'unknown_outcome'].includes(previous?.state) && target.bindingId && target.credentialsPath) {
        const actionDigest = createHash('sha256').update(JSON.stringify({ sessionId: session.id, runId: run.id, target })).digest('hex');
        const eventId = createHash('sha256').update(JSON.stringify([session.id, run.id, target.id])).digest('hex');
        const receipt = await findCalendarEventReceipt({ bindingId: target.bindingId, credentialsPath: target.credentialsPath,
          calendarId: target.calendarId, eventId, actionDigest }).catch(() => null);
        if (receipt) {
          await updateRun(run.id, (existing) => {
            const current = existing.completionTargets?.[target.id];
            if (!['sending', 'unknown_outcome'].includes(current?.state) || current.startedAt !== previous.startedAt) return existing;
            return { ...existing, completionTargets: { ...existing.completionTargets,
              [target.id]: { ...current, state: 'sent', delivery: receipt, lastError: null } } };
          });
          results.push({ id: target.id, connectorId: 'calendar', state: 'sent', result: receipt });
          continue;
        }
      }
      if (previous?.state === 'sending' && Date.now() - Date.parse(previous.startedAt || '') > 60000) {
        await updateRun(run.id, (existing) => {
          const current = existing.completionTargets?.[target.id];
          if (current?.state !== 'sending' || current.startedAt !== previous.startedAt) return existing;
          return { ...existing, completionTargets: { ...existing.completionTargets,
            [target.id]: { ...current, state: 'unknown_outcome', lastError: 'Calendar result requires verification before retry.' } } };
        });
      }
      continue;
    }
    const calResult = await dispatchCalendarTarget(target, {
      sessionId: session.id,
      runId: run.id,
      baseUrl: trimString(options?.baseUrl),
    });
    await updateRun(run.id, (existing) => ({ ...existing, completionTargets: {
      ...existing.completionTargets, [target.id]: { ...existing.completionTargets?.[target.id],
        state: calResult.state, safeToRetry: calResult.state === 'failed', delivery: calResult.result, lastError: calResult.error || null },
    } }));
    results.push(calResult);
  }

  return results;
}
