import { resolveProviderPermissionPolicy } from './provider-contract.mjs';
import { isAbsolute, resolve, win32 } from 'node:path';

export const CODEX_APP_SERVER_REQUEST_IDS = Object.freeze({
  initialize: 0,
  thread: 1,
  turn: 2,
  models: 3,
});

export const CODEX_APP_SERVER_MCP_STARTUP_STATES = Object.freeze([
  'starting',
  'ready',
  'failed',
  'cancelled',
]);

const CODEX_APP_SERVER_APPROVAL_METHOD_KINDS = Object.freeze({
  execCommandApproval: 'command',
  applyPatchApproval: 'file_change',
  'item/commandExecution/requestApproval': 'command',
  'item/fileChange/requestApproval': 'file_change',
  'item/permissions/requestApproval': 'permissions',
  'mcpServer/elicitation/request': 'permissions',
});

export function normalizeCodexAppServerPlanAction(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['revise', 'execute'].includes(normalized) ? normalized : '';
}

export function normalizeCodexAppServerInteractionMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'plan' ? 'plan' : 'agent';
}

export function buildCodexAppServerConfig(interactionMode) {
  return {
    mode: normalizeCodexAppServerInteractionMode(interactionMode) === 'plan' ? 'plan' : 'default',
  };
}

function resolveCodexAppServerPermissionPolicy({ interactionMode, permissionMode } = {}) {
  return resolveProviderPermissionPolicy('codex-app-server-json', {
    interactionMode,
    permissionMode,
  }) || {};
}

export function isCodexAppServerRagentApprovalGateEnabled({ riskMode, permissionMode, platform = process.platform } = {}) {
  const selectedRiskMode = String(riskMode || '').trim();
  const selectedPermissionMode = String(permissionMode || '').trim();
  const explicitUntrustedMode = selectedPermissionMode === 'untrusted' || selectedPermissionMode.startsWith('untrusted-');
  void platform;
  return explicitUntrustedMode
    || ['safe', 'recommended', 'full-auto', 'conservative-auto'].includes(selectedRiskMode);
}

function buildCodexAppServerApprovalPolicyParams(permissionPolicy, agentocApprovalGate) {
  // Ragent-gated runs derive the stricter approval policy from project trust.
  // The explicit approvalPolicy value "untrusted" was retired in Codex 0.149.
  if (permissionPolicy.approvalPolicy === 'untrusted' && agentocApprovalGate !== true) {
    throw new Error('Codex untrusted permission mode requires a Run-scoped project trust gate');
  }
  if (agentocApprovalGate === true) return {};
  return { approvalPolicy: permissionPolicy.approvalPolicy || 'never' };
}

function normalizeCodexWorkspacePath(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate) return '';
  if (win32.isAbsolute(candidate)) return win32.normalize(candidate).replace(/[\\/]+$/, '').toLowerCase();
  if (isAbsolute(candidate)) return resolve(candidate);
  return '';
}

