import {
  createAgentoCHttpClient,
  DEFAULT_CHAT_BASE_URL,
  normalizeBaseUrl,
  trimString,
} from './agentoc-http-client.mjs';

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage:\n  ragent managed-process <command> [options]\n\nCommands:\n  create                   Start a process independent of the current Run\n  list                     List managed processes\n  get <process-id>         Load one process and output tail\n  cancel <process-id>      Terminate a process tree\n\nCreate options:\n  --executable <file>      Required executable (no shell)\n  --arg <value>            Repeat for each argv entry\n  --cwd <path>             Working directory (default: current session folder)\n  --env KEY=VALUE          Safe environment override; repeatable\n  --session <id>           Source session (default: $AGENTOC_SESSION_ID)\n  --wake-text <text>       Message sent to the session on terminal state\n  --wake-on <event>        terminal or output (default: terminal)\n  --include-output        Include stdout/stderr tail in wake text\n\nGeneral options:\n  --json                   Print machine-readable JSON\n  --base-url <url>         Ragent base URL\n  --help                   Show this help\n`);
}
function writeOutput(payload, options, stdout) {
  if (options.json) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (payload.process) {
    const process = payload.process;
    stdout.write([
      `id: ${process.id}`,
      `state: ${process.state}`,
      `sessionId: ${process.sessionId}`,
      `executable: ${process.executable}`,
      process.pid ? `pid: ${process.pid}` : '',
      process.exitCode !== null && process.exitCode !== undefined ? `exitCode: ${process.exitCode}` : '',
      process.error ? `error: ${process.error}` : '',
      process.stdout ? `stdout:\n${process.stdout}` : '',
      process.stderr ? `stderr:\n${process.stderr}` : '',
    ].filter(Boolean).join('\n') + '\n');
    return;
  }
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function parseArgs(argv = []) {
  const command = trimString(argv[0]).toLowerCase();
  const idCommands = new Set(['get', 'cancel']);
  const options = {
    command,
    processId: idCommands.has(command) ? trimString(argv[1]) : '',
    executable: '',
    args: [],
    cwd: '',
    env: {},
    sessionId: trimString(process.env.AGENTOC_SESSION_ID),
    wakeText: '',
    wakeOn: ['terminal'],
    includeOutput: false,
    json: false,
    baseUrl: normalizeBaseUrl(process.env.AGENTOC_CHAT_BASE_URL || DEFAULT_CHAT_BASE_URL),
    help: false,
  };
  const start = idCommands.has(command) ? 2 : 1;
  for (let index = start; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      if (argv[index + 1] === undefined) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return argv[index];
    };
    if (arg === '--executable') options.executable = value();
    else if (arg === '--arg') options.args.push(value());
    else if (arg === '--cwd') options.cwd = value();
    else if (arg === '--env') {
      const entry = String(value());
      const separator = entry.indexOf('=');
      if (separator <= 0) throw new Error('--env must use KEY=VALUE');
      options.env[entry.slice(0, separator)] = entry.slice(separator + 1);
    } else if (arg === '--session') options.sessionId = value();
    else if (arg === '--wake-text') options.wakeText = value();
    else if (arg === '--wake-on') options.wakeOn = [String(value()).trim().toLowerCase()];
    else if (arg === '--include-output') options.includeOutput = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--base-url') options.baseUrl = normalizeBaseUrl(value());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.executable = trimString(options.executable);
  options.cwd = trimString(options.cwd);
  options.sessionId = trimString(options.sessionId);
  options.wakeText = trimString(options.wakeText);
  return options;
}

export async function runManagedProcessCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const options = parseArgs(argv);
  if (options.help || !options.command) {
    printHelp(stdout);
    return 0;
  }
  const client = createAgentoCHttpClient({ baseUrl: options.baseUrl });
  if (options.command === 'create') {
    if (!options.sessionId) throw new Error('No session id provided. Pass --session or set AGENTOC_SESSION_ID.');
    if (!options.executable) throw new Error('--executable is required');
    const result = await client.request(`/api/sessions/${encodeURIComponent(options.sessionId)}/managed-processes`, {
      method: 'POST',
      body: {
        executable: options.executable,
        args: options.args,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(Object.keys(options.env).length ? { env: options.env } : {}),
        wake: {
          on: options.wakeOn,
          ...(options.wakeText ? { text: options.wakeText } : {}),
          ...(options.includeOutput ? { includeOutput: true } : {}),
        },
      },
    });
    if (!result.response.ok || !result.json?.process?.id) throw new Error(result.json?.error || result.text || `Failed to create managed process (${result.response.status})`);
    writeOutput({ process: result.json.process }, options, stdout);
    return 0;
  }
  if (options.command === 'list') {
    const query = options.sessionId ? `?sessionId=${encodeURIComponent(options.sessionId)}` : '';
    const result = await client.request(`/api/managed-processes${query}`);
    if (!result.response.ok || !Array.isArray(result.json?.processes)) throw new Error(result.json?.error || result.text || `Failed to list managed processes (${result.response.status})`);
    writeOutput({ processes: result.json.processes }, options, stdout);
    return 0;
  }
  if (!options.processId) throw new Error(`${options.command} requires a process id`);
  const path = `/api/managed-processes/${encodeURIComponent(options.processId)}`;
  if (options.command === 'get') {
    const result = await client.request(path);
    if (!result.response.ok || !result.json?.process?.id) throw new Error(result.json?.error || result.text || `Failed to load managed process (${result.response.status})`);
    writeOutput({ process: result.json.process }, options, stdout);
    return 0;
  }
  if (options.command === 'cancel') {
    const result = await client.request(`${path}/cancel`, { method: 'POST', body: {} });
    if (!result.response.ok || !result.json?.process?.id) throw new Error(result.json?.error || result.text || `Failed to cancel managed process (${result.response.status})`);
    writeOutput({ process: result.json.process }, options, stdout);
    return 0;
  }
  throw new Error(`Unknown managed-process command: ${options.command}`);
}
