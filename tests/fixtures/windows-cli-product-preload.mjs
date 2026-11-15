// Loaded ONLY by the isolated CLI product test. Native issuance is substituted;
// the actual CLI, HTTP request, product auth and SQLite revoke remain real.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
assert.ok(process.env.RAGENT_TEST_INSTANCE_ID);
const origin=process.env.QA_CLI_HTTP_ORIGIN,token=process.env.QA_CLI_SESSION_TOKEN,mode=process.env.QA_CLI_MODE;
delete process.env.QA_CLI_HTTP_ORIGIN;delete process.env.QA_CLI_SESSION_TOKEN;delete process.env.QA_CLI_MODE;
assert.equal(new URL(origin).hostname,'127.0.0.1');assert.ok(![7690,7699].includes(Number(new URL(origin).port)));assert.match(token,/^[a-f0-9]{64}$/);
if(process.platform!=='win32')Object.defineProperty(process,'platform',{value:'win32'});
const bridge=new URL('../../lib/windows-cli-owner-auth.mjs',import.meta.url).href,client=new URL('../../lib/ragent-http-client.mjs',import.meta.url).href;
globalThis.__cliProductIssue=async options=>{assert.deepEqual(Object.keys(options),['signal']);if(mode==='refuse')throw Object.assign(Error('OBD_SYNTHETIC_REFUSAL'),{code:'OBD_SYNTHETIC_REFUSAL'});return {baseUrl:'http://127.0.0.1:7690',sessionToken:token};};
const sources={
  'qa:product-issuer':`export async function requestInstalledOwnerActivation(){} export const requestInstalledOwnerBootstrap=globalThis.__cliProductIssue;`,
  'qa:product-no-legacy':`export async function resolveCliIpcEndpoint(){throw Error('QA_LEGACY_PIPE_FORBIDDEN');}`,
  'qa:product-no-credentials':`export async function readFile(){throw Error('QA_CREDENTIAL_READ_FORBIDDEN');}`,
};
registerHooks({resolve(specifier,context,next){let key;
  if(mode!=='installed-refuse'&&context.parentURL===bridge&&specifier==='./windows-owner-bootstrap.mjs')key='qa:product-issuer';
  if(context.parentURL===client)key=({'./instance-runtime.mjs':'qa:product-no-legacy','fs/promises':'qa:product-no-credentials'})[specifier];
  return key?{url:key,shortCircuit:true}:next(specifier,context);
},load(url,context,next){return sources[url]?{format:'module',source:sources[url],shortCircuit:true}:next(url,context);}});
const originalFetch=globalThis.fetch;let fetches=0;
globalThis.fetch=(url,options)=>{assert.equal(url,'http://127.0.0.1:7690/api/auth/me');assert.equal(options.redirect,'manual');fetches++;return originalFetch(origin+'/api/auth/me',options);};
process.on('exit',()=>console.error('QA_CLI_FETCHES='+fetches));
