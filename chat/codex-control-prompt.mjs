// Background work borrows the foreground OAuth owner through IPC. It must
// never start Codex under the control service identity or copy its credentials.
import { connect } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { codexAppServerBrokerSocketPath, codexBrokerAccountDigest, isCodexAppServerBrokerReady } from './codex-app-server-broker.mjs';
import {
  buildCodexAppServerInitializeMessage, buildCodexAppServerInitializedNotification,
  buildCodexAppServerThreadMessage, buildCodexAppServerTurnStartMessage,
  buildCodexAppServerTurnInterruptMessage, readCodexAppServerApprovalRequest,
} from './codex-app-server-protocol.mjs';
import { createCodexAppServerAdapter } from './adapters/codex-app-server.mjs';

const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 1024 * 1024;

export async function runCodexControlPrompt({
  codexHomeDir, prompt, cwd, model = '', effort = '', developerInstructions = '', expectedAccountId = '',
  timeoutMs = 180_000,
} = {}) {
  const socketPath = codexAppServerBrokerSocketPath(codexHomeDir);
  const started = Date.now();
  // Only the ordinary execution boundary may create the authenticated owner.
  // No CLI fallback when it is absent or recovering.
  if (!socketPath || !await isCodexAppServerBrokerReady(socketPath, Math.min(1500, timeoutMs))) {
    throw Object.assign(new Error('Codex background task requires the active managed provider broker'), {
      code: 'CODEX_CONTROL_BROKER_REQUIRED',
    });
  }
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const decoder = new StringDecoder('utf8');
    const adapter = createCodexAppServerAdapter();
    let buffer = '';
    let settled = false;
    let threadId = '';
    let turnId = '';
    let turnSent = false;
    let usage = null;
    const expectedAccountDigest = codexBrokerAccountDigest(expectedAccountId);
    let checkingAccount = Boolean(expectedAccountDigest);
    let outputChars = 0;
    let wireBytes = 0;
    const parts = [];
    const write = (message) => {
      if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(message)}\n`);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Interrupt only this fresh thread's turn. Never terminate the shared
      // process, retry a prompt, or cancel another caller's work.
      if (error && threadId && turnId) {
        write(buildCodexAppServerTurnInterruptMessage({ id: 9, threadId, turnId }));
      }
      socket.end();
      const closeTimer = setTimeout(() => socket.destroy(), 250);
      closeTimer.unref?.();
      socket.once('close', () => clearTimeout(closeTimer));
      if (error) reject(error);
      else resolve({ text: parts.join('\n').trim(), usage });
    };
    const timer = setTimeout(() => finish(new Error('Codex background task timed out')),
      Math.max(1, timeoutMs - (Date.now() - started)));
    timer.unref?.();
    socket.on('error', () => finish(new Error('Codex background broker connection failed')));
    socket.on('end', () => finish(new Error('Codex background broker closed before completion')));
    socket.on('close', () => finish(new Error('Codex background broker disconnected')));
    socket.once('connect', () => write(checkingAccount
      ? { type:'agentoc-codex-broker-ping', expectedAccountDigest }
      : buildCodexAppServerInitializeMessage()));
    const consume = (message, line) => {
      if (settled) return;
      if (checkingAccount) {
        if (message?.type !== 'agentoc-codex-broker-pong' || message.ready !== true || message.accountMatches !== true) {
          return finish(Object.assign(new Error('The shared Codex broker could not verify the selected account'), { code:'CODEX_CONTROL_ACCOUNT_UNVERIFIED' }));
        }
        checkingAccount = false;
        write(buildCodexAppServerInitializeMessage());
        return;
      }
      // Requests have a private id namespace per connection, remapped by broker.
      if (message.id === 0 && !message.method) {
        if (message.error) return finish(new Error('Codex background initialize failed'));
        write(buildCodexAppServerInitializedNotification());
        write(buildCodexAppServerThreadMessage({
          cwd, model, developerInstructions, permissionMode: 'never-read-only',
        }));
        return;
      }
      if (message.id === 1 && !message.method) {
        if (message.error || !message.result?.thread?.id) return finish(new Error('Codex background thread could not start'));
        threadId = String(message.result.thread.id);
        turnSent = true;
        write(buildCodexAppServerTurnStartMessage({
          threadId, text: prompt, cwd, model, reasoningEffort: effort, permissionMode: 'never-read-only',
        }));
        return;
      }
      if (message.id === 2 && !message.method) {
        if (message.error) return finish(new Error('Codex background turn could not start'));
        turnId ||= String(message.result?.turn?.id || '');
        return;
      }
      const params = message.params || {};
      const eventThread = params.threadId || params.turn?.threadId || params.item?.threadId || '';
      // Ignore delegated threads, global notifications and pre-start frames.
      if (!turnSent || eventThread !== threadId) return;
      const eventTurn = params.turnId || params.turn?.id || '';
      if (turnId && eventTurn && eventTurn !== turnId) return;
      if (message.method === 'turn/started') turnId ||= String(eventTurn);
      if (readCodexAppServerApprovalRequest(message)) return finish(new Error('Codex background task requires interactive approval'));
      if (message.method === 'error' && params.willRetry !== true) {
        return finish(new Error('Codex background provider failed'));
      }
      for (const event of adapter.parseLine(line)) {
        if (event.type === 'message' && event.role === 'assistant') {
          const content = typeof event.content === 'string' ? event.content : '';
          outputChars += content.length;
          if (outputChars > MAX_OUTPUT_CHARS) return finish(new Error('Codex background output exceeded limit'));
          parts.push(content);
        } else if (event.type === 'usage') usage = event;
      }
      if (message.method === 'turn/completed') {
        const status = params.turn?.status;
        finish(status === 'completed' ? null : new Error('Codex background turn did not complete'));
      }
    };
    socket.on('data', (chunk) => {
      if (settled) return;
      wireBytes += chunk.length;
      if (wireBytes > 8 * MAX_OUTPUT_CHARS) return finish(new Error('Codex background stream exceeded limit'));
      buffer += decoder.write(chunk);
      let newline;
      while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) return finish(new Error('Codex background frame exceeded limit'));
        try { consume(JSON.parse(line), line); }
        catch { return finish(new Error('Codex background protocol failed')); }
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) finish(new Error('Codex background frame exceeded limit'));
    });
  });
}
