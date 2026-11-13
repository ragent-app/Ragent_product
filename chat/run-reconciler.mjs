import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import {
  DETACHED_RUNNER_LIFECYCLE_LAUNCH_MODE,
  DETACHED_RUNNER_SYSTEMD_LAUNCH_MODE,
} from './run-launcher.mjs';
import {
  resolveRunHeartbeatStaleMs,
  shouldMarkRunStalled,
} from './run-liveness.mjs';

const execFileAsync = promisify(execFileCallback);

function parseIsoTimestampMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

export function isRecordedProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function buildSystemctlArgsForUnitScope(scope, ...args) {
  return scope === 'user'
    ? ['--user', ...args]
    : args;
}

export async function isRecordedRunnerUnitActive(unitName, unitScope, {
  execFileImpl = execFileAsync,
} = {}) {
  const normalizedUnitName = typeof unitName === 'string' ? unitName.trim() : '';
  if (!normalizedUnitName || process.platform !== 'linux') {
    return false;
  }
  try {
    const { stdout } = await execFileImpl(
      'systemctl',
      buildSystemctlArgsForUnitScope(unitScope, 'show', '--property=ActiveState', '--value', normalizedUnitName),
      { timeout: 2_000, maxBuffer: 128 * 1024 },
    );
    const state = String(stdout || '').trim();
    return state === 'active' || state === 'activating' || state === 'reloading';
  } catch {
    return false;
  }
}

