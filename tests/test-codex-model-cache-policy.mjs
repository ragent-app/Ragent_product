import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOfficialCodexDiscoveryFailure, mayCacheMergedCodexCatalog } from '../chat/codex-model-cache-policy.mjs';

test('merged catalogs do not pin missing, fallback, or expired official models', () => {
  const rows = [{id:'a'}, {id:'b'}];
  const entries = new Map([['a',{at:100,models:[{catalogSource:'upstream'}]}]]);
  const read = id => entries.get(id);
  assert.equal(mayCacheMergedCodexCatalog(rows,read,150,100),false);
  entries.set('b',{at:100,models:[{catalogSource:'builtin'}]});
  assert.equal(mayCacheMergedCodexCatalog(rows,read,150,100),false);
  entries.set('b',{at:100,models:[{catalogSource:'upstream'}]});
  assert.equal(mayCacheMergedCodexCatalog(rows,read,150,100),true);
  assert.equal(mayCacheMergedCodexCatalog(rows,read,200,100),false);
  assert.equal(mayCacheMergedCodexCatalog([],read,200,100),true);
});

test('discovery failure diagnostics use safe categories', () => {
  assert.equal(classifyOfficialCodexDiscoveryFailure({code:'NATIVE_OAUTH_LOCK_TIMEOUT',message:'secret'}),'NATIVE_OAUTH_LOCK_TIMEOUT');
  assert.equal(classifyOfficialCodexDiscoveryFailure(new Error('Timed out waiting for Codex model/list')),'MODEL_LIST_TIMEOUT');
  assert.equal(classifyOfficialCodexDiscoveryFailure(new Error('Official Codex model/list returned no picker-visible models')),'MODEL_LIST_EMPTY');
  assert.equal(classifyOfficialCodexDiscoveryFailure({code:'SECRET',message:'secret'}),'MODEL_LIST_FAILED');
});

test('discovery diagnostics identify the stage without leaking provider errors', () => {
  assert.equal(classifyOfficialCodexDiscoveryFailure({discoveryStage:'PREPARE',cause:new Error('secret')}),'MODEL_LIST_PREPARE_FAILED');
  assert.equal(classifyOfficialCodexDiscoveryFailure({discoveryStage:'PREPARE',code:'credential-missing'}),'MODEL_LIST_PREPARE_CREDENTIAL_MISSING');
  assert.equal(classifyOfficialCodexDiscoveryFailure({discoveryStage:'REQUEST',cause:{code:'EPERM',message:'secret'}}),'MODEL_LIST_EPERM');
  assert.equal(classifyOfficialCodexDiscoveryFailure({discoveryStage:'REQUEST',cause:{code:'secret',message:'secret'}}),'MODEL_LIST_REQUEST_FAILED');
});
