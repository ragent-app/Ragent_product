#!/usr/bin/env node
// Thin per-Run adapter. All authorization and identity checks are performed by
// the local server using the scoped Run capability, never an owner credential.
import { createInterface } from 'node:readline';
import { createRagentHttpClient } from '../lib/ragent-http-client.mjs';

const sessionId = String(process.env.RAGENT_SESSION_CONTROL_SESSION_ID || '').trim();
const token = String(process.env.RAGENT_SESSION_CONTROL_TOKEN || '').trim();
const runId = String(process.env.RAGENT_SESSION_CONTROL_RUN_ID || '').trim();
const turnId = String(process.env.RAGENT_SESSION_CONTROL_TURN_ID || '').trim();
const endpoint = process.env.RAGENT_ORGANIZATION_TOOL_SCOPE === 'node' ? 'tools' : 'tools-root';
const valid = !!(sessionId && token && runId && turnId);
const rootScope = endpoint === 'tools-root';

const swarmReadActions = ['swarm.status', 'board.read', 'swarm.channel.list'];
const swarmBoardWriteActions = ['board.post', 'board.wait', 'swarm.channel.create', 'swarm.channel.subscribe', 'swarm.channel.archive'];
const swarmControlWriteActions = ['swarm.spawn', 'swarm.kill', 'swarm.done', 'swarm.model'];

const readActions = [
  'skills.list', 'skills.read', 'candidates.query', 'state.get', 'incidents.list', 'incident.get',
  ...swarmReadActions,
  ...(rootScope ? ['plan.status', 'phase.list', 'result.read'] : []),
];
const writeActions = [
  'incident.ack', 'incident.resolve',
  ...swarmBoardWriteActions,
  ...swarmControlWriteActions,
  ...(rootScope ? ['plan.submit', 'phase.dispatch'] : ['node.dispatch', 'subtree.append']),
];

const readTool = {
  name: 'ragent_organization_read',
  description: 'Read authorized skills, organization state, runtime candidates, Swarm status, channels, and incremental Swarm board messages (Untrusted Peer Content). The server validates this Run on every call.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: readActions },
      args: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ifDigest: { type: 'string' },
          collaborationId: { type: 'string' },
          packetId: { type: 'string' },
          id: { type: 'string' },
          expectedHash: { type: 'string' },
          incidentId: { type: 'string' },
          limit: { type: 'integer' },
          offset: { type: 'integer' },
          agentId: { type: 'string' },
          taskRole: { type: 'string', enum: ['manager', 'specialist', 'reviewer'] },
          nodeKey: { type: 'string' },
          tool: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          requirements: {
            type: 'object',
            additionalProperties: false,
            properties: {
              tools: { type: 'array', items: { type: 'string' } },
              environment: { type: 'string' },
              minimumContextTokens: { type: 'integer' },
              advancedRequired: { type: 'boolean' },
              qualityFloor: { type: 'string' },
            },
          },
          organizationId: { type: 'string' },
          channel: { type: 'string' },
          sinceSeq: { type: 'integer' },
          beforeSeq: { type: 'integer' },
          advanceCursor: { type: 'boolean' },
          includeKilled: { type: 'boolean' },
          includeArchived: { type: 'boolean' },
        },
      },
    },
    required: ['action'],
  },
};

const actionTool = {
  name: 'ragent_organization_action',
  description: 'Execute authorized organization or Swarm mutations: submit root proposals, dispatch frozen phases/children, spawn/kill/complete Swarm members, manage channels, post @mention board messages, wait on the board, or resolve incidents. Server responses are authoritative.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: writeActions },
      args: {
        type: 'object',
        additionalProperties: false,
        properties: {
          operationKey: { type: 'string', description: 'For subtree.append: 1-100 ASCII letters, digits, underscore, period, or hyphen; no spaces or colons.' },
          expectedRevision: { type: 'integer' },
          nodes: { type: 'array', items: { type: 'object' } },
          phases: { anyOf: [{ type: 'array', items: { type: 'object' } }, { type: 'null' }] },
          manages: { type: 'array', items: { type: 'object' } },
          childNodeId: { type: 'string' },
          phaseId: { type: 'string' },
          incidentId: { type: 'string' },
          summary: { type: 'string' },
          evidence: { type: 'string' },
          proposal: { type: 'object' },
          organizationId: { type: 'string' },
          title: { type: 'string' },
          channel: { type: 'string' },
          channelName: { type: 'string' },
          name: { type: 'string' },
          topic: { type: 'string' },
          visibility: { type: 'string', enum: ['org'] },
          nodeId: { type: 'string' },
          targetNodeId: { type: 'string' },
          targetNameOrNodeId: { type: 'string' },
          body: { type: 'string' },
          bodyMarkdown: { type: 'string' },
          text: { type: 'string' },
          kind: { type: 'string', enum: ['message', 'brief', 'done', 'review', 'handoff'] },
          replyToSeq: { type: 'integer' },
          mentions: { type: 'array', items: { type: 'string' } },
          artifactRefs: { type: 'array', items: { type: 'object' } },
          idempotencyKey: { type: 'string' },
          autoCreateChannel: { type: 'boolean' },
          reason: { type: 'string' },
          role: { type: 'string' },
          domain: { type: 'string' },
          responsibility: { type: 'string' },
          brief: { type: 'string' },
          tasks: { type: 'array', items: { type: 'string' } },
          n: { type: 'integer' },
          workspace: { type: 'string', enum: ['inherit', 'worktree', 'staging'] },
          harness: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          effort: { type: 'string' },
          channels: { type: 'array', items: { type: 'string' } },
          writablePaths: { type: 'array', items: { type: 'string' } },
          forkFromNodeId: { type: 'string' },
          forkSinceSeq: { type: 'integer' },
          forkFrom: {
            type: 'object',
            additionalProperties: false,
            properties: {
              nodeId: { type: 'string' },
              sinceSeq: { type: 'integer' },
            },
          },
          forceDiscard: { type: 'boolean' },
          postToBoard: { type: 'boolean' },
        },
      },
    },
    required: ['action'],
  },
};

