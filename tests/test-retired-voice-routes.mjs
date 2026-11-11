import assert from 'node:assert/strict';
import { handleControlRoutes } from '../chat/router-control-routes.mjs';

for (const [method, pathname] of [
  ['GET', '/api/local-voice-settings'],
  ['PATCH', '/api/local-voice-settings'],
  ['POST', '/api/local-voice-install'],
  ['GET', '/api/local-voice-install/11111111-1111-1111-1111-111111111111'],
  ['POST', '/api/local-voice-recognition'],
  ['POST', '/api/sessions/session-1/local-voice-recognition'],
]) {
  const response = {};
  let drained = false;
  const handled = await handleControlRoutes({
    req: { method, headers: {}, resume() { drained = true; } },
    res: response, pathname, authSession: { role: 'owner' },
    writeJson(res, status, body) { res.status = status; res.body = body; },
  });
  assert.equal(handled, true, pathname);
  assert.equal(drained, true, pathname);
  assert.equal(response.status, 410, pathname);
  assert.equal(response.body.code, 'LOCAL_VOICE_RETIRED', pathname);
  assert.match(response.body.error, /Update the Android app/);
}
console.log('retired voice routes: ok');
