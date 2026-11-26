import assert from 'node:assert/strict';

import {
  normalizeAgyLoginInput,
  projectLoginOutput,
} from '../chat/native-provider-management.mjs';

// 1. OSC-8 hyperlinks + CSI ANSI escapes + 80-col wrapped Google OAuth URL.
const wrappedGoogleOutput = [
  '\u001b[1mPlease visit the following URL to authorize the application:\u001b[0m',
  '\u001b]8;;https://accounts.google.com/o/oauth2/v2/auth?client_id=test\u0007\u001b[34mhttps://accounts.google.com/o/oauth2/v2/auth?client_id=test-client&redirect_ur',
  'i=http%3A%2F%2Flocalhost%3A43123%2Fauth%2Fcallback&response_type=code&scope=ope',
  'nid%20email&state=mock-state-123\u001b[0m\u001b]8;;\u0007',
  'If the redirect fails (eg. over SSH), you can manually copy the URL you get redirected to (should look like http://localhost:43123/auth/callback?...) and paste it below:',
].join('\r\n');

assert.deepEqual(
  projectLoginOutput(wrappedGoogleOutput, { agentType: 'agy' }),
  {
    url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test-client&redirect_uri=http%3A%2F%2Flocalhost%3A43123%2Fauth%2Fcallback&response_type=code&scope=openid%20email&state=mock-state-123',
    code: '',
  },
  'AgY output projection must strip ANSI/OSC, unwrap PTY lines, and suppress fake device codes',
);

// 2. http://localhost callback hint appearing before the Google https:// URL.
const localhostFirstOutput = [
  'Callback server listening on http://localhost:43123/auth/callback',
  'Open https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=xyz in your browser.',
  'SESSION-TOKEN-1234',
].join('\n');

assert.deepEqual(
  projectLoginOutput(localhostFirstOutput, { agentType: 'agy' }),
  {
    url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=xyz',
    code: '',
  },
  'AgY must prefer https:// Google OAuth URL over earlier http://localhost callback hints and never emit a device code',
);

// 3. Codex output projection must continue to extract device codes.
assert.deepEqual(
  projectLoginOutput([
    "OpenAI's command-line coding agent",
    'https://auth.openai.com/codex/device',
    'O2UN-1CZA1',
  ].join('\n'), { agentType: 'codex' }),
  {
    url: 'https://auth.openai.com/codex/device',
    code: 'O2UN-1CZA1',
  },
  'Codex output projection must preserve device code extraction',
);

// 4. normalizeAgyLoginInput: single-line, wrapped callback URLs, prose rejection, empty rejection.
assert.equal(
  normalizeAgyLoginInput('  https://localhost:43123/auth/callback?code=abc&state=xyz  '),
  'https://localhost:43123/auth/callback?code=abc&state=xyz',
);
assert.equal(
  normalizeAgyLoginInput('https://localhost:43123/auth/callback?code=abc\r\n&state=xyz'),
  'https://localhost:43123/auth/callback?code=abc&state=xyz',
  'Wrapped callback URLs from mobile copy-paste should join cleanly into one line',
);
assert.equal(
  normalizeAgyLoginInput('4/0AbCD-efGH\n12345_xyz'),
  '4/0AbCD-efGH12345_xyz',
  'Wrapped authorization codes without internal spaces should join cleanly',
);
assert.throws(
  () => normalizeAgyLoginInput('line one with spaces\nline two'),
  /credential must be a single line/,
  'Multi-line prose with spaces must still be rejected',
);
assert.throws(
  () => normalizeAgyLoginInput('   \r\n  '),
  /credential is required/,
  'Blank input must be rejected',
);

console.log('test-agy-oauth-login-parsing: ANSI/OSC stripping, PTY URL unwrap, https preference, and input normalization OK');