export function validateCodexAppServerApprovalContext({ response, cwd, permissionMode } = {}) {
  const projectRoot = normalizeCodexWorkspacePath(cwd);
  const result = response && typeof response === 'object' ? response : {};
  if (result.approvalPolicy !== 'untrusted') {
    return { ok: false, reasonCode: 'CODEX_APPROVAL_POLICY_UNVERIFIED' };
  }
  if (result.approvalsReviewer !== 'user') {
    return { ok: false, reasonCode: 'CODEX_APPROVAL_REVIEWER_UNVERIFIED' };
  }
  if (!projectRoot || normalizeCodexWorkspacePath(result.cwd) !== projectRoot) {
    return { ok: false, reasonCode: 'CODEX_APPROVAL_CWD_UNVERIFIED' };
  }
  const roots = Array.isArray(result.runtimeWorkspaceRoots) ? result.runtimeWorkspaceRoots : [];
  if (!roots.some((root) => normalizeCodexWorkspacePath(root) === projectRoot)) {
    return { ok: false, reasonCode: 'CODEX_APPROVAL_WORKSPACE_ROOT_UNVERIFIED' };
  }

  const permissionPolicy = resolveCodexAppServerPermissionPolicy({ permissionMode });
  const expectedSandboxType = permissionPolicy.sandbox === 'workspace-write'
    ? 'workspaceWrite'
    : permissionPolicy.sandbox === 'read-only'
      ? 'readOnly'
      : 'dangerFullAccess';
  if (result.sandbox?.type !== expectedSandboxType) {
    return { ok: false, reasonCode: 'CODEX_APPROVAL_SANDBOX_UNVERIFIED' };
  }
  if (permissionPolicy.sandboxPolicy?.networkAccess === false && result.sandbox?.networkAccess !== false) {
    return { ok: false, reasonCode: 'CODEX_APPROVAL_NETWORK_BOUNDARY_UNVERIFIED' };
  }
  return { ok: true, reasonCode: null };
}

export function buildCodexAppServerThreadOptions({
  cwd,
  model,
  developerInstructions,
  interactionMode,
  permissionMode,
  agentocApprovalGate,
} = {}) {
  const permissionPolicy = resolveCodexAppServerPermissionPolicy({ interactionMode, permissionMode });
  const projectRoot = typeof cwd === 'string' ? cwd.trim() : '';
  const scopedProjectTrust = agentocApprovalGate === true && projectRoot
    && (isAbsolute(projectRoot) || win32.isAbsolute(projectRoot))
    ? { projects: { [projectRoot]: { trust_level: 'untrusted' } } }
    : {};
  return {
    ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}),
    ...(typeof cwd === 'string' && cwd.trim() ? { cwd: cwd.trim() } : {}),
    ...buildCodexAppServerApprovalPolicyParams(permissionPolicy, agentocApprovalGate),
    ...(agentocApprovalGate === true ? { approvalsReviewer: 'user' } : {}),
    sandbox: permissionPolicy.sandbox || 'danger-full-access',
    config: { ...buildCodexAppServerConfig(interactionMode), ...(agentocApprovalGate === true ? { allow_login_shell: false } : {}), ...scopedProjectTrust },
    ...(typeof developerInstructions === 'string' && developerInstructions.trim()
      ? { developerInstructions: developerInstructions.trim() }
      : {}),
  };
}

export function buildCodexAppServerInitializeMessage() {
  return {
    method: 'initialize',
    id: CODEX_APP_SERVER_REQUEST_IDS.initialize,
    params: {
      clientInfo: {
        name: 'agentoc',
        title: 'Ragent',
        version: '0.3.2',
      },
      capabilities: {
        experimentalApi: true,
      },
    },
  };
}

export function buildCodexAppServerInitializedNotification() {
  return {
    method: 'initialized',
  };
}

export function buildCodexAppServerModelListMessage({
  id = CODEX_APP_SERVER_REQUEST_IDS.models,
  cursor = '',
  limit = 100,
  includeHidden = false,
} = {}) {
  if (!(typeof id === 'string' || typeof id === 'number')) return null;
  const normalizedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.floor(Number(limit))
    : 100;
  const normalizedCursor = typeof cursor === 'string' ? cursor.trim() : '';
  return {
    method: 'model/list',
    id,
    params: {
      limit: normalizedLimit,
      includeHidden: includeHidden === true,
      ...(normalizedCursor ? { cursor: normalizedCursor } : {}),
    },
  };
}

export function buildCodexAppServerMcpServerStatusListMessage({
  id,
  threadId,
  detail = 'full',
} = {}) {
  if (!(typeof id === 'string' || typeof id === 'number')) return null;
  const normalizedDetail = detail === 'toolsAndAuthOnly' ? detail : 'full';
  return {
    method: 'mcpServerStatus/list',
    id,
    params: {
      detail: normalizedDetail,
      ...(typeof threadId === 'string' && threadId.trim() ? { threadId: threadId.trim() } : {}),
    },
  };
}

