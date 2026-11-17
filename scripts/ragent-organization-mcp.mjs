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
const readTool = { name: 'ragent_organization_read', description: 'List or read authorized Ragent skills. The server validates this Run on every call.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    action: { type: 'string', enum: ['skills.list', 'skills.read', 'state.get', 'incidents.list', 'incident.get'] },
    args: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, expectedHash: { type: 'string' }, incidentId: { type: 'string' }, limit: { type: 'integer' } } },
  }, required: ['action'] } };
const actionTool = { name: 'ragent_organization_action', description: 'Acknowledge or resolve an assigned incident; resolution reports a handling decision, not proof that the Run recovered.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    action: { type: 'string', enum: ['incident.ack', 'incident.resolve'] },
    args: { type: 'object', additionalProperties: false, properties: { incidentId: { type: 'string' }, summary: { type: 'string' }, evidence: { type: 'string' } } },
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
        ((request.params?.name === readTool.name && ['skills.list', 'skills.read', 'state.get', 'incidents.list', 'incident.get'].includes(request.params?.arguments?.action)) ||
         (request.params?.name === actionTool.name && ['incident.ack', 'incident.resolve'].includes(request.params?.arguments?.action)))) {
      const response = await client.request(`/api/sessions/${encodeURIComponent(sessionId)}/organization/${endpoint}`, { method: 'POST', body: request.params.arguments || {} });
      result = { content: [{ type: 'text', text: JSON.stringify(response.json || { error: 'Organization request failed' }) }], ...(response.response.ok ? {} : { isError: true }) };
    } else { send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method unavailable' } }); continue; }
    send({ jsonrpc: '2.0', id: request.id, result });
  } catch { if (request?.id !== undefined) send({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: 'Organization request unavailable' }] } }); }
}