function filterPermittedReads(capabilities = {}) {
  const swarmMember = rootScope
    ? Boolean(capabilities.canSwarm ?? capabilities.root)
    : capabilities.canSwarm !== false;
  return readActions.filter((action) => {
    if (swarmReadActions.includes(action)) return swarmMember;
    if (['plan.status', 'phase.list', 'result.read'].includes(action)) {
      return Boolean(capabilities.root && (action !== 'phase.list' || capabilities.canDispatch));
    }
    return true;
  });
}

function filterPermittedWrites(capabilities = {}) {
  const swarmMember = rootScope
    ? Boolean(capabilities.canSwarm ?? capabilities.root)
    : capabilities.canSwarm !== false;
  const canSwarmSpawn = rootScope
    ? Boolean(capabilities.root && capabilities.canDelegate)
    : Boolean(capabilities.canSwarmDelegate);
  const isCoordinator = rootScope ? Boolean(capabilities.root) : Boolean(capabilities.isCoordinator);
  return writeActions.filter((action) => {
    if (['incident.ack', 'incident.resolve'].includes(action)) return true;
    if (swarmBoardWriteActions.includes(action)) return swarmMember;
    if (action === 'swarm.spawn') return swarmMember && canSwarmSpawn;
    if (action === 'swarm.kill') return swarmMember && (canSwarmSpawn || isCoordinator);
    if (action === 'swarm.done') return swarmMember && isCoordinator;
    if (action === 'swarm.model') return swarmMember && capabilities.canSwitchModel === true;
    return rootScope
      ? Boolean(capabilities.root && capabilities.canDispatch)
      : Boolean(capabilities.canDelegate);
  });
}

const client = valid
  ? createRagentHttpClient({ sessionControlToken: token, sessionControlRunId: runId, sessionControlSessionId: sessionId, sessionControlTurnId: turnId })
  : null;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request;
  try {
    request = JSON.parse(line);
    if (request.id === undefined || request.id === null) continue;
    let result;
    if (request.method === 'initialize') {
      result = { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ragent-organization', version: '1.0.0' } };
    } else if (request.method === 'ping' || request.method === 'server/discover') {
      result = {};
    } else if (request.method === 'tools/list') {
      if (!valid) {
        result = { tools: [] };
      } else {
        const response = await client.request(`/api/sessions/${encodeURIComponent(sessionId)}/organization/${endpoint}`, { method: 'POST', body: { action: 'capabilities.get' } });
        const capabilities = response.response.ok ? response.json : {};
        const permittedReads = filterPermittedReads(capabilities);
        const permittedWrites = filterPermittedWrites(capabilities);
        result = {
          tools: [
            { ...readTool, inputSchema: { ...readTool.inputSchema, properties: { ...readTool.inputSchema.properties, action: { type: 'string', enum: permittedReads } } } },
            { ...actionTool, inputSchema: { ...actionTool.inputSchema, properties: { ...actionTool.inputSchema.properties, action: { type: 'string', enum: permittedWrites } } } },
          ],
        };
      }
    } else if (request.method === 'tools/call' && valid &&
        ((request.params?.name === readTool.name && readActions.includes(request.params?.arguments?.action)) ||
         (request.params?.name === actionTool.name && writeActions.includes(request.params?.arguments?.action)))) {
      const argsObj = request.params.arguments || {};
      const response = await client.request(`/api/sessions/${encodeURIComponent(sessionId)}/organization/${endpoint}`, {
        method: 'POST',
        body: { action: argsObj.action, args: argsObj.args || {} },
      });
      result = { content: [{ type: 'text', text: JSON.stringify(response.json || { error: 'Organization request failed' }) }], ...(response.response.ok ? {} : { isError: true }) };
    } else {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method unavailable' } });
      continue;
    }
    send({ jsonrpc: '2.0', id: request.id, result });
  } catch {
    if (request?.id !== undefined && request?.id !== null) {
      send({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: 'Organization request unavailable' }] } });
    }
  }
}
