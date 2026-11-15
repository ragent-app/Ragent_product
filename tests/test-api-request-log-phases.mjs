#!/usr/bin/env node
import assert from 'assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'ragent-api-request-log-'));
const previousConfigDir = process.env.RAGENT_CONFIG_DIR;
process.env.RAGENT_CONFIG_DIR = root;

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.writableFinished = false;
    this.headers = new Map();
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [key, value] of Object.entries(headers)) this.headers.set(key.toLowerCase(), value);
  }

  write(chunk) {
    return chunk;
  }

  end() {
    this.writableFinished = true;
    this.emit('finish');
  }

  getHeader(name) {
    return this.headers.get(String(name).toLowerCase());
  }
}

try {
  const {
    closeApiRequestLog,
    __resetApiRequestMetricsForTest,
    getApiRequestMetrics,
    initApiRequestLog,
    measureApiRequestPhase,
    setApiRequestCorrelation,
    startApiRequestLog,
  } = await import('../chat/api-request-log.mjs');

  __resetApiRequestMetricsForTest();
  await initApiRequestLog();
  const response = new FakeResponse();
  const request = {
    method: 'POST',
    url: '/api/sessions/session_test/messages?source=chat',
    headers: { 'content-length': '17' },
  };
  const requestLog = startApiRequestLog(request, response);

  await requestLog.run(async () => {
    setApiRequestCorrelation({
      requestId: 'req_test',
      sessionId: 'session_test',
      runId: 'run_test',
    });
    await measureApiRequestPhase('send.history_snapshot', async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
    await measureApiRequestPhase('send.run_admission', async () => {});
  });

  response.writeHead(202, { 'Content-Type': 'application/json' });
  response.end('{}');
  await closeApiRequestLog();

  const logPath = join(root, 'api-logs', `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const record = JSON.parse(readFileSync(logPath, 'utf8').trim());
  assert.equal(record.route, 'POST /api/sessions/:sessionId/messages');
  assert.equal(record.requestId, 'req_test');
  assert.equal(record.sessionId, 'session_test');
  assert.equal(record.runId, 'run_test');
  assert.equal(record.statusCode, 202);
  assert.ok(Array.isArray(record.phases) && record.phases.length === 2, 'phase timings should be persisted');
  assert.equal(record.phases[0].name, 'send.history_snapshot');
  assert.ok(Number.isFinite(record.phases[0].durationMs));
  assert.equal(record.phases[1].name, 'send.run_admission');
  assert.equal(record.phases[0].message, undefined, 'phase details must not carry arbitrary message text');
  const requestMetrics = getApiRequestMetrics();
  assert.equal(requestMetrics.requests, 1);
  assert.equal(requestMetrics.completed, 1);
  assert.equal(requestMetrics.totalRequestBytes, 17);
  assert.equal(requestMetrics.totalResponseBytes, 2);
  assert.equal(requestMetrics.phases.find((phase) => phase.name === 'send.history_snapshot').count, 1);

  const nonApiResponse = new FakeResponse();
  const nonApiLog = startApiRequestLog({ method: 'GET', url: '/', headers: {} }, nonApiResponse);
  assert.doesNotThrow(() => nonApiLog.run(() => {}));
  nonApiResponse.end();

  console.log('test-api-request-log-phases: ok');
} finally {
  if (previousConfigDir === undefined) delete process.env.RAGENT_CONFIG_DIR;
  else process.env.RAGENT_CONFIG_DIR = previousConfigDir;
  rmSync(root, { recursive: true, force: true });
}
