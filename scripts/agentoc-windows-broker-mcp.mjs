#!/usr/bin/env node
// A Run-scoped request channel. Only ControlPlane can speak to the Broker pipe.
import { createInterface } from 'node:readline';
import { request as httpRequest } from 'node:http';

const names = new Set(['ragent_restart_qa_service', 'ragent_restart_qa_service_status']);
const config = {
  endpoint: process.env.AGENTOC_WINDOWS_BROKER_ENDPOINT || '',
  token: process.env.AGENTOC_WINDOWS_BROKER_TOKEN || '',
  sessionId: process.env.AGENTOC_WINDOWS_BROKER_SESSION_ID || '',
  runId: process.env.AGENTOC_WINDOWS_BROKER_RUN_ID || '',
  turnId: process.env.AGENTOC_WINDOWS_BROKER_TURN_ID || '',
};
const result = (id, body) => ({ jsonrpc: '2.0', id, result: body });
const textResult = (body, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(body) }], isError });

async function callControlPlane(method, requestKey) {
  if (!config.token || !config.endpoint || !config.sessionId || !config.runId || !config.turnId) {
    throw new Error('Windows Broker channel is not bound to an active Run');
  }
  const payload = { sessionId: config.sessionId, runId: config.runId, turnId: config.turnId, requestKey };
  const target = new URL(config.endpoint);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw new Error('Invalid local Broker endpoint');
  const body = JSON.stringify(payload);
  const url = method === 'GET' ? `${target.pathname}?${new URLSearchParams(payload)}` : target.pathname;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: target.hostname, port: target.port, path: url, method,
      headers: { 'x-agentoc-windows-broker-token': config.token,
        ...(method === 'POST' ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) },
      timeout: 10_000 }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; if (data.length > 65536) response.destroy(new Error('Broker response too large')); });
      response.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { return reject(new Error('Invalid Broker response')); }
        resolve({ ...parsed, httpStatus: response.statusCode });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Broker request timed out')));
    req.on('error', reject);
    req.end(method === 'POST' ? body : undefined);
  });
}

async function handle(message) {
  const { id, method } = message;
  if (method === 'initialize') return result(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ragent-windows-broker', version: '1.0.0' } });
  if (method === 'ping') return result(id, {});
  if (method === 'tools/list') return result(id, { tools: [
    { name: 'ragent_restart_qa_service', description: 'Request a signed phone approval to restart the one administrator-configured Ragent QA test service. Returns a request ID; it never runs a shell command.', inputSchema: { type: 'object', additionalProperties: false, properties: { requestKey: { type: 'string', description: 'Stable retry key, 1-128 letters, digits, dots, underscores, colons, or dashes.' } }, required: ['requestKey'] } },
    { name: 'ragent_restart_qa_service_status', description: 'Read the result of an earlier QA service restart request using its requestKey.', inputSchema: { type: 'object', additionalProperties: false, properties: { requestKey: { type: 'string' } }, required: ['requestKey'] } },
  ] });
  if (method === 'tools/call') {
    const name = typeof message.params?.name === 'string' ? message.params.name.replace(/^agentoc_restart_qa_service/, 'ragent_restart_qa_service') : '';
    if (!names.has(name)) return result(id, textResult({ error: 'Unknown tool' }, true));
    const args = message.params?.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((key) => key !== 'requestKey') || !/^[A-Za-z0-9._:-]{1,128}$/.test(args.requestKey || '')) {
      return result(id, textResult({ code: 'BROKER_RUN_REQUEST_INVALID' }, true));
    }
    try {
      const response = await callControlPlane(name.endsWith('_status') ? 'GET' : 'POST', args.requestKey);
      return result(id, textResult(response, response.httpStatus >= 400));
    } catch (cause) {
      return result(id, textResult({ error: String(cause?.message || cause) }, true));
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message?.id === undefined || message?.id === null) return;
  void handle(message).then((response) => process.stdout.write(`${JSON.stringify(response)}\n`));
});
