import { redactSensitiveText, redactSensitiveValue } from './tool-call-schema.mjs';

const MAX_SERIALIZED_TOOL_VALUE_CHARS = Math.max(
  4 * 1024,
  Number.parseInt(process.env.RAGENT_MAX_SERIALIZED_TOOL_VALUE_CHARS || String(256 * 1024), 10)
    || 256 * 1024,
);

const TOOL_SPECS = new Map(Object.entries({
  // Shell / process tools.
  bash: { kind: 'command', semanticKind: 'execute' },
  shell: { kind: 'command', semanticKind: 'execute' },
  command: { kind: 'command', semanticKind: 'execute' },
  command_execution: { kind: 'command', semanticKind: 'execute' },
  exec: { kind: 'command', semanticKind: 'execute' },
  exec_command: { kind: 'command', semanticKind: 'execute' },
  run_command: { kind: 'command', semanticKind: 'execute' },
  execute_command: { kind: 'command', semanticKind: 'execute' },
  execute_bash: { kind: 'command', semanticKind: 'execute' },
  execute_bash_action: { kind: 'command', semanticKind: 'execute' },
  run_shell_command: { kind: 'command', semanticKind: 'execute' },
  notebook_execution: { kind: 'command', semanticKind: 'execute' },

  // File reads and inspection.
  read: { kind: 'read', semanticKind: 'read' },
  readfile: { kind: 'read', semanticKind: 'read' },
  read_file: { kind: 'read', semanticKind: 'read' },
  read_file_content: { kind: 'read', semanticKind: 'read' },
  readfilecontent: { kind: 'read', semanticKind: 'read' },
  get_file: { kind: 'read', semanticKind: 'read' },
  view_file: { kind: 'read', semanticKind: 'read' },
  file_read_action: { kind: 'read', semanticKind: 'read' },

  // Search / listing.
  glob: { kind: 'search', semanticKind: 'search' },
  grep: { kind: 'search', semanticKind: 'search' },
  grep_search: { kind: 'search', semanticKind: 'search' },
  ripgrep: { kind: 'search', semanticKind: 'search' },
  search: { kind: 'search', semanticKind: 'search' },
  search_files: { kind: 'search', semanticKind: 'search' },
  find: { kind: 'search', semanticKind: 'search' },
  find_files: { kind: 'search', semanticKind: 'search' },
  find_by_name: { kind: 'search', semanticKind: 'search' },
  list: { kind: 'search', semanticKind: 'list' },
  ls: { kind: 'search', semanticKind: 'list' },
  list_dir: { kind: 'search', semanticKind: 'list' },
  list_files: { kind: 'search', semanticKind: 'list' },

  // File mutation.
  edit: { kind: 'file_edit', semanticKind: 'edit' },
  write: { kind: 'file_edit', semanticKind: 'edit' },
  multiedit: { kind: 'file_edit', semanticKind: 'edit' },
  notebookedit: { kind: 'file_edit', semanticKind: 'edit' },
  notebook_edit: { kind: 'file_edit', semanticKind: 'edit' },
  apply_patch: { kind: 'file_edit', semanticKind: 'edit' },
  file_change: { kind: 'file_edit', semanticKind: 'edit' },
  file_edit_action: { kind: 'file_edit', semanticKind: 'edit' },
  replace_file_content: { kind: 'file_edit', semanticKind: 'edit' },
  multi_replace_file_content: { kind: 'file_edit', semanticKind: 'edit' },
  sed_file: { kind: 'file_edit', semanticKind: 'edit' },
  write_to_file: { kind: 'file_edit', semanticKind: 'edit' },

  // Web and MCP.
  websearch: { kind: 'web', semanticKind: 'web' },
  web_search: { kind: 'web', semanticKind: 'web' },
  search_web: { kind: 'web', semanticKind: 'web' },
  webfetch: { kind: 'web', semanticKind: 'fetch' },
  web_fetch: { kind: 'web', semanticKind: 'fetch' },
  read_url_content: { kind: 'web', semanticKind: 'fetch' },
  open_browser_url: { kind: 'web', semanticKind: 'fetch' },
  browse_url_action: { kind: 'web', semanticKind: 'fetch' },
  browser_click_element: { kind: 'web', semanticKind: 'click' },
  click_browser_pixel: { kind: 'web', semanticKind: 'click' },
  browser_input: { kind: 'web', semanticKind: 'input' },
  browser_press_key: { kind: 'web', semanticKind: 'input' },
  browser_select_option: { kind: 'web', semanticKind: 'input' },
  browser_scroll: { kind: 'web', semanticKind: 'scroll' },
  browser_scroll_dom: { kind: 'web', semanticKind: 'scroll' },
  browser_drag_pixel_to_pixel: { kind: 'web', semanticKind: 'input' },
  browser_mouse_down: { kind: 'web', semanticKind: 'input' },
  browser_mouse_up: { kind: 'web', semanticKind: 'input' },
  browser_move_mouse: { kind: 'web', semanticKind: 'input' },
  browser_get_dom: { kind: 'web', semanticKind: 'inspect' },
  browser_get_network_request: { kind: 'web', semanticKind: 'inspect' },
  browser_list_network_requests: { kind: 'web', semanticKind: 'inspect' },
  list_browser_pages: { kind: 'web', semanticKind: 'inspect' },
  capture_browser_console_logs: { kind: 'web', semanticKind: 'capture' },
  capture_browser_screenshot: { kind: 'web', semanticKind: 'capture' },
  execute_browser_javascript: { kind: 'web', semanticKind: 'execute' },
  browser_refresh_page: { kind: 'web', semanticKind: 'web' },
  browser_resize_window: { kind: 'web', semanticKind: 'input' },
  call_mcp_tool: { kind: 'mcp', semanticKind: 'mcp' },
  mcp_call: { kind: 'mcp', semanticKind: 'mcp' },
  mcp_tool: { kind: 'mcp', semanticKind: 'mcp' },

  // Delegation and task coordination.
  task: { kind: 'subagent', semanticKind: 'subagent' },
  agent: { kind: 'subagent', semanticKind: 'subagent' },
  subagent: { kind: 'subagent', semanticKind: 'subagent' },
  spawn_agent: { kind: 'subagent', semanticKind: 'subagent' },
  invoke_subagent: { kind: 'subagent', semanticKind: 'subagent' },
  define_subagent: { kind: 'subagent', semanticKind: 'subagent' },
  agent_delegate_action: { kind: 'subagent', semanticKind: 'subagent' },
  task_create: { kind: 'subagent', semanticKind: 'task_create' },
  task_update: { kind: 'subagent', semanticKind: 'task_update' },
  task_get: { kind: 'subagent', semanticKind: 'task_read' },
  task_list: { kind: 'subagent', semanticKind: 'task_list' },
  task_output: { kind: 'subagent', semanticKind: 'task_read' },
  task_stop: { kind: 'subagent', semanticKind: 'task_stop' },
  list_agents: { kind: 'subagent', semanticKind: 'task_list' },
  manage_task: { kind: 'subagent', semanticKind: 'task_update' },
  manage_subagents: { kind: 'subagent', semanticKind: 'subagent' },
  send_message: { kind: 'subagent', semanticKind: 'message' },
  monitor: { kind: 'subagent', semanticKind: 'wait' },
  wait: { kind: 'subagent', semanticKind: 'wait' },
  wait_5_seconds: { kind: 'subagent', semanticKind: 'wait' },
  workflow: { kind: 'subagent', semanticKind: 'subagent' },
  skill: { kind: 'subagent', semanticKind: 'subagent' },
  report_findings: { kind: 'subagent', semanticKind: 'message' },
  browser_subagent: { kind: 'subagent', semanticKind: 'subagent' },
  manage_inbox: { kind: 'subagent', semanticKind: 'message' },
  cron_create: { kind: 'subagent', semanticKind: 'task_create' },
  cron_delete: { kind: 'subagent', semanticKind: 'task_stop' },
  cron_list: { kind: 'subagent', semanticKind: 'task_list' },
  schedule: { kind: 'subagent', semanticKind: 'task_create' },

  enter_plan_mode: { kind: 'other', semanticKind: 'switch_mode' },
  exit_plan_mode: { kind: 'other', semanticKind: 'switch_mode' },
  enter_worktree: { kind: 'other', semanticKind: 'switch_mode' },
  exit_worktree: { kind: 'other', semanticKind: 'switch_mode' },
  generate_image: { kind: 'other', semanticKind: 'generate' },
  read_resource: { kind: 'mcp', semanticKind: 'mcp' },
  list_resources: { kind: 'mcp', semanticKind: 'mcp' },

  ask_user_question: { kind: 'other', semanticKind: 'question' },
  ask_question: { kind: 'other', semanticKind: 'question' },
  ask_permission: { kind: 'other', semanticKind: 'approval' },
  ask_custom_permission: { kind: 'other', semanticKind: 'approval' },
}));