export function buildCodexAppServerThreadMessage({
  threadId,
  useResume,
  id = CODEX_APP_SERVER_REQUEST_IDS.thread,
  ...options
} = {}) {
  const threadOptions = buildCodexAppServerThreadOptions(options);
  if (useResume === true && typeof threadId === 'string' && threadId.trim()) {
    return {
      method: 'thread/resume',
      id,
      params: {
        threadId: threadId.trim(),
        ...threadOptions,
      },
    };
  }

  return {
    method: 'thread/start',
    id,
    params: threadOptions,
  };
}

export function buildCodexAppServerThreadForkMessage({
  id,
  threadId,
  ...options
} = {}) {
  const sourceThreadId = String(threadId || '').trim();
  if (!sourceThreadId) return null;
  return {
    method: 'thread/fork',
    id,
    params: {
      threadId: sourceThreadId,
      excludeTurns: true,
      threadSource: 'agentoc',
      ...buildCodexAppServerThreadOptions(options),
    },
  };
}

export function buildCodexAppServerInput(text) {
  return [{
    type: 'text',
    text: String(text || ''),
    text_elements: [],
  }];
}

export function buildCodexAppServerTurnStartMessage({
  threadId,
  text,
  clientUserMessageId,
  cwd,
  model,
  reasoningEffort,
  interactionMode,
  permissionMode,
  agentocApprovalGate,
} = {}) {
  const permissionPolicy = resolveCodexAppServerPermissionPolicy({ interactionMode, permissionMode });
  return {
    method: 'turn/start',
    id: CODEX_APP_SERVER_REQUEST_IDS.turn,
    params: {
      threadId: String(threadId || '').trim(),
      ...(typeof clientUserMessageId === 'string' && clientUserMessageId.trim()
        ? { clientUserMessageId: clientUserMessageId.trim() }
        : {}),
      input: buildCodexAppServerInput(text),
      ...(typeof cwd === 'string' && cwd.trim() ? { cwd: cwd.trim() } : {}),
      ...buildCodexAppServerApprovalPolicyParams(permissionPolicy, agentocApprovalGate),
      ...(agentocApprovalGate === true ? { approvalsReviewer: 'user' } : {}),
      sandboxPolicy: permissionPolicy.sandboxPolicy?.type === 'workspaceWrite'
        ? {
          ...permissionPolicy.sandboxPolicy,
          // turn/start carries an explicit policy: an empty roots list does
          // not grant the requested Session workspace. Bind only its absolute
          // cwd; keep network and approval restrictions unchanged.
          writableRoots: typeof cwd === 'string' && (isAbsolute(cwd.trim()) || win32.isAbsolute(cwd.trim()))
            ? [cwd.trim()]
            : [],
        }
        : (permissionPolicy.sandboxPolicy || { type: 'dangerFullAccess' }),
      ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}),
      ...(typeof reasoningEffort === 'string' && reasoningEffort.trim() ? { effort: reasoningEffort.trim() } : {}),
    },
  };
}

export function buildCodexAppServerTurnSteerMessage({
  id,
  threadId,
  turnId,
  text,
  clientUserMessageId,
} = {}) {
  return {
    method: 'turn/steer',
    id,
    params: {
      threadId: String(threadId || '').trim(),
      expectedTurnId: String(turnId || '').trim(),
      ...(typeof clientUserMessageId === 'string' && clientUserMessageId.trim()
        ? { clientUserMessageId: clientUserMessageId.trim() }
        : {}),
      input: buildCodexAppServerInput(text),
    },
  };
}

export function buildCodexAppServerTurnInterruptMessage({
  id,
  threadId,
  turnId,
} = {}) {
  return {
    method: 'turn/interrupt',
    id,
    params: {
      threadId: String(threadId || '').trim(),
      turnId: String(turnId || '').trim(),
    },
  };
}

