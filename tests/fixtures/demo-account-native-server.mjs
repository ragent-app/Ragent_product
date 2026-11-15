// A bounded loopback fixture for the real Android Keystore/HTTP test, never a deployment server.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createServer } from 'node:http';
import { createAccountsServer } from '../../accounts/server.mjs';
import { createDemoAccountPolicy } from '../../accounts/demo-credentials.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-demo-native-'));
const policyFile = join(root, 'policy.json');
const policy = await createDemoAccountPolicy({ username: 'review-native-fixture',
  password: 'native-fixture-password-not-for-deployment', instanceId: 'inst_demo_native_fixture' });
await writeFile(policyFile, JSON.stringify(policy), { mode: 0o600 });
const app = await createAccountsServer({ dataFile: join(root, 'accounts.json'), signingKeyFile: join(root, 'signing.json'),
  publicBaseUrl: 'http://127.0.0.1:18420', allowInsecurePublicBaseUrl: true, demoAccountPolicyFile: policyFile });
const server = createServer((req, res) => app.handler(req, res).then(handled => {
  if (!handled) { res.writeHead(404); res.end(); }
}).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearTimeout(timer);
  await new Promise(resolve => server.close(resolve));
  assertOwned(); await rm(root, { recursive: true, force: true });
}
function assertOwned() { if (!basename(root).startsWith('ragent-demo-native-')) throw new Error('Unexpected fixture root'); }
const timer = setTimeout(() => close(), 600_000);
process.once('SIGTERM', close); process.once('SIGINT', close);
await new Promise(resolve => server.listen(18420, '127.0.0.1', resolve));
console.log(JSON.stringify({ ready: true, port: 18420, evidence: 'isolated Accounts file store; no workbench or Provider replacement claim' }));
