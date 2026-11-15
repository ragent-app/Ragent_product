#!/usr/bin/env node
// test-agy-provider-management.mjs
// 验收：ProviderProfile 生命周期 — 禁用/删除中的 profile 不能被新 Run 选中
//
// 覆盖：
// 1. 正常 profile 可被 prepareNativeRunProviderHome 选中
// 2. 显式删除 profile 后，显式按 id 选择该 profile 失败（ok:false）
// 3. 删除 profile 后，默认分辨器不再选取已删除的 profile
// 4. AuthProfile 被引用时删除失败（Registry 级拒绝）
// 5. 删除 AuthProfile 的 ProviderProfile 引用先删完后，AuthProfile 可被删除
// 6. 多账号并存时，删除一个账号不影响另一个账号的 Run 准备

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';
import { prepareNativeRunProviderHome } from '../lib/provider-runtime/run-provider-prepare.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-agy-provider-mgmt-'));
const configDir = join(root, 'config');
const providerHomesRoot = join(root, 'provider-homes');

async function addAccount(registry, secretStore, id) {
  const authId = `${id}-auth`;
  const secretRef = `${id}-secret`;
  await secretStore.writeSecret(secretRef, {
    authType: 'oauth',
    tokens: { tokenFile: `${id}-token-content\n` },
  });
  await registry.upsertAuthProfile({
    id: authId,
    agentType: 'agy',
    authType: 'oauth',
    displayName: id,
    storageType: 'secret-store',
    storageRef: secretRef,
  });
  await registry.upsertProviderProfile({
    id,
    agentType: 'agy',
    protocol: 'agy',
    displayName: id,
    baseUrl: '',
    authProfileId: authId,
    quotaPolicy: { mode: 'official_subscription', adapter: 'agy' },
  });
}

async function tryPrepare(id) {
  return prepareNativeRunProviderHome(`run-${id}-${Date.now()}`, {
    tool: 'agy',
    options: { model: `gemini-3.7-flash@${id}` },
  }, {
    configDir,
    providerHomesRoot,
    externalOAuthOwnership: false,
    legacyAgyAuthFile: join(root, 'no-legacy-token'),
  });
}

try {
  const registry = createNativeProviderRegistry({ configDir });
  const secretStore = createSecretStore({ configDir });

  await addAccount(registry, secretStore, 'agy-alpha');
  await addAccount(registry, secretStore, 'agy-beta');

  // ── Case 1: 两个 profile 都能正常被选中并准备 Run HOME
  const alphaResult = await tryPrepare('agy-alpha');
  assert.equal(alphaResult.ok, true, `agy-alpha prepare failed: ${alphaResult.error || alphaResult.reason}`);
  assert.equal(alphaResult.providerId, 'agy-alpha');

  const betaResult = await tryPrepare('agy-beta');
  assert.equal(betaResult.ok, true, `agy-beta prepare failed: ${betaResult.error || betaResult.reason}`);
  assert.equal(betaResult.providerId, 'agy-beta');

  // Run HOME 互不相同（独立隔离）
  assert.notEqual(alphaResult.agyHomeDir, betaResult.agyHomeDir);

  // ── Case 2: 删除 agy-alpha 的 ProviderProfile
  const deleteResult = await registry.deleteProviderProfile('agy-alpha');
  assert.equal(deleteResult.ok, true, `deleteProviderProfile should succeed: ${deleteResult.errors?.join(', ')}`);

  // 显式按 id 选择已删除的 profile，Run 准备必须失败
  const afterDeleteResult = await tryPrepare('agy-alpha');
  assert.equal(afterDeleteResult.ok, false,
    'selecting a deleted provider profile must fail (ok:false)');
  assert.ok(
    afterDeleteResult.reason === 'provider-profile-not-found'
      || afterDeleteResult.reason === 'resolution-failed'
      || afterDeleteResult.reason === 'native-provider-not-selected'
      || (afterDeleteResult.error || '').toLowerCase().includes('agy-alpha'),
    `expected a descriptive error after delete, got reason=${afterDeleteResult.reason} error=${afterDeleteResult.error}`,
  );

  // ── Case 3: 默认分辨器不再选取已删除的 profile（自动 fallback 到 agy-beta）
  const defaultResult = await prepareNativeRunProviderHome(`run-default-${Date.now()}`, {
    tool: 'agy',
    options: { model: 'gemini-3.7-flash' },  // 不带 @providerId，走默认分辨
  }, {
    configDir,
    providerHomesRoot,
    externalOAuthOwnership: false,
    legacyAgyAuthFile: join(root, 'no-legacy-token'),
  });
  // 应当成功，且选中的是 agy-beta（唯一剩余的 profile）
  assert.equal(defaultResult.ok, true, `default resolution after alpha delete failed: ${defaultResult.error || defaultResult.reason}`);
  assert.equal(defaultResult.providerId, 'agy-beta',
    'default resolver must not select the deleted profile; must fall back to the remaining one');

  // ── Case 4: AuthProfile 被 ProviderProfile 引用时，删除 AuthProfile 必须被拒绝
  const deleteAuthWhileInUse = await registry.deleteAuthProfile('agy-beta-auth');
  assert.equal(deleteAuthWhileInUse.ok, false,
    'deleting an AuthProfile still referenced by a ProviderProfile must be rejected');
  // ProviderProfile 仍可正常工作
  const betaAfterAuthDeleteAttempt = await tryPrepare('agy-beta');
  assert.equal(betaAfterAuthDeleteAttempt.ok, true,
    'agy-beta must still be usable after a rejected auth profile delete attempt');

  // ── Case 5: 先删 ProviderProfile，再删 AuthProfile，成功
  const deleteBetaProvider = await registry.deleteProviderProfile('agy-beta');
  assert.equal(deleteBetaProvider.ok, true, 'deleting agy-beta provider should succeed');

  const deleteBetaAuth = await registry.deleteAuthProfile('agy-beta-auth');
  assert.equal(deleteBetaAuth.ok, true,
    'deleting auth profile after its provider profile is removed must succeed');

  // ── Case 6: 两个 profile 都删除后，无 profile 可选，默认分辨返回失败
  const noProviderResult = await prepareNativeRunProviderHome(`run-empty-${Date.now()}`, {
    tool: 'agy',
    options: { model: 'gemini-3.7-flash' },
  }, {
    configDir,
    providerHomesRoot,
    externalOAuthOwnership: false,
    legacyAgyAuthFile: join(root, 'no-legacy-token'),
  });
  assert.equal(noProviderResult.ok, false,
    'no remaining provider profiles must cause Run prepare to fail gracefully');
  assert.ok(
    noProviderResult.reason === 'native-provider-not-selected'
      || noProviderResult.reason === 'resolution-failed'
      || (noProviderResult.error || '').toLowerCase().includes('provider'),
    `expected no-provider error, got reason=${noProviderResult.reason}`,
  );

  console.log('test-agy-provider-management: profile lifecycle (delete guard, auth ref check, default fallback, empty registry) OK');
} finally {
  await rm(root, { recursive: true, force: true });
}