// --- Thread goal RPCs (codex goal mode) ---
// Wire methods are camelCase `threadGoal/*` (host→server requests); the
// corresponding server→host notifications are slash-style `thread/goal/*`.
// The goal object serializes with camelCase fields (objective, status,
// tokenBudget, tokensUsed, timeUsedSeconds, ...); accept snake_case fallbacks
// defensively in case the host RPC mirrors the model tool's snake_case shape.

export function buildCodexAppServerThreadGoalSetMessage({
  id,
  threadId,
  objective,
  tokenBudget,
} = {}) {
  const trimmedThread = String(threadId || '').trim();
  const trimmedObjective = String(objective || '').trim();
  if (!trimmedThread || !trimmedObjective) return null;
  const params = {
    threadId: trimmedThread,
    objective: trimmedObjective,
  };
  if (Number.isFinite(tokenBudget) && tokenBudget > 0) {
    params.tokenBudget = Math.floor(tokenBudget);
  }
  return { method: 'threadGoal/set', id, params };
}

export function buildCodexAppServerThreadGoalGetMessage({ id, threadId } = {}) {
  const trimmedThread = String(threadId || '').trim();
  if (!trimmedThread) return null;
  return { method: 'threadGoal/get', id, params: { threadId: trimmedThread } };
}