const INPUT_ALIASES = Object.freeze({
  command: ['command', 'cmd', 'script', 'CommandLine', 'command_line', 'shellCommand', 'shell_command'],
  path: [
    'path', 'filePath', 'file_path', 'FilePath', 'AbsolutePath', 'absolute_path',
    'TargetFile', 'target_file', 'filename', 'file_name', 'notebook_path',
    'SearchPath', 'search_path', 'SearchDirectory', 'search_directory', 'directory',
  ],
  query: ['query', 'Query', 'pattern', 'Pattern', 'needle', 'searchTerm', 'search_term', 'glob'],
  url: ['url', 'URL', 'uri', 'href'],
  toolName: ['toolName', 'tool_name', 'mcpTool', 'mcp_tool', 'name'],
  description: ['description', 'Description', 'prompt', 'Prompt', 'task', 'Task', 'subject', 'Subject'],
  taskId: ['taskId', 'task_id', 'TaskId', 'id'],
  action: ['action', 'Action', 'operation', 'Operation', 'status', 'Status'],
  target: ['target', 'Target', 'recipient', 'Recipient', 'agent', 'Agent', 'agentId', 'agent_id'],
  message: ['message', 'Message', 'content', 'Content', 'text', 'Text'],
  selector: ['selector', 'Selector', 'element', 'Element', 'elementId', 'element_id', 'targetElement'],
  key: ['key', 'Key', 'keyName', 'key_name'],
});

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstValue(source, keys) {
  if (!(source && typeof source === 'object')) return undefined;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
  }
  return undefined;
}

