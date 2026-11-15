import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { createContentReportStore, normalizeContentReport, handleContentReportRoutes } from '../accounts/content-reports.mjs';

const payload = (requestId = randomUUID(), more = {}) => ({ schemaVersion: 1, requestId,
  reason: 'unsafe', details: 'Synthetic QA report only', includeContent: true,
  content: 'SYNTHETIC-REPORTED-CONTENT-NO-PERSONAL-DATA', appVersion: '0.0.1', ...more });
if (process.argv[2] === '--owned-report-qa-child') {
  const [mode, root, requestId] = process.argv.slice(3);
  assert.equal(await readFile(join(root, '.ragent-owned-report-qa'), 'utf8'), 'content-report-qa-v1\n');
  const store = await createContentReportStore({ filePath: join(root, 'reports.sqlite') });
  if (mode === 'race') {
    process.send({ ready: true });
    process.once('message', () => {
      process.send({ result: store.submit(payload(requestId)) }); store.close(); process.disconnect();
    });
  } else {
    const server = createServer(async (req, res) => {
      await handleContentReportRoutes({ req, res, pathname: req.url, store: { ...store, submit(value) {
        store.submit(value);
        writeFileSync(join(root, `committed-${value.requestId}`), 'committed-before-response\n', { flag: 'wx' });
        process.kill(process.pid, 'SIGKILL');
      } } });
    });
    server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
  }
} else {
  const root = await mkdtemp(join(tmpdir(), 'ragent-content-report-qa-'));
  await writeFile(join(root, '.ragent-owned-report-qa'), 'content-report-qa-v1\n');
  const file = join(root, 'reports.sqlite');
  let store, server, checks = 0;
  const children = [];
  const check = (condition, name) => { assert.ok(condition, name); checks++; };
  const child = (mode, requestId = randomUUID()) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^RAGENT_/i.test(key)));
    const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), '--owned-report-qa-child', mode, root, requestId],
      { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    proc.stderr.setEncoding('utf8'); let errors = ''; proc.stderr.on('data', data => { errors += data; });
    proc.qaErrors = () => errors; children.push(proc); return proc;
  };
  const message = proc => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Owned report child deadline: ${proc.qaErrors()}`)), 10000);
    proc.once('message', value => { clearTimeout(timer); resolve(value); });
    proc.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const request = (port, method, path, value, headers = {}) => new Promise((resolve, reject) => {
    const body = value === undefined ? '' : JSON.stringify(value);
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path,
      headers: { ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', data => { text += data; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text), headers: res.headers }));
    });
    req.setTimeout(10000, () => req.destroy(new Error('Owned report HTTP deadline')));
    req.on('error', reject); req.end(body);
  });
  try {
    store = await createContentReportStore({ filePath: file, maxPerHour: 2 });
    const original = payload();
    const first = store.submit(original);
    check(first.receipt.status === 'received', 'durable initial receipt');
    assert.deepEqual(store.submit(original), first); checks++;
    assert.throws(() => store.submit({ ...original, content: 'different' }), { code: 'content_report_conflict' }); checks++;
    const optional = payload(undefined, { includeContent: false, content: '' });
    check(store.submit(optional).receipt.status === 'received', 'report without excerpt is supported');
    assert.throws(() => store.submit(payload()), { code: 'content_report_rate_limited' }); checks++;
    check(store.get(original.requestId).receipt.status === 'received', 'GET receipt does not consume admission');
    for (const invalid of [payload(undefined, { includeContent: false }), payload(undefined, { unknown: 'not-allowed' }),
      payload(undefined, { reason: 'not-a-reason' }), payload('../escape'), payload(undefined, { content: 'x'.repeat(4001) }),
      payload(undefined, { content: 'null\0byte' }), payload(undefined, { details: 'x'.repeat(1001) }),
      payload(undefined, { schemaVersion: 2 }), payload(undefined, { includeContent: 'true' })]) {
      assert.throws(() => normalizeContentReport(invalid)); checks++;
    }
    store.close(); store = await createContentReportStore({ filePath: file });
    assert.deepEqual(store.get(original.requestId), first); checks++;
    check(process.platform === 'win32' || ((await stat(file)).mode & 0o077) === 0, 'Unix report DB is private; Windows ACL not certified');
    check(store.setStatus(original.requestId, 'in_review').receipt.status === 'in_review', 'operator triage is visible');
    check(store.setStatus(original.requestId, 'closed', { eraseContent: true }).receipt.status === 'closed', 'operator closes/redacts selected content');
    check(store.readContent(original.requestId) === null, 'content no longer exposed by repository after redaction');
    check(store.submit(original).receipt.status === 'closed' && store.readContent(original.requestId) === null, 'old replay never restores erased payload');
    assert.throws(() => store.setStatus(original.requestId, 'received'), { code: 'content_report_status_conflict' }); checks++;
    const cap = await createContentReportStore({ filePath: join(root, 'capacity.sqlite'), maxReports: 1 });
    try { const value = payload(); cap.submit(value);
      assert.throws(() => cap.submit(payload()), { code: 'content_report_capacity' }); checks++;
      check(cap.submit(value).receipt.status === 'received', 'existing receipt survives full capacity');
    } finally { cap.close(); }
    const tiny = await createContentReportStore({ filePath: join(root, 'bytes.sqlite'), maxPayloadBytes: 1 });
    try { assert.throws(() => tiny.submit(payload()), { code: 'content_report_capacity' }); checks++; } finally { tiny.close(); }
    const foreign = join(root, 'foreign.sqlite');
    const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(foreign);
    db.exec('CREATE TABLE preserve_me(value TEXT); INSERT INTO preserve_me VALUES(\'synthetic\')'); db.close();
    await assert.rejects(createContentReportStore({ filePath: foreign }), { code: 'content_report_schema_unsupported' }); checks++;
    server = createServer(async (req, res) => {
      const handled = await handleContentReportRoutes({ req, res, pathname: req.url, store });
      if (!handled) { res.writeHead(404); res.end('{}'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port, report = payload();
    const submitted = await request(port, 'POST', '/v1/content-reports', report);
    check(submitted.status === 201 && submitted.body.receipt.status === 'received', 'actual HTTP receiver accepts deliberate anonymous report');
    check(submitted.headers['cache-control'] === 'no-store', 'report receipt is not cached');
    const receipt = await request(port, 'GET', `/v1/content-reports/${report.requestId}`);
    check(receipt.status === 200 && !JSON.stringify(receipt.body).includes(report.content), 'public receipt contains no reported text');
    check((await request(port, 'GET', '/v1/content-reports')).status === 405, 'no public report enumeration');
    check((await request(port, 'POST', `/v1/content-reports/${report.requestId}`, report)).status === 405, 'no public status mutation');
    check((await request(port, 'POST', '/v1/content-reports', report, { 'Content-Type': 'text/plain' })).status === 415, 'no untyped form-body collection');
    check((await request(port, 'POST', '/v1/content-reports', payload(undefined, { content: 'x'.repeat(25000) }))).status === 413, 'actual oversized HTTP rejected');
    await new Promise(resolve => server.close(resolve)); server = null;
    // Exercise the real Fastify body adapter and the Accounts URL prefix too.
    const { createAccountsServer, startAccountsServer } = await import('../accounts/server.mjs');
    const accountFile = join(root, 'accounts-state.json');
    await writeFile(accountFile, '{"qaPreserve":true}\n');
    const full = await startAccountsServer({ dataFile: accountFile, signingKeyFile: join(root, 'signing-key.json'),
      harnessPolicyFile: join(root, 'no-overrides.json'), contentReportFile: file,
      publicBaseUrl: 'http://127.0.0.1:0/accounts', host: '127.0.0.1', port: 0,
      allowInsecurePublicBaseUrl: true, logger: { level: 'silent' } });
    try {
      const accepted = await request(full.server.address().port, 'POST', '/accounts/v1/content-reports', payload());
      check(accepted.status === 201, 'real Accounts/Fastify mount accepts the versioned report contract');
      const readback = await request(full.server.address().port, 'GET', `/accounts/v1/content-reports/${accepted.body.requestId}`);
      check(readback.status === 200 && readback.body.requestId === accepted.body.requestId, 'prefixed receipt matches original request');
      check((await readFile(accountFile, 'utf8')) === '{"qaPreserve":true}\n', 'report bodies never enter the Accounts snapshot');
    } finally { await full.close(); }
    const disabled = await createAccountsServer({ dataFile: accountFile, signingKeyFile: join(root, 'signing-key.json'),
      publicBaseUrl: 'http://127.0.0.1:0/accounts', allowInsecurePublicBaseUrl: true });
    check(disabled.contentReports === null, 'existing deployments do not silently enable content collection');
    server = createServer((req, res) => disabled.handler(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    check((await request(server.address().port, 'POST', '/accounts/v1/content-reports', payload())).status === 503,
      'disabled receiver does not return a false acceptance');
    await new Promise(resolve => server.close(resolve)); server = null;
    const reportAudit = [];
    const broken = await startAccountsServer({ dataFile: accountFile, signingKeyFile: join(root, 'signing-key.json'),
      contentReportFile: foreign, publicBaseUrl: 'http://127.0.0.1:0/accounts', host: '127.0.0.1', port: 0,
      allowInsecurePublicBaseUrl: true, logger: { level: 'silent' }, audit: value => reportAudit.push(value) });
    try {
      check(broken.contentReportStatus === 'unavailable', 'failed report store does not stop Accounts startup');
      const ready = await request(broken.server.address().port, 'GET', '/readyz');
      check(ready.status === 200 && ready.body.contentReporting === 'unavailable', 'readiness distinguishes auth from report-store health');
      check((await request(broken.server.address().port, 'POST', '/accounts/v1/content-reports', payload())).status === 503,
        'broken repository never claims report acceptance');
      check(reportAudit.some(value => value.event === 'content_report.store_unavailable')
        && reportAudit.every(value => !JSON.stringify(value).includes(original.content)), 'storage failure audit omits report body');
    } finally { await broken.close(); }
    // Two independent writer processes must converge on one accepted request.
    const raceId = randomUUID(), a = child('race', raceId), b = child('race', raceId);
    await Promise.all([message(a), message(b)]);
    const ra = message(a), rb = message(b); a.send('go'); b.send('go');
    assert.deepEqual((await ra).result, (await rb).result); checks++;
    await Promise.all([a, b].map(proc => proc.exitCode === null && proc.signalCode === null ? once(proc, 'exit') : Promise.resolve()));
    check(store.list({ limit: 200 }).filter(value => value.requestId === raceId).length === 1, 'one row after two-process replay');
    // Actual commit-before-response process death; cold reader proves acceptance.
    const killedId = randomUUID(), doomed = child('kill-after-commit');
    const ready = await message(doomed), exited = once(doomed, 'exit');
    const lost = request(ready.port, 'POST', '/v1/content-reports', payload(killedId)).then(() => false, () => true);
    await exited;
    check(await readFile(join(root, `committed-${killedId}`), 'utf8') === 'committed-before-response\n',
      'child committed real report before its deliberate kill');
    check(await lost, 'client actually lost the HTTP response');
    store.close(); store = await createContentReportStore({ filePath: file });
    check(store.get(killedId).receipt.status === 'received', 'cold repository reconciles original report receipt');
    const admin = execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '../accounts/content-reports-admin.mjs'),
      'list', '--file', file], { encoding: 'utf8', timeout: 10000 });
    check(!admin.includes(original.content) && JSON.parse(admin).length >= 4, 'operator default output omits report content');
    console.log(`content-reports: ${checks} checks PASS; actual HTTP/SQLite, two processes and commit-before-response kill; production unchanged`);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    store?.close();
    for (const proc of children) if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGTERM'); await once(proc, 'exit'); }
    assert.equal(await readFile(join(root, '.ragent-owned-report-qa'), 'utf8'), 'content-report-qa-v1\n');
    const resolved = await realpath(root), base = await realpath(tmpdir());
    assert.ok(relative(base, resolved).startsWith('ragent-content-report-qa-'));
    await rm(resolved, { recursive: true, force: true });
  }
}
