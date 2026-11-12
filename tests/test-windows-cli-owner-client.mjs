import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const {stdout,stderr}=await promisify(execFile)(process.execPath,['--test','--test-reporter=tap','tests/fixtures/windows-cli-owner-client.mjs'],{cwd:new URL('..',import.meta.url),windowsHide:true,timeout:15000,maxBuffer:1024*1024});
assert.match(stdout,/# pass 12/);assert.match(stdout,/# fail 0/);assert.doesNotMatch(stderr,/Error:/);
console.log(stdout);console.log('Evidence: actual client/bridge with test-only issuer and HTTP substitution; no native OS/installed trust claim.');
