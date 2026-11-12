import test from 'node:test';
import assert from 'node:assert/strict';
import { mayCacheMergedCodexCatalog } from '../chat/codex-model-cache-policy.mjs';

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
