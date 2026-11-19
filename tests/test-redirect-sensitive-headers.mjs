import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

// follow-redirects was retired with @larksuiteoapi/node-sdk (1bdb101e). Verify it
// remains absent from all lockfiles unless explicitly re-introduced, in which case
// validate its cross-realm sensitiveHeaders strip behavior too.
for (const lockPath of ['package-lock.json', 'accounts/package-lock.json', 'desktop/package-lock.json']) {
  const lock = JSON.parse(readFileSync(join(root, lockPath), 'utf8'));
  const hasFollowRedirects = Object.keys(lock.packages || {}).some((pkg) => pkg.endsWith('node_modules/follow-redirects'));
  assert.equal(hasFollowRedirects, false, `${lockPath} must not retain retired follow-redirects dependency`);
}

let followRedirects = null;
try {
  followRedirects = require('follow-redirects');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND') throw error;
}

let receivedHeaders;
const server = createServer((request, response) => {
  if (request.url === '/start') {
    response.writeHead(302, { location: `http://localhost:${server.address().port}/destination` });
    response.end();
    return;
  }
  receivedHeaders = request.headers;
  response.end('ok');
});

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  // Verify the built-in Node fetch client strips Authorization and Cookie on cross-origin redirects.
  receivedHeaders = null;
  const fetchResponse = await fetch(`http://127.0.0.1:${port}/start`, {
    headers: {
      authorization: 'Bearer synthetic-test-token',
      cookie: 'session=synthetic-test-cookie',
      'x-test-benign': 'keep',
    },
  });
  await fetchResponse.text();
  assert.equal(fetchResponse.status, 200);
  assert.equal(receivedHeaders.authorization, undefined, 'cross-origin fetch redirects must strip Authorization');
  assert.equal(receivedHeaders.cookie, undefined, 'cross-origin fetch redirects must strip Cookie');
  assert.equal(receivedHeaders['x-test-benign'], 'keep');

  if (followRedirects) {
    receivedHeaders = null;
    await new Promise((resolve, reject) => {
      const request = followRedirects.http.get({
        hostname: '127.0.0.1',
        port,
        path: '/start',
        family: 4,
        headers: { 'x-test-private': 'synthetic-test-value' },
        sensitiveHeaders: runInNewContext("['x-test-private']"),
      }, (response) => {
        response.resume();
        response.once('end', resolve);
        response.once('error', reject);
      });
      request.once('error', reject);
    });
    assert.equal(receivedHeaders['x-test-private'], undefined, 'cross-origin redirects must strip cross-realm sensitive headers');
  }
  console.log('test-redirect-sensitive-headers: ok');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
