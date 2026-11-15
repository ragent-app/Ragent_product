#!/usr/bin/env node
// A Claude tool-input replacement. It forwards data to the run-bound local
// control plane and waits for the original broker request's durable outcome.
import { setTimeout as delay } from 'node:timers/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runWindowsUserInstallBridge } from '../chat/windows-user-install-bridge.mjs';

export async function runWindowsInstallBridge({ argv = process.argv, env = process.env, fetchImpl = fetch,
  runUser = runWindowsUserInstallBridge, writeOutput = (value) => process.stdout.write(value) } = {}) {
  let input;
  try { input = JSON.parse(Buffer.from(argv[2] || '', 'base64url').toString('utf8')); } catch { throw new Error('Invalid installation request'); }
  if (!input || typeof input.command !== 'string' || input.command.length > 8192 || !/^gate:[a-f0-9]{64}$/.test(input.requestKey || '')) throw new Error('Invalid installation request');
  const endpoint = new URL(env.RAGENT_APPROVED_ACTIONS_ENDPOINT || '');
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/api/internal/approved-actions/propose' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Installation control channel is unavailable');
  const token = env.RAGENT_APPROVED_ACTIONS_TOKEN || '';
  const sessionId = env.RAGENT_APPROVED_ACTIONS_SESSION_ID || '';
  const runId = env.RAGENT_APPROVED_ACTIONS_RUN_ID || '';
  const turnId = env.RAGENT_APPROVED_ACTIONS_TURN_ID || '';
  if (!token || !sessionId || !runId || !turnId) throw new Error('Installation control channel is not bound to this run');
  const body = JSON.stringify({ requestKey: input.requestKey, sessionId, runId, turnId, actions: [{ command: input.command }] });
  const deadline = Date.now() + 10 * 60_000;
  let statusOnly = false;
  while (Date.now() < deadline) {
    let response;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
        headers: { 'content-type': 'application/json', 'x-ragent-approved-action-token': token },
        body: statusOnly ? JSON.stringify({ ...JSON.parse(body), autoInstallStatusOnly: true }) : body });
    } catch {
      // A broken response may follow a successful submission. Never submit a
      // second installation; poll only the original run-bound request.
      statusOnly = true;
      await delay(2000);
      continue;
    }
    let raw;
    try { raw = await response.text(); }
    catch {
      // Headers can arrive before the response body is interrupted, after the
      // broker has already claimed the request. Poll; never resubmit it.
      statusOnly = true;
      await delay(2000);
      continue;
    }
    if (raw.length > 65536) throw new Error('Invalid installation control response');
    let result;
    try { result = JSON.parse(raw); } catch { throw new Error('Invalid installation control response'); }
    if (!response.ok) {
      if (!statusOnly && ['AUTO_INSTALL_OUTCOME_UNKNOWN', 'MSI_INSTALL_OUTCOME_UNKNOWN'].includes(result?.code)) {
        statusOnly = true;
        await delay(2000);
        continue;
      }
      throw new Error(result?.error || result?.code || 'Installation request was rejected');
    }
    if (result.kind === 'automatic_user_install_authorization') {
      const rpc = async (extra) => {
        const reply = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
          headers: { 'content-type': 'application/json', 'x-ragent-approved-action-token': token },
          body: JSON.stringify({ ...JSON.parse(body), ...extra }) });
        if (!reply.ok) throw new Error('User installation control request failed');
        const text = await reply.text();
        if (text.length > 65536) throw new Error('Invalid user installation control response');
        return JSON.parse(text);
      };
      const outcome = await runUser({ capability: result.capability, pinnedIdentity: input.windowsUserInstallIdentity,
        binding: { sessionId, runId, turnId, requestKey: input.requestKey }, cwd: process.cwd(), request: rpc });
      if (outcome?.status === 'succeeded') { writeOutput('Installation completed successfully.\n'); return; }
      if (outcome?.status === 'failed') throw new Error(`Installation failed: ${outcome.code || 'USER_INSTALL_FAILED'}`);
      throw new Error(`Installation outcome is unknown; use request key ${input.requestKey} to check before retrying`);
    }
    if (result.kind !== 'automatic_install') throw new Error('Installation requires a separate approval; it was not automatically executed');
    if (result.status === 'succeeded') { writeOutput('Installation completed successfully.\n'); return; }
    if (result.status === 'failed') throw new Error(`Installation failed: ${result.code || 'AUTO_INSTALL_FAILED'}`);
    if (result.status !== 'executing') throw new Error(`Installation outcome is unknown; use request key ${input.requestKey} to check before retrying`);
    statusOnly = true;
    await delay(2000);
  }
  throw new Error(`Installation outcome is unknown; use request key ${input.requestKey} to check before retrying`);
}

let isMain = false;
try { isMain = Boolean(process.argv[1]) && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url)); } catch {}
if (isMain) runWindowsInstallBridge().catch((error) => { process.stderr.write(`${error?.message || 'Installation failed'}\n`); process.exitCode = 1; });
