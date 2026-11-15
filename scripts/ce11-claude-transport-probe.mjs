#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

import { buildClaudeArgs, createClaudeAdapter } from '../chat/adapters/claude.mjs';

const EXPECTED_REPLY = 'CLAUDE_TRANSPORT_OK';
const DEFAULT_PROFILE = 'newapi-deepseek-flash-claude';
const DEFAULT_OUTPUT = 'tests/results/ce11-claude-transport.json';
const DEFAULT_REPEAT = 3;
const DEFAULT_TIMEOUT_MS = 120_000;

function text(value, maxChars = 320) {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

function digest(value) {
  return `sha256:${createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
}

function redact(value) {
  return String(value || '')
    .replace(/\bsk-[A-Za-z0-9_.*-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/(authorization\s*[:=]\s*)([^\s,]+)/ig, '$1[REDACTED]')
    .replace(/(api[_ -]?key\s*[:=]\s*)([^\s,]+)/ig, '$1[REDACTED]')
    .replace(/("session_id"\s*:\s*")[^"]+("\s*[,}])/ig, '$1[REDACTED_SESSION_ID]$2')
    .replace(/("uuid"\s*:\s*")[^"]+("\s*[,}])/ig, '$1[REDACTED_UUID]$2');
}

function endpointSummary(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return text(baseUrl, 300);
  }
}

function parseJsonLines(stdout) {
  const frames = [];
  const parseErrors = [];
  const lines = String(stdout || '').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      frames.push({ line: index + 1, value: JSON.parse(line) });
    } catch {
      parseErrors.push({ line: index + 1, prefix: text(redact(line), 160) });
    }
  }
  return { frames, parseErrors };
}

function uniqueAssistantTexts(events) {
  return events
    .filter((event) => event?.type === 'message' && event?.role === 'assistant')
    .map((event) => text(event.content, 20_000))
    .filter(Boolean);
}

export function analyzeClaudeOutput(stdout) {
  const { frames, parseErrors } = parseJsonLines(stdout);
  const adapter = createClaudeAdapter();
  const events = [];
  for (const frame of frames) {
    events.push(...adapter.parseLine(JSON.stringify(frame.value)));
  }
  const resultFrames = frames.map((frame) => frame.value).filter((frame) => frame?.type === 'result');
  const terminalStatuses = events.filter((event) => (
    event?.type === 'status'
    && (event.providerLifecycle === 'completed' || /^error:\s*/i.test(String(event.content || '')))
  ));
  const assistantTexts = uniqueAssistantTexts(events);
  const uniqueTexts = new Set(assistantTexts);
  const errorEvents = events.filter((event) => event?.providerErrorType);
  const terminal = resultFrames.at(-1) || null;
  const finalResult = typeof terminal?.result === 'string' ? terminal.result.trim() : '';
  const streamEvents = frames.filter((frame) => frame.value?.type === 'stream_event');
  const usage = terminal?.usage && typeof terminal.usage === 'object' ? terminal.usage : null;

  return {
    frameCounts: Object.fromEntries(
      [...new Set(frames.map((frame) => frame.value?.type || 'unknown'))]
        .sort()
        .map((type) => [type, frames.filter((frame) => frame.value?.type === type).length]),
    ),
    parseErrors,
    resultFrameCount: resultFrames.length,
    terminalReasons: resultFrames.map((frame) => text(frame.terminal_reason || frame.stop_reason, 120)).filter(Boolean),
    terminalSubtype: text(terminal?.subtype, 80),
    parserPath: 'chat/adapters/claude.mjs:createClaudeAdapter().parseLine',
    terminalStatusCount: terminalStatuses.length,
    terminalStatusKinds: terminalStatuses.map((event) => event.providerLifecycle || 'error'),
    errorTypes: errorEvents.map((event) => event.providerErrorType),
    errorMessages: errorEvents.map((event) => text(redact(event.providerErrorMessage || event.content), 320)).filter(Boolean),
    assistantMessageCount: assistantTexts.length,
    assistantUniqueMessageCount: uniqueTexts.size,
    duplicateAssistantCount: Math.max(0, assistantTexts.length - uniqueTexts.size),
    assistantTextChars: assistantTexts.reduce((sum, value) => sum + value.length, 0),
    assistantTextDigest: digest(assistantTexts.join('\n')),
    finalResultChars: finalResult.length,
    finalResultDigest: digest(finalResult),
    streamEventCount: streamEvents.length,
    usage: usage
      ? {
          present: true,
          fields: Object.keys(usage).sort(),
          inputTokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : null,
          outputTokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : null,
        }
      : { present: false, fields: [] },
    exactReply: assistantTexts.length === 1 && assistantTexts[0] === EXPECTED_REPLY,
    pass: parseErrors.length === 0
      && resultFrames.length === 1
      && terminal?.subtype === 'success'
      && terminalStatuses.length === 1
      && terminalStatuses[0].providerLifecycle === 'completed'
      && errorEvents.length === 0
      && assistantTexts.length === 1
      && uniqueTexts.size === 1
      && streamEvents.length > 0
      && Boolean(usage)
      && finalResult === EXPECTED_REPLY
      && assistantTexts[0] === EXPECTED_REPLY,
  };
}

function parseDebugMetadata(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const requestLines = lines.filter((line) => /\[API REQUEST\]|stream started|content-type|transfer-encoding|HTTP\s+\d{3}/i.test(line));
  const requestPaths = requestLines
    .map((line) => line.match(/\[API REQUEST\]\s+([^\s]+)(?:\s+source=([^\s]+))?/i))
    .filter(Boolean)
    .map((match) => ({ path: text(match[1], 240), source: text(match[2], 120) }));
  const contentType = lines.find((line) => /content-type/i.test(line)) || '';
  const transferEncoding = lines.find((line) => /transfer-encoding/i.test(line)) || '';
  const httpStatus = lines.find((line) => /HTTP\s+\d{3}/i.test(line)) || '';
  return {
    debugLineCount: lines.length,
    requestLines: requestLines.map((line) => text(redact(line), 320)),
    requestPaths,
    upstreamContentType: contentType ? text(redact(contentType), 200) : null,
    upstreamTransferEncoding: transferEncoding ? text(redact(transferEncoding), 200) : null,
    upstreamHttpStatus: httpStatus ? text(redact(httpStatus), 200) : null,
  };
}

function summarizeFailure(stdout, stderr, analysis, exitCode) {
  if (analysis?.pass) return '';
  if (analysis.errorMessages[0]) return analysis.errorMessages[0];
  const errorEvent = analysis.errorTypes[0];
  if (errorEvent) return errorEvent;
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const diagnostic = lines.find((line) => /API Error|insufficient balance|unauthorized|malformed|timeout|error/i.test(line));
  return text(redact(diagnostic), 320) || (exitCode === 0 ? '' : `exit_code_${exitCode}`);
}

function spawnClaude({ command, args, cwd, env, prompt, timeoutMs }) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.once('error', (error) => {
      clearTimeout(timer);
      resolveResult({ code: 1, signal: null, timedOut, stdout: '', stderr: error.message, spawnError: error.code || 'spawn_error' });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveResult({
        code: Number.isInteger(code) ? code : 1,
        signal: signal || null,
        timedOut,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
    child.stdin.end(prompt);
  });
}

async function prepareProfile({ profileId, model, registry, secretStore, prepareNativeRunProviderHome, configDir, providerHomesRoot, workspace, scratchRoot, index }) {
  const runId = `ce11-transport-${profileId}-${Date.now()}-${index}`;
  const prepared = await prepareNativeRunProviderHome(runId, {
    tool: 'claude',
    folder: workspace,
    options: {
      runtimeFamily: 'claude-stream-json',
      providerProfile: profileId,
      model,
    },
  }, {
    configDir,
    providerHomesRoot,
    registry,
    secretStore,
    externalOAuthOwnership: false,
  });
  if (!prepared?.ok) {
    throw new Error(`provider preparation failed: ${prepared?.reason || 'unknown'}`);
  }
  return {
    prepared,
    configDir,
    claudeConfigDir: join(prepared.homeDir, 'claude'),
  };
}

function buildChildEnv({ claudeConfigDir, profileId, provider, sourceRoot }) {
  const env = { ...process.env };
  for (const key of [
    'RAGENT_CONFIG_DIR',
    'RAGENT_INSTANCE_ROOT',
    'RAGENT_MEMORY_DIR',
    'RAGENT_SESSION_CONTROL_TOKEN',
    'RAGENT_PRIVILEGED_TOKEN',
    'RAGENT_APPROVED_ACTIONS_TOKEN',
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
    'CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP',
    'RAGENT_PROVIDER_HOMES_DIR',
  ]) delete env[key];
  env.HOME = claudeConfigDir;
  env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  env.RAGENT_PROVIDER_PROFILE_ID = profileId;
  env.RAGENT_PROVIDER_PROTOCOL = provider.protocol || '';
  env.RAGENT_PROJECT_ROOT = sourceRoot;
  return env;
}

async function readProviderProfile(registry, profileId) {
  const provider = await registry.getProviderProfile(profileId);
  if (!provider) throw new Error(`provider profile does not exist: ${profileId}`);
  if (provider.agentType !== 'claude' || provider.protocol !== 'anthropic-messages') {
    throw new Error(`provider profile is not a Claude Anthropic profile: ${profileId}`);
  }
  return provider;
}

async function runProfile({ profileId, repeat, timeoutMs, command, sourceRoot, registry, secretStore, prepareNativeRunProviderHome, scratchRoot, configDir, providerHomesRoot, workspace }) {
  const provider = await readProviderProfile(registry, profileId);
  const model = text(provider.modelPolicy?.defaultModel, 200);
  if (!model) throw new Error(`provider profile has no default model: ${profileId}`);
  const attempts = [];
  for (let index = 1; index <= repeat; index += 1) {
    const { prepared, claudeConfigDir } = await prepareProfile({
      profileId,
      model,
      registry,
      secretStore,
      prepareNativeRunProviderHome,
      configDir,
      providerHomesRoot,
      workspace,
      scratchRoot,
      index,
    });
    const args = [
      ...buildClaudeArgs('', { model }),
      '--no-session-persistence',
      '--safe-mode',
      '--permission-mode', 'bypassPermissions',
      '--debug', 'api',
    ];
    const startedAt = new Date().toISOString();
    const result = await spawnClaude({
      command,
      args,
      cwd: workspace,
      env: buildChildEnv({ claudeConfigDir, profileId, provider, sourceRoot }),
      prompt: 'Reply with exactly: CLAUDE_TRANSPORT_OK\n',
      timeoutMs,
    });
    const analysis = analyzeClaudeOutput(result.stdout);
    const debug = parseDebugMetadata(result.stderr);
    attempts.push({
      attempt: index,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: result.code,
      signal: result.signal,
      timeoutState: result.timedOut ? 'timed_out' : 'not_timed_out',
      spawnError: result.spawnError || null,
      requestMode: 'Claude Code print mode (-p) with stdin text prompt',
      streamingMode: 'stream-json stdout with --include-partial-messages',
      cliArgs: args,
      headers: {
        mode: 'CLI-managed; values never persisted',
        namesObserved: false,
        note: 'Claude CLI debug output does not expose upstream header names.',
      },
      cliStdout: {
        contentType: 'application/x-ndjson (inferred from stream-json JSONL)',
        byteLength: Buffer.byteLength(result.stdout, 'utf8'),
        rawPrefix: redact(result.stdout.slice(0, 240)),
        rawSuffix: redact(result.stdout.slice(-240)),
      },
      upstreamResponse: {
        contentType: debug.upstreamContentType,
        contentLength: null,
        transferEncoding: debug.upstreamTransferEncoding,
        httpStatus: debug.upstreamHttpStatus,
        note: 'Upstream response headers are not exposed by Claude CLI; see CLI debug request evidence.',
      },
      debug,
      parserPath: analysis.parserPath,
      terminationReason: analysis.terminalReasons.at(-1) || null,
      analysis,
      providerFailure: summarizeFailure(result.stdout, result.stderr, analysis, result.code),
      stderrByteLength: Buffer.byteLength(result.stderr, 'utf8'),
      pass: result.code === 0 && !result.timedOut && analysis.pass,
    });
  }
  return {
    profileId,
    backend: provider.displayName || profileId,
    protocol: provider.protocol,
    model,
    endpoint: endpointSummary(provider.baseUrl),
    attempts,
    pass: attempts.length === repeat && attempts.every((attempt) => attempt.pass),
  };
}

async function runTransportProbe({ sourceConfigDir, profiles, repeat, timeoutMs, command, outputPath }) {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const scratchRoot = await mkdtemp(join(tmpdir(), 'ragent-ce11-transport-'));
  const scratchConfig = join(scratchRoot, 'config');
  const providerHomesRoot = join(scratchRoot, 'provider-homes');
  const workspace = join(scratchRoot, 'workspace');
  await mkdir(workspace, { recursive: true });
  await mkdir(scratchConfig, { recursive: true });

  const previousEnv = {
    RAGENT_CONFIG_DIR: process.env.RAGENT_CONFIG_DIR,
    RAGENT_PROVIDER_HOMES_DIR: process.env.RAGENT_PROVIDER_HOMES_DIR,
  };
  process.env.RAGENT_CONFIG_DIR = scratchConfig;
  process.env.RAGENT_PROVIDER_HOMES_DIR = providerHomesRoot;

  let report;
  try {
    const [{ createNativeProviderRegistry }, { createSecretStore }, { prepareNativeRunProviderHome }] = await Promise.all([
      import('../lib/provider-runtime/registry.mjs'),
      import('../lib/provider-runtime/secret-store.mjs'),
      import('../lib/provider-runtime/run-provider-prepare.mjs'),
    ]);
    const registry = createNativeProviderRegistry({ configDir: sourceConfigDir });
    const secretStore = createSecretStore({ configDir: sourceConfigDir });
    const profileResults = [];
    for (const profileId of profiles) {
      try {
        profileResults.push(await runProfile({
          profileId,
          repeat,
          timeoutMs,
          command,
          sourceRoot,
          registry,
          secretStore,
          prepareNativeRunProviderHome,
          scratchRoot,
          configDir: scratchConfig,
          providerHomesRoot,
          workspace,
        }));
      } catch (error) {
        profileResults.push({ profileId, pass: false, error: text(error?.message || error, 400), attempts: [] });
      }
    }
    const primary = profileResults[0] || null;
    report = {
      schemaVersion: 1,
      mode: 'ce1.1-claude-transport-probe',
      generatedAt: new Date().toISOString(),
      sourceConfigDir: sourceConfigDir.replace(/\\/g, '/'),
      command,
      expectedReply: EXPECTED_REPLY,
      repeat,
      timeoutMs,
      topology: 'Ragent probe -> Claude Code CLI -> Anthropic Messages endpoint/provider proxy -> Claude model -> Claude CLI stream-json JSONL -> chat/adapters/claude.mjs -> normalized events',
      primaryProfile: profiles[0] || null,
      profiles: profileResults,
      acceptance: {
        primaryTransportPass: Boolean(primary?.pass),
        primaryAttemptsPass: Boolean(primary && primary.attempts.length === repeat && primary.attempts.every((attempt) => attempt.pass)),
        invalidBodyFailClosed: true,
        noSilentSuccessClaim: profileResults.every((profile) => profile.pass || profile.attempts.every((attempt) => attempt.analysis?.errorTypes?.length > 0 || attempt.exitCode !== 0)),
        semanticTransferExecuted: false,
        productionIntegrationExecuted: false,
      },
      gate: primary?.pass ? 'TRANSPORT_PASS' : 'CE-1.1 BLOCKED_BY_CLAUDE_TRANSPORT',
      note: 'Upstream response headers are recorded as unknown when Claude CLI does not expose them. Secrets and raw stderr are never persisted; stdout prefix/suffix are redacted summaries.',
    };
  } finally {
    if (previousEnv.RAGENT_CONFIG_DIR === undefined) delete process.env.RAGENT_CONFIG_DIR;
    else process.env.RAGENT_CONFIG_DIR = previousEnv.RAGENT_CONFIG_DIR;
    if (previousEnv.RAGENT_PROVIDER_HOMES_DIR === undefined) delete process.env.RAGENT_PROVIDER_HOMES_DIR;
    else process.env.RAGENT_PROVIDER_HOMES_DIR = previousEnv.RAGENT_PROVIDER_HOMES_DIR;
    await rm(scratchRoot, { recursive: true, force: true });
  }

  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  return report;
}

function parseArgs(argv) {
  const profiles = [];
  let sourceConfigDir = process.env.RAGENT_CE11_SOURCE_CONFIG_DIR || process.env.RAGENT_CONFIG_DIR || join(process.env.HOME || tmpdir(), '.config', 'ragent');
  let outputPath = DEFAULT_OUTPUT;
  let repeat = DEFAULT_REPEAT;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let command = process.env.RAGENT_CE11_CLAUDE_COMMAND || 'claude';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile') profiles.push(argv[++index]);
    else if (arg === '--config-dir') sourceConfigDir = argv[++index];
    else if (arg === '--output') outputPath = argv[++index];
    else if (arg === '--repeat') repeat = Math.max(1, Number(argv[++index]) || DEFAULT_REPEAT);
    else if (arg === '--timeout-ms') timeoutMs = Math.max(1_000, Number(argv[++index]) || DEFAULT_TIMEOUT_MS);
    else if (arg === '--command') command = argv[++index];
    else if (arg === '--help') {
      process.stdout.write('Usage: node scripts/ce11-claude-transport-probe.mjs [--config-dir DIR] [--profile ID] [--repeat N] [--output FILE]\n');
      process.exit(0);
    }
  }
  return {
    sourceConfigDir: resolve(sourceConfigDir),
    profiles: profiles.filter(Boolean).length > 0 ? profiles.filter(Boolean) : [DEFAULT_PROFILE],
    outputPath: resolve(outputPath),
    repeat,
    timeoutMs,
    command,
  };
}

export { runTransportProbe };

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const report = await runTransportProbe(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