export function createDetachedRunReconciler({
  appendRunSpoolRecord,
  collectRunOutputPreview,
  graceMs,
  launchGraceMs = 30_000,
  lifecycleTimeoutMs = 0,
  isTerminalRunState,
  nowIso,
  nowMs = null,
  reconcileProviderNativeDelegationRun,
  readRunSpoolRecords,
  streamRunSpoolRecords,
  onRunnerStalled,
  shouldSkipRunnerStall,
  stallAfterMs = resolveRunHeartbeatStaleMs(),
  updateRun,
  writeRunResult,
} = {}) {
  const readNowMs = typeof nowMs === 'function' ? nowMs : () => Date.now();
  return async function synthesizeDetachedRunTermination(runId, run) {
    const hasRecordedRunnerUnit = (
      run?.runnerLaunchMode === DETACHED_RUNNER_SYSTEMD_LAUNCH_MODE
      || run?.runnerLaunchMode === DETACHED_RUNNER_LIFECYCLE_LAUNCH_MODE
    )
      && typeof run?.runnerUnitName === 'string'
      && run.runnerUnitName.trim();
    const hasRecordedProcess = Number.isInteger(run?.runnerProcessId)
      || Number.isInteger(run?.toolProcessId)
      || Boolean(hasRecordedRunnerUnit);
    // Status and result are separate durable files. A host restart can land
    // between their writes, leaving the authoritative status terminal but the
    // result file absent. The status projection carries the exact result for
    // every terminal path (not only synthesized recovery), so replaying this
    // write is safe and lets the next observer finish recovery without
    // inventing a second terminal outcome.
    if (isTerminalRunState(run?.state)) {
      if (run?.result && typeof run.result === 'object') {
        await writeRunResult(runId, run.result);
        return run;
      }
      return null;
    }
    // A Run can be cancelled in the narrow window after its durable status is
    // created but before the launcher records a PID/unit.  There is then no
    // process to wait for and no runner callback left to terminalize it.  A
    // cancellation is authoritative in this case: settle it immediately so
    // the Session does not remain permanently "running"/"accepted".
    if (!hasRecordedProcess && run?.cancelRequested !== true) {
      const submittedAtMs = parseIsoTimestampMs(run?.runnerLifecycleSubmittedAt);
      if (run?.runnerLaunchState === 'lifecycle_submitting'
          && Number.isFinite(submittedAtMs)
          && readNowMs() - submittedAtMs < lifecycleTimeoutMs) return null;
      // Accepted/starting Runs can legitimately exist for a short window
      // before the launcher records its PID or unit. Once that launch window
      // expires, however, there is no owner left to produce a result; leave a
      // durable failure instead of an immortal session spinner.
      if (run?.state === 'waiting_user' || run?.state === 'queued') return null;
      const heartbeatAtMs = parseIsoTimestampMs(run?.runnerHeartbeatAt);
      const updatedAtMs = parseIsoTimestampMs(run?.updatedAt);
      const createdAtMs = parseIsoTimestampMs(run?.createdAt);
      const anchorMs = Number.isFinite(heartbeatAtMs)
        ? heartbeatAtMs
        : (Number.isFinite(updatedAtMs) ? updatedAtMs : createdAtMs);
      if (!Number.isFinite(anchorMs) || (readNowMs() - anchorMs) < launchGraceMs) {
        return null;
      }
    }

    const runnerProcessAlive = isRecordedProcessAlive(run?.runnerProcessId);
    const runnerUnitActive = !runnerProcessAlive
      ? await isRecordedRunnerUnitActive(run?.runnerUnitName, run?.runnerUnitScope)
      : false;
    const runnerAlive = runnerProcessAlive || runnerUnitActive;
    const toolAlive = isRecordedProcessAlive(run?.toolProcessId);
    if (runnerAlive || toolAlive) {
      if (
        runnerAlive
        && shouldMarkRunStalled(run, { nowMs: readNowMs(), staleAfterMs: stallAfterMs })
        && (typeof shouldSkipRunnerStall !== 'function' || !(await shouldSkipRunnerStall(run)))
        && typeof onRunnerStalled === 'function'
      ) {
        // The callback only requests cancellation and records a diagnostic;
        // normal observation remains authoritative for terminalization after
        // the sidecar exits. This avoids marking a still-live process failed
        // while it may be writing its final result.
        const heartbeatAtMs = parseIsoTimestampMs(run?.runnerHeartbeatAt)
          || parseIsoTimestampMs(run?.runnerStartedAt)
          || parseIsoTimestampMs(run?.startedAt)
          || parseIsoTimestampMs(run?.createdAt)
          || readNowMs();
        const stalledRun = await onRunnerStalled({
          runId,
          run,
          runnerProcessAlive,
          runnerUnitActive,
          toolAlive,
          heartbeatAgeMs: readNowMs() - heartbeatAtMs,
          staleAfterMs: stallAfterMs,
        });
        if (stalledRun) return stalledRun;
      }
      return null;
    }

    // A provider-native Run that has lost its detached process must replay its
    // delegation evidence before the generic missing-result synthesizer runs.
    // This is the startup/crash path: unresolved parent-process-bound children
    // become explicit `lost` facts and the parent fails as delegation_lost.
    if (
      typeof reconcileProviderNativeDelegationRun === 'function'
      && (run?.providerNativeDelegation || run?.providerExitedAt)
    ) {
      const delegated = await reconcileProviderNativeDelegationRun({
        runId,
        result: run?.result || null,
        terminalCandidate: run?.providerNativeDelegation?.terminalCandidate || null,
        providerExited: true,
        providerExitedAtMs: run?.providerNativeDelegation?.providerExitedAtMs || null,
        getRun: async () => run,
        readRunSpoolRecords,
        streamRunSpoolRecords,
        appendRunSpoolRecord,
        updateRun,
        writeRunResult,
      });
      if (delegated?.handled) return delegated.run;
    }

    const completedAt = nowIso();
    let cancelled = run?.cancelRequested === true;
    if (!cancelled) {
      const missingResultDetectedAtMs = parseIsoTimestampMs(run?.missingResultDetectedAt);
      if (!Number.isFinite(missingResultDetectedAtMs)) {
        await updateRun(runId, (current) => ({
          ...current,
          missingResultDetectedAt: current?.missingResultDetectedAt || nowIso(),
        }));
        return null;
      }
      if ((readNowMs() - missingResultDetectedAtMs) < graceMs) {
        return null;
      }
    }

    const priorFailure = typeof run?.failureReason === 'string' && run.failureReason.trim()
      ? run.failureReason.trim()
      : '';
    const preview = await collectRunOutputPreview(runId);
    const diagnostic = {
      sessionId: run?.sessionId || null,
      state: run?.state || null,
      cancelRequested: cancelled,
      runnerProcessId: run?.runnerProcessId ?? null,
      runnerUnitName: run?.runnerUnitName || null,
      runnerUnitScope: run?.runnerUnitScope || null,
      runnerLaunchMode: run?.runnerLaunchMode || null,
      runnerProcessAlive,
      runnerUnitActive,
      toolProcessId: run?.toolProcessId ?? null,
      runnerAlive,
      toolAlive,
      startedAt: run?.startedAt || null,
      updatedAt: run?.updatedAt || null,
      lastNormalizedAt: run?.lastNormalizedAt || null,
      missingResultDetectedAt: run?.missingResultDetectedAt || null,
      normalizedLineCount: Number.isInteger(run?.normalizedLineCount) ? run.normalizedLineCount : 0,
      normalizedEventCount: Number.isInteger(run?.normalizedEventCount) ? run.normalizedEventCount : 0,
      preview,
    };
    let error = null;
    let result = null;

    // updateRun is serialized per run. Make the terminal state and its result
    // the claim: competing observer/restart passes see that state and become
    // no-ops, so they cannot append duplicate diagnostics or replace a settled
    // outcome. The result file is deliberately written afterwards; the
    // terminal branch above repairs the narrow crash window idempotently.
    let claimedTerminalTransition = false;
    const reconciledRun = await updateRun(runId, (current) => {
      if (!current || isTerminalRunState(current.state)) return current;
      // The liveness checks above preceded this lock. A sidecar may have
      // claimed the Run since then; never settle using that older evidence.
      if (['runnerProcessId', 'toolProcessId', 'runnerUnitName', 'runnerUnitScope',
        'runnerLaunchState', 'runnerLifecycleAcceptedAt', 'runnerLaunchAttempt', 'runnerHeartbeatAt']
        .some(key => (current[key] ?? null) !== (run?.[key] ?? null))) return current;
      cancelled = current.cancelRequested === true;
      error = cancelled ? null : (current.failureReason || priorFailure || 'Detached runner disappeared before writing a result');
      result = { completedAt, exitCode: 1, signal: null, cancelled, reconciledMissingResult: true,
        ...(error ? { error } : {}) };
      diagnostic.cancelRequested = cancelled;
      claimedTerminalTransition = true;
      return {
        ...current,
        state: cancelled ? 'cancelled' : 'failed',
        completedAt,
        result,
        failureReason: error,
      };
    });
    if (!claimedTerminalTransition) {
      return reconciledRun?.result?.reconciledMissingResult === true
        ? reconciledRun
        : null;
    }

    console.error(`[runs] Synthesizing missing-result failure for ${runId}: ${JSON.stringify(diagnostic)}`);

    try {
      await appendRunSpoolRecord(runId, {
        ts: completedAt,
        stream: 'error',
        line: error || 'Detached runner was cancelled before writing a result',
        json: {
          type: 'run.reconciled_missing_result',
          ...diagnostic,
        },
      });
    } catch (appendError) {
      console.error(`[runs] Failed to append missing-result diagnostic for ${runId}: ${appendError.message}`);
    }
    await writeRunResult(runId, result);
    return reconciledRun;
  };
}
