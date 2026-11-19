export async function handleAccountPushRoutes({ req, res, pathname, service }) {
  const path = pathname.split('?')[0];
  const actions = {
    '/v1/push/devices/register': 'register',
    '/v1/push/devices/revoke': 'revoke',
    '/v1/push/events': 'event',
    '/v1/push/receipts': 'receipt',
    '/v1/push/status': 'status',
    '/v1/push/instances': 'instances',
  };
  const action = actions[path];
  if (!action) return false;
  const reply = (status, body) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST') {
    reply(405, { code: 'push_method_not_allowed' });
    return true;
  }
  if (!service) {
    reply(503, { code: 'push_unavailable' });
    return true;
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16384) {
        reply(413, { code: 'push_too_large' });
        return true;
      }
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SyntaxError();
    const credential = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1] || '';
    reply(200, await service[action](input, credential));
  } catch (error) {
    const known = /^push_[a-z_]+$/.test(error?.code || '');
    reply(
      known
        ? error.statusCode || 400
        : error instanceof SyntaxError
          ? 400
          : error?.statusCode === 401 || error?.statusCode === 403
            ? error.statusCode
            : 503,
      {
        code: known
          ? error.code
          : error instanceof SyntaxError
            ? 'push_invalid'
            : error?.statusCode === 401 || error?.statusCode === 403
              ? 'push_unauthorized'
              : 'push_unavailable',
      },
    );
  }
  return true;
}
