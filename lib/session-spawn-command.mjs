import {
  buildSessionUrl,
  createAgentoCHttpClient,
  DEFAULT_CHAT_BASE_URL,
  DEFAULT_RUN_POLL_TIMEOUT_MS,
  loadAssistantReply,
  normalizeBaseUrl,
  parsePositiveInteger,
  trimString,
} from './agentoc-http-client.mjs';

function normalizeOutputMode(value) {
  const normalized = trimString(value).toLowerCase();
  if (!normalized || normalized === 'default') return 'default';
  if (normalized === 'final-only') return 'final-only';
  throw new Error(`Unsupported output mode: ${value}`);
}

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage:\n  ragent session-spawn --task "<focused task>" [options]\n\nOptions:\n  --task <text>             Required delegated task / handoff goal\n  --source-session <id>     Source session id (default: $AGENTOC_SESSION_ID)\n  --name <text>             Optional initial session name\n  --tool <id>               Optional child tool override\n  --wait                    Wait for the spawned run and return its reply\n  --internal                Create a hidden internal child session and suppress parent notice\n  --output-mode <mode>      Output mode: default | final-only\n  --final-only              Sugar for --wait plus --output-mode final-only\n  --json                    Print machine-readable JSON\n  --base-url <url>          Ragent base URL (default: $AGENTOC_CHAT_BASE_URL or local 7690)\n  --timeout-ms <ms>         Wait timeout for --wait (default: 600000)\n  --help                    Show this help\n`);
}

function readSessionControlEnvironment() {
  const token = trimString(process.env.AGENTOC_SESSION_CONTROL_TOKEN);
  if (!token) return null;
  return {
    token,
    renewalToken: trimString(process.env.AGENTOC_SESSION_CONTROL_RENEWAL_TOKEN),
    runId: trimString(process.env.AGENTOC_SESSION_CONTROL_RUN_ID),
    sessionId: trimString(process.env.AGENTOC_SESSION_CONTROL_SESSION_ID),
    turnId: trimString(process.env.AGENTOC_SESSION_CONTROL_TURN_ID),
  };
}

function parseArgs(argv = []) {
  const options = {
    task: '',
    sourceSessionId: trimString(process.env.AGENTOC_SESSION_ID),
    name: '',
    tool: '',
    wait: false,
    internal: false,
    outputMode: 'default',
    json: false,
    baseUrl: trimString(process.env.AGENTOC_CHAT_BASE_URL || DEFAULT_CHAT_BASE_URL),
    timeoutMs: DEFAULT_RUN_POLL_TIMEOUT_MS,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--task':
        options.task = argv[index + 1] || '';
        index += 1;
        break;
      case '--source-session':
        options.sourceSessionId = argv[index + 1] || '';
        index += 1;
        break;
      case '--name':
        options.name = argv[index + 1] || '';
        index += 1;
        break;
      case '--tool':
        options.tool = argv[index + 1] || '';
        index += 1;
        break;
      case '--wait':
        options.wait = true;
        break;
      case '--internal':
        options.internal = true;
        break;
      case '--output-mode':
        options.outputMode = argv[index + 1] || '';
        index += 1;
        break;
      case '--final-only':
        options.wait = true;
        options.outputMode = 'final-only';
        break;
      case '--json':
        options.json = true;
        break;
      case '--base-url':
        options.baseUrl = argv[index + 1] || '';
        index += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = parsePositiveInteger(argv[index + 1], DEFAULT_RUN_POLL_TIMEOUT_MS);
        index += 1;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.task = trimString(options.task);
  options.sourceSessionId = trimString(options.sourceSessionId);
  options.name = trimString(options.name);
  options.tool = trimString(options.tool);
  options.outputMode = normalizeOutputMode(options.outputMode);
  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  return options;
}

function writeResult(result, options = {}, stdout = process.stdout) {
  if (options.outputMode === 'final-only') {
    if (options.json) {
      stdout.write(`${JSON.stringify({
        state: result.state || '',
        reply: trimString(result.reply || ''),
      }, null, 2)}\n`);
      return;
    }
    stdout.write(`${trimString(result.reply || '')}\n`);
    return;
  }

  if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const lines = [
    `sessionId: ${result.sessionId || ''}`,
    `runId: ${result.runId || ''}`,
    `sessionUrl: ${result.sessionUrl || ''}`,
  ];
  if (result.reply) {
    lines.push('', result.reply);
  }
  stdout.write(`${lines.join('\n')}\n`);
}

export async function runSessionSpawnCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const options = parseArgs(argv);
  if (options.help) {
    printHelp(stdout);
    return 0;
  }
  if (!options.task) {
    throw new Error('--task is required');
  }
  if (!options.sourceSessionId) {
    throw new Error('No source session id provided. Pass --source-session or set AGENTOC_SESSION_ID.');
  }
  if (options.outputMode === 'final-only' && !options.wait) {
    throw new Error('--output-mode final-only requires --wait');
  }

  const sessionControl = readSessionControlEnvironment();
  if (sessionControl && sessionControl.sessionId !== options.sourceSessionId) {
    throw new Error('AGENTOC_SESSION_CONTROL_SESSION_ID does not match --source-session');
  }
  const client = createAgentoCHttpClient({
    baseUrl: options.baseUrl,
    ...(sessionControl ? {
      sessionControlToken: sessionControl.token,
      sessionControlRenewalToken: sessionControl.renewalToken,
      sessionControlRunId: sessionControl.runId,
      sessionControlSessionId: sessionControl.sessionId,
      sessionControlTurnId: sessionControl.turnId,
    } : {}),
  });

  const result = await client.request(`/api/sessions/${encodeURIComponent(options.sourceSessionId)}/delegate`, {
    method: 'POST',
    body: {
      task: options.task,
      ...(options.name ? { name: options.name } : {}),
      ...(options.tool ? { tool: options.tool } : {}),
      ...(options.internal ? { internal: true } : {}),
    },
  });
  if (!result.response.ok || !result.json?.session?.id || !result.json?.run?.id) {
    throw new Error(result.json?.error || result.text || `Failed to spawn session (${result.response.status})`);
  }

  const output = {
    sourceSessionId: options.sourceSessionId,
    task: options.task,
    sessionId: result.json.session.id,
    sessionName: trimString(result.json.session.name || ''),
    runId: result.json.run.id,
    sessionUrl: buildSessionUrl(result.json.session.id),
  };

  if (options.wait) {
    const run = await client.waitForRun(result.json.run.id, { timeoutMs: options.timeoutMs });
    output.state = run.state;
    output.reply = await loadAssistantReply(client, result.json.session.id, result.json.run.id);
    if (run.state !== 'completed') {
      writeResult(output, options, stdout);
      stderr.write(`Child session run finished in state ${run.state}.\n`);
      return 1;
    }
  }

  writeResult(output, options, stdout);
  return 0;
}