export function buildCodexAppServerThreadGoalClearMessage({ id, threadId } = {}) {
  const trimmedThread = String(threadId || '').trim();
  if (!trimmedThread) return null;
  return { method: 'threadGoal/clear', id, params: { threadId: trimmedThread } };
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasJsonRpcRequestId(message) {
  return typeof message?.id === 'string' || typeof message?.id === 'number';
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function readMcpToolInventory(tools) {
  // MCP tool inventory may be returned as either:
  // 1. Array format: [{ name, inputSchema, ... }, ...] (Codex)
  // 2. Object format: { 'toolName': { name, inputSchema, ... }, ... } (AgentoC MCP server)
  if (!tools || typeof tools !== 'object') {
    return {
      schemaAvailable: false,
      toolNames: [],
    };
  }

  let entries;
  if (Array.isArray(tools)) {
    // Array format: map index to tool for consistent processing
    entries = tools.map((tool, idx) => [String(idx), tool]);
  } else {
    // Object format: use Object.entries
    entries = Object.entries(tools);
  }

  const validEntries = entries.filter(([, tool]) => (
    isRecord(tool)
    && typeof tool.name === 'string'
    && tool.name.trim().length > 0
    && hasOwn(tool, 'inputSchema')
    && isRecord(tool.inputSchema)
  ));
  return {
    schemaAvailable: entries.length > 0 && validEntries.length === entries.length,
    toolNames: validEntries
      .map(([, tool]) => trimString(tool.name))
      .filter(Boolean),
  };
}

export function readCodexAppServerMcpStartupStatus(message) {
  if (!message || typeof message !== 'object' || message.method !== 'mcpServer/startupStatus/updated') {
    return null;
  }
  const params = isRecord(message.params) ? message.params : {};
  const name = trimString(params.name || params.serverName || params.server_name);
  const status = trimString(params.status).toLowerCase();
  if (!name || !CODEX_APP_SERVER_MCP_STARTUP_STATES.includes(status)) return null;
  return {
    name,
    status,
    threadId: trimString(params.threadId),
    hasError: typeof params.error === 'string' && params.error.trim().length > 0,
  };
}

export function readCodexAppServerMcpStatusList(message) {
  if (!message || typeof message !== 'object' || !isRecord(message.result)) return null;
  if (!Array.isArray(message.result.data)) return null;
  return message.result.data.map((entry) => {
    const record = isRecord(entry) ? entry : {};
    const name = trimString(record.name || record.serverName || record.server_name);
    const inventory = readMcpToolInventory(record.tools);
    return {
      name,
      schemaAvailable: inventory.schemaAvailable,
      toolNames: inventory.toolNames,
    };
  });
}

export function evaluateCodexAppServerMcpReadiness({
  inventory,
  startupStatuses,
  expectedServerName,
  requiredToolNames = [],
  requiredServers = [],
} = {}) {
  const records = Array.isArray(inventory) ? inventory : null;
  const statuses = isRecord(startupStatuses) ? startupStatuses : {};
  const expectedName = trimString(expectedServerName);
  const requiredTools = [...new Set(
    (Array.isArray(requiredToolNames) ? requiredToolNames : [])
      .map((value) => trimString(value))
      .filter(Boolean),
  )];
  const groupedRequirements = Array.isArray(requiredServers)
    ? requiredServers.map((server) => ({
      name: trimString(server?.name),
      requiredToolNames: [...new Set(
        (Array.isArray(server?.requiredToolNames) ? server.requiredToolNames : server?.toolNames || [])
          .map((value) => trimString(value))
          .filter(Boolean),
      )],
    })).filter((server) => server.name)
    : [];

  if (!records) return { state: 'waiting', reasonCode: 'MCP_DISCOVERY_PENDING' };
  if (groupedRequirements.length > 0) {
    const readyServers = [];
    for (const requirement of groupedRequirements) {
      const target = records.find((entry) => entry?.name === requirement.name);
      const startup = trimString(statuses[requirement.name]).toLowerCase();
      if (startup === 'failed') return { state: 'failed', reasonCode: 'MCP_STARTUP_FAILED', serverName: requirement.name };
      if (startup === 'cancelled') return { state: 'failed', reasonCode: 'MCP_STARTUP_CANCELLED', serverName: requirement.name };
      if (!target) {
        return startup === 'ready'
          ? { state: 'failed', reasonCode: 'MCP_SERVER_NOT_DISCOVERED', serverName: requirement.name }
          : { state: 'waiting', reasonCode: 'MCP_SERVER_DISCOVERY_PENDING', serverName: requirement.name };
      }
      if (startup !== 'ready') {
        return { state: 'waiting', reasonCode: startup ? 'MCP_STARTUP_PENDING' : 'MCP_READY_UNCONFIRMED', serverName: requirement.name };
      }
      if (target.schemaAvailable !== true) {
        return { state: 'failed', reasonCode: 'MCP_TOOL_SCHEMA_UNAVAILABLE', serverName: requirement.name };
      }
      const availableTools = new Set(Array.isArray(target.toolNames) ? target.toolNames : []);
      const missingTools = requirement.requiredToolNames.filter((name) => !availableTools.has(name));
      if (missingTools.length > 0) {
        return {
          state: 'failed',
          reasonCode: 'MCP_REQUIRED_TOOL_MISSING',
          serverName: requirement.name,
          missingTools,
        };
      }
      readyServers.push({ name: requirement.name, toolNames: [...availableTools] });
    }
    return {
      state: 'ready',
      reasonCode: '',
      serverName: readyServers[0]?.name || '',
      toolNames: readyServers.flatMap((server) => server.toolNames),
      servers: readyServers,
    };
  }
  if (!expectedName && records.length === 0) {
    return { state: 'ready', reasonCode: '' };
  }

  const target = expectedName
    ? records.find((entry) => entry?.name === expectedName)
    : records[0];
  const targetName = expectedName || trimString(target?.name);
  const startup = targetName ? trimString(statuses[targetName]).toLowerCase() : '';
  if (startup === 'failed') return { state: 'failed', reasonCode: 'MCP_STARTUP_FAILED' };
  if (startup === 'cancelled') return { state: 'failed', reasonCode: 'MCP_STARTUP_CANCELLED' };
  if (!target) {
    return startup === 'ready'
      ? { state: 'failed', reasonCode: 'MCP_SERVER_NOT_DISCOVERED' }
      : { state: 'waiting', reasonCode: 'MCP_SERVER_DISCOVERY_PENDING' };
  }
  if (startup !== 'ready') {
    return { state: 'waiting', reasonCode: startup ? 'MCP_STARTUP_PENDING' : 'MCP_READY_UNCONFIRMED' };
  }
  if (target.schemaAvailable !== true) {
    return { state: 'failed', reasonCode: 'MCP_TOOL_SCHEMA_UNAVAILABLE' };
  }
  const availableTools = new Set(Array.isArray(target.toolNames) ? target.toolNames : []);
  const missingTools = requiredTools.filter((name) => !availableTools.has(name));
  if (missingTools.length > 0) {
    return {
      state: 'failed',
      reasonCode: 'MCP_REQUIRED_TOOL_MISSING',
      missingTools,
    };
  }
  return {
    state: 'ready',
    reasonCode: '',
    serverName: targetName,
    toolNames: [...availableTools],
  };
}

export function readCodexAppServerApprovalRequest(message) {
  if (!message || typeof message !== 'object' || !hasJsonRpcRequestId(message)) return null;
  const method = trimString(message.method);
  const kind = CODEX_APP_SERVER_APPROVAL_METHOD_KINDS[method] || '';
  if (!kind) return null;
  const providerRequestId = message.id;
  return {
    approvalId: `${method}:${String(providerRequestId)}`,
    providerRequestId,
    providerRequestIdString: String(providerRequestId),
    providerMethod: method,
    kind,
    requestClass: kind === 'command' ? 'command_invocation'
      : kind === 'file_change' ? 'file_change'
        : method === 'mcpServer/elicitation/request' ? 'mcp_elicitation' : 'capability_grant',
    params: message.params && typeof message.params === 'object' ? message.params : {},
    request: message,
  };
}

export function readCodexAppServerManagedMcpRequest(message) {
  const approval = readCodexAppServerApprovalRequest(message);
  if (!approval || approval.providerMethod !== 'mcpServer/elicitation/request') return null;
  const params = approval.params || {};
  const serverName = trimString(params.serverName || params.server_name);
  // Only Codex's own empty tool-call confirmation may be auto-accepted.
  // An MCP server's ordinary elicitation may ask for credentials or a real
  // user decision, even when it comes from an otherwise managed server.
  const schema = params.requestedSchema;
  if (!serverName || params.mode !== 'form' || params._meta?.codex_approval_kind !== 'mcp_tool_call' ||
      !schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties) ||
      Object.keys(schema.properties).length !== 0 || (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length !== 0))) return null;
  return {
    ...approval,
    mcpServerName: serverName,
  };
}