export function normalizeProviderToolName(value) {
  return text(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function parseProviderToolInput(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const source = text(value);
  if (!source || (!source.startsWith('{') && !source.startsWith('['))) return null;
  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function normalizeProviderToolInput(value) {
  const parsed = parseProviderToolInput(value);
  if (!parsed) return value;
  const result = { ...parsed };
  for (const [canonical, aliases] of Object.entries(INPUT_ALIASES)) {
    const selected = firstValue(parsed, aliases);
    if (selected !== undefined && result[canonical] === undefined) result[canonical] = selected;
  }
  return result;
}

function inferredSpec(toolName) {
  if (!toolName) return null;
  if (/(?:^|_)(?:read|view)(?:_|$)/.test(toolName)) return { kind: 'read', semanticKind: 'read' };
  if (/(?:grep|search|find)/.test(toolName)) return { kind: 'search', semanticKind: 'search' };
  if (/(?:^|_)(?:list|ls)(?:_|$)/.test(toolName)) return { kind: 'search', semanticKind: 'list' };
  if (/(?:edit|write|replace|patch|modify)/.test(toolName)) return { kind: 'file_edit', semanticKind: 'edit' };
  if (/(?:bash|shell|command|exec)/.test(toolName)) return { kind: 'command', semanticKind: 'execute' };
  if (/(?:web|browser|url|fetch)/.test(toolName)) return { kind: 'web', semanticKind: 'fetch' };
  if (toolName.includes('mcp')) return { kind: 'mcp', semanticKind: 'mcp' };
  if (/(?:subagent|delegate|spawn_agent|invoke_agent)/.test(toolName)) return { kind: 'subagent', semanticKind: 'subagent' };
  return null;
}

function subjectFor(spec, input, toolName) {
  const source = input && typeof input === 'object' ? input : {};
  const path = text(source.path);
  const query = text(source.query);
  const description = text(source.description);
  const taskId = text(source.taskId);
  const action = text(source.action);
  const target = text(source.target);
  const message = text(source.message);
  const url = text(source.url);
  switch (spec?.semanticKind) {
    case 'read':
    case 'edit': return path.replace(/\\/g, '/').split('/').pop() || path;
    case 'search': return [query, path].filter(Boolean).join(' in ');
    case 'list': return path || '.';
    case 'web':
    case 'fetch': return url || query;
    case 'click': return text(source.selector) || target || description;
    case 'input': return text(source.selector) || text(source.key) || target || description;
    case 'scroll': return text(source.selector) || target || description || 'page';
    case 'capture': return description || target || 'browser';
    case 'generate': return description || message;
    case 'switch_mode': return action || description || toolName;
    case 'mcp': return text(source.toolName) || toolName;
    case 'task_create': return description || taskId;
    case 'task_update': return [taskId, action].filter(Boolean).join(' · ') || description;
    case 'task_read':
    case 'task_stop': return taskId || description;
    case 'task_list': return description || 'tasks';
    case 'message': return target || message;
    case 'wait': return target || description || taskId;
    case 'question': return message || description;
    case 'approval': return description || message;
    case 'subagent': return description || target || taskId;
    default: return '';
  }
}

export function resolveProviderToolDialect({ toolName, toolInput } = {}) {
  const normalizedToolName = normalizeProviderToolName(toolName);
  const input = normalizeProviderToolInput(toolInput);
  const inputObject = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const spec = TOOL_SPECS.get(normalizedToolName) || inferredSpec(normalizedToolName);
  if (!spec) return { normalizedToolName, input };
  const subject = subjectFor(spec, inputObject, text(toolName));
  const detail = spec.semanticKind === 'read' || spec.semanticKind === 'edit'
    ? text(inputObject.path)
    : subject;
  return {
    normalizedToolName,
    input,
    operationKind: spec.kind,
    semanticKind: spec.semanticKind,
    ...(subject ? { subject } : {}),
    ...(detail ? { detail } : {}),
    ...(text(inputObject.command) ? { command: text(inputObject.command) } : {}),
    ...(text(inputObject.path) ? { filePath: text(inputObject.path) } : {}),
  };
}

export function inferProviderFileChange({ toolName, toolInput } = {}) {
  const dialect = resolveProviderToolDialect({ toolName, toolInput });
  if (dialect.operationKind !== 'file_edit' || !dialect.filePath) return null;
  const input = dialect.input && typeof dialect.input === 'object' ? dialect.input : {};
  const action = text(input.command || input.action).toLowerCase();
  const changeType = ['delete', 'remove'].includes(action) ? 'delete'
    : (['create', 'write', 'add'].includes(action) ? 'add' : 'edit');
  return { filePath: dialect.filePath, changeType };
}

export function readProviderToolCallId(...sources) {
  for (const source of sources) {
    if (!(source && typeof source === 'object')) continue;
    const data = source.data && typeof source.data === 'object' ? source.data : {};
    for (const candidate of [
      source.providerToolUseId,
      source.toolCallId,
      source.tool_call_id,
      source.callId,
      source.call_id,
      source.actionId,
      source.action_id,
      data.providerToolUseId,
      data.toolCallId,
      data.tool_call_id,
      data.callId,
      data.call_id,
      data.actionId,
      data.action_id,
    ]) {
      const normalized = text(candidate);
      if (normalized) return normalized;
    }
  }
  return '';
}

export function normalizeProviderToolLifecycle(value, { update = false } = {}) {
  const state = text(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (['completed', 'complete', 'done', 'success', 'succeeded'].includes(state)) return 'completed';
  if (['failed', 'failure', 'error'].includes(state)) return 'failed';
  if (['cancelled', 'canceled', 'interrupted', 'aborted'].includes(state)) return 'cancelled';
  if (['waiting_approval', 'approval_required', 'waiting_for_confirmation'].includes(state)) return 'waiting_approval';
  if (['pending', 'queued', 'running', 'active', 'in_progress', 'inprogress', 'streaming', 'partial'].includes(state)) {
    return update ? 'delta' : 'started';
  }
  return update ? 'delta' : 'started';
}

function preferredObjectText(value, depth = 0, seen = new Set()) {
  if (!(value && typeof value === 'object') || Array.isArray(value) || depth > 4 || seen.has(value)) return '';
  seen.add(value);
  for (const key of ['content', 'text', 'output', 'result', 'message', 'error', 'detail']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
    if (Array.isArray(candidate)) {
      const joined = candidate
        .map((item) => (typeof item === 'string' ? item : text(item?.text || item?.content)))
        .filter(Boolean)
        .join('\n');
      if (joined) return joined;
    }
    if (candidate && typeof candidate === 'object') {
      const nested = preferredObjectText(candidate, depth + 1, seen);
      if (nested) return nested;
    }
  }
  return '';
}

export function serializeProviderToolValue(value, { maxChars = MAX_SERIALIZED_TOOL_VALUE_CHARS } = {}) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return redactSensitiveText(value).slice(0, maxChars);
  const preferred = preferredObjectText(value);
  if (preferred) return redactSensitiveText(preferred).slice(0, maxChars);
  let serialized;
  try {
    serialized = JSON.stringify(redactSensitiveValue(value), null, 2);
  } catch {
    serialized = String(value);
  }
  return redactSensitiveText(serialized).slice(0, maxChars);
}
