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
const readTool = { name: 'ragent_organization_read', description: 'Read authorized skills, organization state and runtime candidates. The server validates this Run on every call.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    action: { type: 'string', enum: ['skills.list', 'skills.read', 'candidates.query', 'state.get', 'plan.status', 'incidents.list', 'incident.get'] },
    args: { type: 'object', additionalProperties: false, properties: { ifDigest: { type: 'string' }, id: { type: 'string' }, expectedHash: { type: 'string' }, incidentId: { type: 'string' }, limit: { type: 'integer' }, offset: { type: 'integer' }, agentId: { type: 'string' }, taskRole: { type: 'string', enum: ['manager', 'specialist', 'reviewer'] }, nodeKey: { type: 'string' }, tool: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, requirements: { type: 'object', additionalProperties: false, properties: { tools: { type: 'array', items: { type: 'string' } }, environment: { type: 'string' }, minimumContextTokens: { type: 'integer' }, advancedRequired: { type: 'boolean' }, qualityFloor: { type: 'string' } } } } },
  }, required: ['action'] } };
const actionTool = { name: 'ragent_organization_action', description: 'Submit one root organization proposal, dispatch an authorized existing child once per revision, or acknowledge or resolve an assigned incident. A proposal is not a dispatched Run; incident resolution is not proof that a Run recovered.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    action: { type: 'string', enum: ['incident.ack', 'incident.resolve', 'plan.submit', 'node.dispatch'] },
    args: { type: 'object', additionalProperties: false, properties: { childNodeId: { type: 'string' }, incidentId: { type: 'string' }, summary: { type: 'string' }, evidence: { type: 'string' }, proposal: { type: 'object' } } },
  }, required: ['action', 'args'] } };
const client = valid ? createRagentHttpClient({ sessionControlToken: token, sessionControlRunId: runId, sessionControlSessionId: sessionId, sessionControlTurnId: turnId }) : null;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request;
  try {
    request = JSON.parse(line);
    if (request.id === undefined) continue;
    let result;
    if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ragent-organization', version: '1.0.0' } };
    else if (request.method === 'ping') result = {};
    else if (request.method === 'tools/list') result = { tools: valid ? [readTool, actionTool] : [] };
    else if (request.method === 'tools/call' && valid &&
        ((request.params?.name === readTool.name && ['skills.list', 'skills.read', 'candidates.query', 'state.get', 'plan.status', 'incidents.list', 'incident.get'].includes(request.params?.arguments?.action)) ||
         (request.params?.name === actionTool.name && ['incident.ack', 'incident.resolve', 'plan.submit', 'node.dispatch'].includes(request.params?.arguments?.action)))) {
      const response = await client.request(`/api/sessions/${encodeURIComponent(sessionId)}/organization/${endpoint}`, { method: 'POST', body: request.params.arguments || {} });
      result = { content: [{ type: 'text', text: JSON.stringify(response.json || { error: 'Organization request failed' }) }], ...(response.response.ok ? {} : { isError: true }) };
    } else { send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method unavailable' } }); continue; }
    send({ jsonrpc: '2.0', id: request.id, result });
  } catch { if (request?.id !== undefined) send({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: 'Organization request unavailable' }] } }); }
}