export function normalizeCodexAppServerApprovalDecision(value) {
  const normalized = trimString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (['approve', 'approved', 'accept', 'allow', 'allow_once'].includes(normalized)) return 'approve';
  if (['approve_for_session', 'approved_for_session', 'accept_for_session', 'acceptforsession', 'allow_for_session'].includes(normalized)) {
    return 'approve_for_session';
  }
  if (['deny', 'denied', 'decline', 'declined', 'reject', 'rejected'].includes(normalized)) return 'deny';
  if (['cancel', 'cancelled', 'canceled', 'abort'].includes(normalized)) return 'cancel';
  return '';
}

export function formatCodexAppServerApprovalDecision(decision) {
  const normalized = normalizeCodexAppServerApprovalDecision(decision);
  if (normalized === 'approve') return 'approved';
  if (normalized === 'approve_for_session') return 'approved_for_session';
  if (normalized === 'cancel') return 'cancelled';
  return normalized === 'deny' ? 'denied' : '';
}

function buildLegacyReviewDecision(decision) {
  const normalized = normalizeCodexAppServerApprovalDecision(decision);
  if (normalized === 'approve') return 'approved';
  if (normalized === 'approve_for_session') return 'approved_for_session';
  if (normalized === 'cancel') return 'abort';
  return 'denied';
}

