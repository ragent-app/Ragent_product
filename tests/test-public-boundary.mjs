import assert from 'node:assert/strict';
import { findForbiddenPaths } from '../scripts/check-public-boundary.mjs';

const paths = [
  'chat/session-manager.mjs',
  'android/app/src/androidTest/assets/pairing-link-qr.png',
  'accounts/server.mjs',
  'android/app/google-services.json',
  'android/review/old.png',
  'android/docs/internal-plan.md',
  'web/review/old.png',
  'workspace/internal-probe.mjs',
  'static/chat/img/sticker-bear.gif',
  'scripts/clean-resp-msg-session-ids.mjs',
  'tests/generate-goal-screenshots.mjs',
  'tests/results/live.json',
  'tests/live-windows-probe.mjs',
  'scripts/windows-a0-smoke.mjs',
  'automation/instance-factory/manifests/private.jsonc',
  'automation/instance-factory/profiles/private.env',
  'tests/fixtures/risk-datasets/taglio4-safe.jsonl',
  'chat/session-manager.mjs.bak-20260624',
  'notes/private.md',
  'service/credentials.p12',
  'android/app/build/outputs/app.apk',
  'bin/agentoc-p2p-host-amd64',
  'bin/ragent-p2p-host',
  '.env.production',
  'turn-broker-signing-key.json',
  'accounts.json',
  'auth-sessions.json',
  'state.db',
  'cloudflare/email-worker/wrangler.jsonc',
  'cloudflare/email-worker/.dev.vars',
];
assert.deepEqual(findForbiddenPaths(paths), paths.slice(3));
console.log('Public boundary rules reject private and generated paths.');
