#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { handleApprovedActionInternalRoutes } from '../chat/router-approved-action-routes.mjs';

const server = createServer(async (req, res) => {
  await handleApprovedActionInternalRoutes({
    req,
    res,
    pathname: new URL(req.url, 'http://localhost').pathname,
    writeJson: (target, status, payload) => {
      target.writeHead(status, { 'content-type': 'application/json' });
      target.end(JSON.stringify(payload));
    },
    proposeApprovedActions: async ({ token, requestKey }) => {
      assert.equal(token, 'test-token');
      assert.equal(requestKey, 'deny-once');
      const error = new Error('Unattended policy denied this action');
      error.code = 'APPROVED_ACTION_AUTO_DENIED';
      throw error;
    },
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/internal/approved-actions/propose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ragent-approved-action-token': 'test-token' },
    body: JSON.stringify({ requestKey: 'deny-once', actions: [] }),
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, 'APPROVED_ACTION_AUTO_DENIED');
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log('test-approved-action-auto-denial-route: ok');