function buildCommandExecutionDecision(decision) {
  const normalized = normalizeCodexAppServerApprovalDecision(decision);
  if (normalized === 'approve') return 'accept';
  if (normalized === 'approve_for_session') return 'acceptForSession';
  if (normalized === 'cancel') return 'cancel';
  return 'decline';
}

function buildFileChangeDecision(decision) {
  const normalized = normalizeCodexAppServerApprovalDecision(decision);
  if (normalized === 'approve') return 'accept';
  if (normalized === 'approve_for_session') return 'acceptForSession';
  if (normalized === 'cancel') return 'cancel';
  return 'decline';
}

function buildPermissionsResponse(decision, params = {}) {
  const normalized = normalizeCodexAppServerApprovalDecision(decision);
  if (normalized === 'approve' || normalized === 'approve_for_session') {
    const requestedPermissions = params?.permissions && typeof params.permissions === 'object'
      ? params.permissions
      : {};
    return {
      permissions: {
        ...(requestedPermissions.network ? { network: requestedPermissions.network } : {}),
        ...(requestedPermissions.fileSystem ? { fileSystem: requestedPermissions.fileSystem } : {}),
      },
      scope: normalized === 'approve_for_session' ? 'session' : 'turn',
    };
  }
  return {
    permissions: {},
    scope: 'turn',
    strictAutoReview: true,
  };
}

export function buildCodexAppServerApprovalResponseMessage(request, decision) {
  const approval = readCodexAppServerApprovalRequest(request?.request || request) || request;
  const method = trimString(approval?.providerMethod || approval?.method);
  const id = Object.prototype.hasOwnProperty.call(approval || {}, 'providerRequestId')
    ? approval.providerRequestId
    : approval?.id;
  const params = approval?.params && typeof approval.params === 'object' ? approval.params : {};
  if (!(typeof id === 'string' || typeof id === 'number')) return null;

  let result = null;
  switch (method) {
    case 'execCommandApproval':
    case 'applyPatchApproval':
      result = { decision: buildLegacyReviewDecision(decision) };
      break;
    case 'item/commandExecution/requestApproval':
      result = { decision: buildCommandExecutionDecision(decision) };
      break;
    case 'item/fileChange/requestApproval':
      result = { decision: buildFileChangeDecision(decision) };
      break;
    case 'item/permissions/requestApproval':
      result = buildPermissionsResponse(decision, params);
      break;
    case 'mcpServer/elicitation/request': {
      const normalized = normalizeCodexAppServerApprovalDecision(decision);
      result = normalized === 'approve' || normalized === 'approve_for_session'
        ? { action: 'accept', content: {} }
        : { action: 'decline' };
      break;
    }
    default:
      return null;
  }

  return { id, result };
}

export function readCodexAppServerThreadId(message) {
  if (!message || typeof message !== 'object') return '';
  const fromResult = message.result?.thread?.id;
  if (typeof fromResult === 'string' && fromResult.trim()) return fromResult.trim();
  const fromNotification = message.params?.thread?.id;
  if (message.method === 'thread/started' && typeof fromNotification === 'string' && fromNotification.trim()) {
    return fromNotification.trim();
  }
  return '';
}

