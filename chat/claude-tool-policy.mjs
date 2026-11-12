// Explicit policy for Claude Code tool calls that do not execute a shell
// command or operate on a filesystem path. Unknown tools remain owner-gated.
export const CLAUDE_TOOL_POLICY_VERSION = 'claude-tool-policy/v1';

const SAFE_TOOLS = new Map([
  ['EnterPlanMode', 'enter plan mode'],
  ['Skill', 'load a skill definition'],
  ['TaskOutput', 'read a background task result'],
  ['TaskCreate', 'create a Claude task-list item'],
  ['TaskGet', 'read a Claude task-list item'],
  ['TaskList', 'read the Claude task list'],
  ['TaskUpdate', 'update a Claude task-list item'],
  ['TodoWrite', 'update the run-local task list'],
  ['ToolSearch', 'search the available tool catalog'],
]);

const CAUTION_TOOLS = new Map([
  ['WebSearch', 'send a read-only query to the web search service'],
  ['WebFetch', 'fetch a web page'],
]);

const FILE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'List', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
]);

function inputObject(approval) {
  const input = approval?.params?.input;
  return input && typeof input === 'object' && !Array.isArray(input) ? input : null;
}

function boundedJson(value) {
  try { return JSON.stringify(value).length <= 64 * 1024; } catch { return false; }
}

function validateSearchInput(input) {
  if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 2048) return false;
  const allowed = new Set(['query', 'allowed_domains', 'blocked_domains']);
  if (Object.keys(input).some((key) => !allowed.has(key))) return false;
  for (const key of ['allowed_domains', 'blocked_domains']) {
    if (input[key] === undefined) continue;
    if (!Array.isArray(input[key]) || input[key].length > 50
        || input[key].some((item) => typeof item !== 'string' || !item.trim() || item.length > 253)) return false;
  }
  return true;
}

function validateKnownInput(toolName, input) {
  if (!input || !boundedJson(input)) return false;
  if (toolName === 'WebSearch') return validateSearchInput(input);
  if (toolName === 'WebFetch') {
    if (Object.keys(input).some(key => !['url', 'prompt'].includes(key)) || typeof input.url !== 'string'
        || input.url.length > 8192 || typeof input.prompt !== 'string' || input.prompt.length > 32768) return false;
    try { const url = new URL(input.url); return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password; }
    catch { return false; }
  }
  if (toolName === 'Skill') return typeof input.skill === 'string' && input.skill.trim().length > 0 && input.skill.length <= 128
    && Object.keys(input).every((key) => ['skill', 'args'].includes(key))
    && (input.args === undefined || (typeof input.args === 'string' && input.args.length <= 4096));
  if (toolName === 'TaskOutput') return typeof (input.task_id || input.taskId) === 'string'
    && String(input.task_id || input.taskId).trim().length > 0
    && Object.keys(input).every((key) => ['task_id', 'taskId', 'block', 'timeout'].includes(key));
  const taskText = value => typeof value === 'string' && value.length <= 32768;
  const taskId = value => taskText(value) && value.trim().length > 0 && value.length <= 1024;
  const taskMetadata = value => value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value));
  if (toolName === 'TaskList') return Object.keys(input).length === 0;
  if (toolName === 'TaskGet') return taskId(input.taskId) && Object.keys(input).every(key => key === 'taskId');
  if (toolName === 'TaskCreate') return taskText(input.subject) && input.subject.trim().length > 0
    && taskText(input.description) && (input.activeForm === undefined || taskText(input.activeForm))
    && taskMetadata(input.metadata) && Object.keys(input).every(key => ['subject', 'description', 'activeForm', 'metadata'].includes(key));
  if (toolName === 'TaskUpdate') return taskId(input.taskId)
    && Object.keys(input).every(key => ['taskId', 'subject', 'description', 'activeForm', 'status', 'addBlocks', 'addBlockedBy', 'owner', 'metadata'].includes(key))
    && ['subject', 'description', 'activeForm', 'owner'].every(key => input[key] === undefined || taskText(input[key]))
    && (input.status === undefined || ['pending', 'in_progress', 'completed', 'deleted'].includes(input.status))
    && ['addBlocks', 'addBlockedBy'].every(key => input[key] === undefined || (Array.isArray(input[key]) && input[key].length <= 200 && input[key].every(taskId)))
    && taskMetadata(input.metadata);
  if (toolName === 'TodoWrite') return Array.isArray(input.todos) && input.todos.length <= 200
    && input.todos.every((todo) => todo && typeof todo === 'object' && !Array.isArray(todo));
  if (toolName === 'EnterPlanMode') return Object.keys(input).length === 0;
  if (toolName === 'ToolSearch') return typeof input.query === 'string' && input.query.trim().length > 0
    && input.query.length <= 2048 && Object.keys(input).every((key) => key === 'query');
  return false;
}

function riskFor(tier, reason) {
  return {
    tier,
    platform: 'provider-tool',
    confidence: 'high',
    policyVersion: CLAUDE_TOOL_POLICY_VERSION,
    signals: { reasons: [reason], network: tier === 'caution', irreversible: false },
    reasons: [{ code: `claude_tool_${tier}`, message: reason }],
  };
}

/** Return a provider-neutral decision for a known non-command Claude tool. */
export function decideClaudeToolApproval(approval, { riskMode = '' } = {}) {
  if (approval?.providerMethod !== 'can_use_tool') return null;
  if (approval?.requestClass && approval.requestClass !== 'tool_invocation') return null;
  const params = approval?.params && typeof approval.params === 'object' ? approval.params : {};
  if (params.networkApprovalContext || params.network_approval_context
      || params.additionalPermissions || params.additional_permissions) return null;
  const toolName = typeof approval?.params?.tool_name === 'string' ? approval.params.tool_name.trim() : '';
  if (!toolName || ['Bash', 'PowerShell', 'AskUserQuestion', 'ExitPlanMode'].includes(toolName)
      || FILE_TOOLS.has(toolName) || toolName.startsWith('mcp__')) return null;

  const reason = SAFE_TOOLS.get(toolName) || CAUTION_TOOLS.get(toolName);
  if (!reason) return null;
  const input = inputObject(approval);
  if (!validateKnownInput(toolName, input)) {
    const risk = riskFor('danger', `unrecognized or incomplete ${toolName} input`);
    return { decision: 'prompt', reason: `${risk.reasons[0].message}; owner approval required`, risk };
  }

  const tier = SAFE_TOOLS.has(toolName) ? 'safe' : 'caution';
  const risk = riskFor(tier, reason);
  const allowsCaution = ['recommended', 'full-auto'].includes(riskMode);
  if (tier === 'caution' && !allowsCaution) {
    return { decision: 'prompt', reason: `risk caution: ${reason}; safe mode requires owner approval`, risk };
  }
  return { decision: 'auto-allow', reason: `risk ${tier}: ${reason}`, risk };
}
