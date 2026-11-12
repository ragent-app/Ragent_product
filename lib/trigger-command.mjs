import {
  createAgentoCHttpClient,
  DEFAULT_CHAT_BASE_URL,
  normalizeBaseUrl,
  trimString,
} from './agentoc-http-client.mjs';

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage:\n  agentoc trigger <command> [options]\n\nCommands:\n  create                   Create a time or event trigger\n  list                     List triggers\n  get <trigger-id>         Load one trigger\n  cancel <trigger-id>      Disable a trigger without deleting it\n  delete <trigger-id>      Delete a trigger\n\nCreate options:\n  --text <text>            Required message to inject when the trigger fires\n  --in <duration>          Relative delay like 30s, 10m, 2h, 1d\n  --at <timestamp>         Absolute ISO timestamp\n  --every <duration>       Repeat a time trigger after each delivery\n  --max-occurrences <n>    Optional repeat limit\n  --event <type>           Wake on run_terminal, collaboration_terminal, process_terminal, process_output, session_event\n  --filter key=value       Event filter; repeatable\n  --repeat                 Keep an event trigger armed after delivery\n  --session <id>           Target session id (default: $AGENTOC_SESSION_ID)\n  --title <text>           Optional human-readable label\n  --tool <id>              Optional runtime override\n  --model <id>             Optional model override\n  --effort <level>         Optional effort override\n  --thinking               Enable thinking mode for the triggered run\n\nGeneral options:\n  --source-session <id>    Alias for --session on list\n  --json                   Print machine-readable JSON\n  --base-url <url>         AgentoC base URL (default: $AGENTOC_CHAT_BASE_URL or local 7690)\n  --help                   Show this help\n`);
}

function parseDurationMs(value) {
  const normalized = trimString(value).toLowerCase();
  if (!normalized) return 0;
  const match = normalized.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) return 0;
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isInteger(amount) || amount <= 0) return 0;
  const unit = match[2];
  const factor = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  }[unit] || 0;
  return amount * factor;
}

function resolveScheduledAt(options) {
  const inDuration = trimString(options.in);
  const at = trimString(options.at);
  if (!!inDuration === !!at) {
    throw new Error('Provide exactly one of --in or --at');
  }
  if (inDuration) {
    const delayMs = parseDurationMs(inDuration);
    if (!(delayMs > 0)) {
      throw new Error('--in must be a positive duration like 30s, 10m, 2h, or 1d');
    }
    return new Date(Date.now() + delayMs).toISOString();
  }
  const parsedAt = Date.parse(at);
  if (!Number.isFinite(parsedAt)) {
    throw new Error('--at must be a valid timestamp');
  }
  return new Date(parsedAt).toISOString();
}

function parseEventFilterEntry(value) {
  const entry = String(value || '');
  const separator = entry.indexOf('=');
  if (separator <= 0) throw new Error('--filter must use key=value');
  const key = entry.slice(0, separator).trim();
  const raw = entry.slice(separator + 1).trim();
  if (!key) throw new Error('--filter key is required');
  if (raw === 'true' || raw === 'false') return [key, raw === 'true'];
  if (raw !== '' && Number.isFinite(Number(raw))) return [key, Number(raw)];
  return [key, raw];
}

function buildOutputLines(trigger) {
  return [
    `id: ${trimString(trigger?.id)}`,
    `status: ${trimString(trigger?.status)}`,
    `sessionId: ${trimString(trigger?.sessionId)}`,
    `scheduledAt: ${trimString(trigger?.scheduledAt)}`,
    trimString(trigger?.title) ? `title: ${trimString(trigger.title)}` : '',
    trimString(trigger?.text) ? `text: ${trimString(trigger.text)}` : '',
  ].filter(Boolean);
}

function writeOutput(payload, options = {}, stdout = process.stdout) {
  if (options.json) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (Array.isArray(payload?.triggers)) {
    const blocks = payload.triggers.map((trigger) => buildOutputLines(trigger).join('\n'));
    stdout.write(`${blocks.join('\n\n')}\n`);
    return;
  }

  if (payload?.trigger) {
    stdout.write(`${buildOutputLines(payload.trigger).join('\n')}\n`);
    return;
  }

  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function parseArgs(argv = []) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { command: '', help: true };
  const options = {
    command: trimString(argv[0]).toLowerCase(),
    triggerId: trimString(argv[1]),
    text: '',
    in: '',
    at: '',
    every: '',
    maxOccurrences: '',
    event: '',
    filters: [],
    repeat: false,
    sessionId: trimString(process.env.AGENTOC_SESSION_ID),
    title: '',
    tool: '',
    model: '',
    effort: '',
    thinking: false,
    json: false,
    baseUrl: trimString(process.env.AGENTOC_CHAT_BASE_URL || DEFAULT_CHAT_BASE_URL),
    help: false,
  };

  const valueFlags = new Set(['--text', '--in', '--at', '--every', '--max-occurrences', '--event', '--filter', '--session', '--source-session', '--title', '--tool', '--model', '--effort', '--base-url']);
  const commandConsumesId = new Set(['get', 'cancel', 'delete']);
  const argsStartIndex = commandConsumesId.has(options.command) ? 2 : 1;
  options.triggerId = commandConsumesId.has(options.command) ? trimString(argv[1]) : '';

  for (let index = argsStartIndex; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--text':
        options.text = argv[index + 1] || '';
        index += 1;
        break;
      case '--in':
        options.in = argv[index + 1] || '';
        index += 1;
        break;
      case '--at':
        options.at = argv[index + 1] || '';
        index += 1;
        break;
      case '--every':
        options.every = argv[index + 1] || '';
        index += 1;
        break;
      case '--max-occurrences':
        options.maxOccurrences = argv[index + 1] || '';
        index += 1;
        break;
      case '--event':
        options.event = argv[index + 1] || '';
        index += 1;
        break;
      case '--filter':
        options.filters.push(argv[index + 1] || '');
        index += 1;
        break;
      case '--repeat':
        options.repeat = true;
        break;
      case '--session':
        options.sessionId = argv[index + 1] || '';
        index += 1;
        break;
      case '--source-session':
        if (String(options.command).toLowerCase() !== 'list') throw new Error('--source-session is only supported for trigger list');
        options.sessionId = argv[index + 1] || '';
        index += 1;
        break;
      case '--title':
        options.title = argv[index + 1] || '';
        index += 1;
        break;
      case '--tool':
        options.tool = argv[index + 1] || '';
        index += 1;
        break;
      case '--model':
        options.model = argv[index + 1] || '';
        index += 1;
        break;
      case '--effort':
        options.effort = argv[index + 1] || '';
        index += 1;
        break;
      case '--thinking':
        options.thinking = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--base-url':
        options.baseUrl = argv[index + 1] || '';
        index += 1;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        if (valueFlags.has(arg)) {
          throw new Error(`Missing value for ${arg}`);
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.command = trimString(options.command).toLowerCase();
  options.triggerId = trimString(options.triggerId);
  options.text = String(options.text || '');
  options.in = trimString(options.in);
  options.at = trimString(options.at);
  options.every = trimString(options.every);
  options.maxOccurrences = trimString(options.maxOccurrences);
  options.event = trimString(options.event).toLowerCase();
  options.sessionId = trimString(options.sessionId);
  options.title = trimString(options.title);
  options.tool = trimString(options.tool);
  options.model = trimString(options.model);
  options.effort = trimString(options.effort);
  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  return options;
}

export async function runTriggerCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const options = parseArgs(argv);
  if (options.help || !options.command) {
    printHelp(stdout);
    return 0;
  }

  const client = createAgentoCHttpClient({ baseUrl: options.baseUrl });

  if (options.command === 'create') {
    if (!options.sessionId) {
      throw new Error('No session id provided. Pass --session or set AGENTOC_SESSION_ID.');
    }
    if (!trimString(options.text)) {
      throw new Error('--text is required');
    }
    if (options.event && (options.in || options.at)) throw new Error('--event cannot be combined with --in or --at');
    if (!options.event && !options.in && !options.at) throw new Error('Provide --in/--at for a time trigger or --event for an event trigger');
    const scheduledAt = options.event ? '' : resolveScheduledAt(options);
    const eventFilter = Object.fromEntries(options.filters.map(parseEventFilterEntry));
    const recurrence = options.every
      ? {
        type: 'interval',
        intervalMs: parseDurationMs(options.every),
        ...(options.maxOccurrences ? { maxOccurrences: Number.parseInt(options.maxOccurrences, 10) } : {}),
      }
      : undefined;
    if (options.every && !(recurrence.intervalMs > 0)) throw new Error('--every must be a positive duration');
    const body = {
      sessionId: options.sessionId,
      scheduledAt,
      text: trimString(options.text),
      ...(options.event ? { eventType: options.event } : {}),
      ...(Object.keys(eventFilter).length ? { eventFilter } : {}),
      ...(recurrence ? { recurrence } : {}),
      ...(options.repeat ? { repeat: true } : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(options.tool ? { tool: options.tool } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.thinking ? { thinking: true } : {}),
    };
    const result = await client.request('/api/triggers', { method: 'POST', body });
    if (!result.response.ok || !result.json?.trigger?.id) {
      throw new Error(result.json?.error || result.text || `Failed to create trigger (${result.response.status})`);
    }
    writeOutput({ trigger: result.json.trigger }, options, stdout);
    return 0;
  }

  if (options.command === 'list') {
    const query = options.sessionId ? `?sessionId=${encodeURIComponent(options.sessionId)}` : '';
    const result = await client.request(`/api/triggers${query}`);
    if (!result.response.ok || !Array.isArray(result.json?.triggers)) {
      throw new Error(result.json?.error || result.text || `Failed to list triggers (${result.response.status})`);
    }
    writeOutput({ triggers: result.json.triggers }, options, stdout);
    return 0;
  }

  if (!options.triggerId) {
    throw new Error(`${options.command} requires a trigger id`);
  }

  if (options.command === 'get') {
    const result = await client.request(`/api/triggers/${encodeURIComponent(options.triggerId)}`);
    if (!result.response.ok || !result.json?.trigger?.id) {
      throw new Error(result.json?.error || result.text || `Failed to load trigger (${result.response.status})`);
    }
    writeOutput({ trigger: result.json.trigger }, options, stdout);
    return 0;
  }

  if (options.command === 'cancel') {
    const result = await client.request(`/api/triggers/${encodeURIComponent(options.triggerId)}`, {
      method: 'PATCH',
      body: { enabled: false },
    });
    if (!result.response.ok || !result.json?.trigger?.id) {
      throw new Error(result.json?.error || result.text || `Failed to cancel trigger (${result.response.status})`);
    }
    writeOutput({ trigger: result.json.trigger }, options, stdout);
    return 0;
  }

  if (options.command === 'delete') {
    const result = await client.request(`/api/triggers/${encodeURIComponent(options.triggerId)}`, {
      method: 'DELETE',
    });
    if (!result.response.ok || !result.json?.trigger?.id) {
      throw new Error(result.json?.error || result.text || `Failed to delete trigger (${result.response.status})`);
    }
    writeOutput({ trigger: result.json.trigger }, options, stdout);
    return 0;
  }

  throw new Error(`Unknown trigger command: ${options.command}`);
}