function readThreadIdCandidate(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

// App-server notifications from delegated threads are multiplexed onto the
// same stdout stream as the parent thread. Keep this correlation separate from
// readCodexAppServerThreadId(), whose narrower contract is the persisted resume
// cursor emitted by thread/start or thread/resume.
export function readCodexAppServerEventThreadId(message) {
  if (!message || typeof message !== 'object') return '';
  return readThreadIdCandidate(
    message.result?.thread?.id,
    message.result?.threadId,
    message.result?.thread_id,
    message.params?.thread?.id,
    message.params?.threadId,
    message.params?.thread_id,
    message.params?.turn?.threadId,
    message.params?.turn?.thread_id,
  );
}

// A response to our own turn/start request may omit threadId, so its JSON RPC
// id is the only safe no-thread fallback. Notifications without a thread
// identity fail closed; otherwise a child turn could overwrite the parent's
// turn cursor or terminate the parent run.
export function isCodexAppServerEventForThread(message, expectedThreadId) {
  const expected = typeof expectedThreadId === 'string' ? expectedThreadId.trim() : '';
  if (!expected) return true;
  const actual = readCodexAppServerEventThreadId(message);
  if (actual) return actual === expected;
  return message?.id === CODEX_APP_SERVER_REQUEST_IDS.turn
    && (!!message?.result?.turn || !!message?.error);
}

export function readCodexAppServerTurnId(message) {
  if (!message || typeof message !== 'object') return '';
  const fromResult = message.result?.turn?.id;
  if (typeof fromResult === 'string' && fromResult.trim()) return fromResult.trim();
  const fromNotification = message.params?.turn?.id;
  if (message.method === 'turn/started' && typeof fromNotification === 'string' && fromNotification.trim()) {
    return fromNotification.trim();
  }
  return '';
}

// Unlike readCodexAppServerTurnId(), this reads the turn identity from any
// provider event. The narrower helper is intentionally kept for capturing a
// newly started turn so a replayed completion cannot replace the active turn.
export function readCodexAppServerEventTurnId(message) {
  if (!message || typeof message !== 'object') return '';
  return readThreadIdCandidate(
    message.result?.turn?.id,
    message.result?.turnId,
    message.result?.turn_id,
    message.params?.turn?.id,
    message.params?.turnId,
    message.params?.turn_id,
  );
}

// Extract a normalized goal snapshot from a `thread/goal/updated` notification,
// a `threadGoal/get` response, or a raw goal object. Returns null when there is
// no meaningful goal (no objective and no status). Accepts camelCase (the
// serialized ThreadGoal shape) and snake_case fallbacks.
export function readCodexAppServerGoalFields(goal) {
  if (!goal || typeof goal !== 'object') return null;
  const objective = typeof goal.objective === 'string' ? goal.objective.trim() : '';
  const status = typeof goal.status === 'string' ? goal.status.trim() : '';
  if (!objective && !status) return null;
  const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);
  return {
    objective,
    status,
    tokenBudget: finiteOrNull(goal.tokenBudget ?? goal.token_budget),
    tokensUsed: finiteOrNull(goal.tokensUsed ?? goal.tokens_used),
    timeUsedSeconds: finiteOrNull(goal.timeUsedSeconds ?? goal.time_used_seconds),
    createdAt: typeof goal.createdAt === 'string' ? goal.createdAt : '',
    updatedAt: typeof goal.updatedAt === 'string' ? goal.updatedAt : '',
  };
}

// Locate the goal payload on a notification/response message. The
// `thread/goal/updated` notification carries the goal under `params.goal`;
// some payloads may flatten it onto `params` directly. A `threadGoal/get`
// response carries it under `result`.
export function readCodexAppServerGoalPayload(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.result && typeof message.result === 'object') return message.result;
  const params = message.params;
  if (params && typeof params === 'object') {
    if (params.goal && typeof params.goal === 'object') return params.goal;
    return params;
  }
  return null;
}

export function isCodexAppServerTurnTerminalMessage(message, expectedTurnId = '') {
  // A turn/start JSON-RPC error has no provider turn id because the turn was
  // never created. Its fixed request id is the only available correlation.
  if (message?.error && message?.id === CODEX_APP_SERVER_REQUEST_IDS.turn) return true;

  const expected = typeof expectedTurnId === 'string' ? expectedTurnId.trim() : '';
  const actual = readCodexAppServerEventTurnId(message);
  if (!expected || !actual || actual !== expected) return false;

  if (message?.method === 'turn/completed') {
    return ['completed', 'interrupted', 'failed'].includes(message?.params?.turn?.status);
  }
  return message?.method === 'error' && message?.params?.willRetry !== true;
}
