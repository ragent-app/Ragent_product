#!/usr/bin/env node
// test-agy-account-migration.mjs
// 验收：旧 AGY_CONTROL_HOME_DIR token 幂等迁移到多账号 registry
//
// 覆盖：
// 1. 旧 token 文件存在时，首次调用 migrateLegacyAgyProvider 写入 registry + secret-store
// 2. 再次调用对同一 providerId 幂等（不重复写入，不报错）
// 3. 旧文件不存在时返回 null，不抛错
// 4. 迁移后的 provider 可以通过 prepareNativeRunProviderHome 正常准备 Run HOME

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';
import {
  migrateLegacyAgyProvider,
  prepareNativeRunProviderHome,
} from '../lib/provider-runtime/run-provider-prepare.mjs';
import { AGY_AUTH_RELATIVE_PATH } from '../lib/agy-runtime.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-agy-account-migration-'));
const configDir = join(root, 'config');
const providerHomesRoot = join(root, 'provider-homes');
const legacyControlHome = join(root, 'legacy-control');
const legacyAuthFile = join(legacyControlHome, AGY_AUTH_RELATIVE_PATH);

try {
  const registry = createNativeProviderRegistry({ configDir });
  const secretStore = createSecretStore({ configDir });

  // ── Case 1: 旧文件不存在时，返回 null（不抛错）
  const resultMissing = await migrateLegacyAgyProvider({
    registry,
    secretStore,
    legacyAuthFile: join(root, 'nonexistent-token'),
    providerId: 'agy-official',
  });
  assert.equal(resultMissing, null, 'missing legacy token should return null');

  // ── Case 2: 旧文件存在时，首次迁移成功
  await mkdir(join(legacyControlHome, '.gemini', 'antigravity-cli'), { recursive: true });
  await writeFile(legacyAuthFile, 'legacy-token-content\n', 'utf8');

  const resultFirst = await migrateLegacyAgyProvider({
    registry,
    secretStore,
    legacyAuthFile,
    providerId: 'agy-official',
    displayName: 'AgY Legacy Account',
  });
  assert.ok(resultFirst, 'first migration should return the provider profile');
  assert.equal(resultFirst.id, 'agy-official');
  assert.equal(resultFirst.agentType, 'agy');
  assert.equal(resultFirst.protocol, 'agy');

  // registry 中有 provider profile
  const profile = await registry.getProviderProfile('agy-official');
  assert.ok(profile, 'provider profile should exist in registry after migration');
  assert.equal(profile.id, 'agy-official');
  assert.equal(profile.agentType, 'agy');

  // auth profile 存在
  const authProfile = await registry.getAuthProfile(profile.authProfileId);
  assert.ok(authProfile, 'auth profile should exist after migration');
  assert.equal(authProfile.agentType, 'agy');
  assert.equal(authProfile.authType, 'oauth');

  // secret-store 中 token 内容正确
  const secret = await secretStore.resolveSecret(authProfile.storageRef);
  assert.ok(secret, 'secret should exist in secret-store after migration');
  assert.equal(
    String(secret.tokens?.tokenFile || '').trim(),
    'legacy-token-content',
    'migrated token content must match the legacy file',
  );

  // accountMetadata 标记迁移来源
  assert.ok(
    String(authProfile.accountMetadata?.migratedFrom || '').includes('antigravity-oauth-token'),
    'accountMetadata.migratedFrom should record the legacy file path',
  );

  // ── Case 3: 再次迁移相同 providerId 幂等（直接返回现有 profile，不重写）
  const resultSecond = await migrateLegacyAgyProvider({
    registry,
    secretStore,
    legacyAuthFile,
    providerId: 'agy-official',
    displayName: 'AgY Legacy Account (dup)',
  });
  assert.ok(resultSecond, 'idempotent migration should also return the profile');
  assert.equal(resultSecond.id, 'agy-official');

  // secret-store 中的 token 不被幂等调用改写
  const secretAfterIdempotent = await secretStore.resolveSecret(authProfile.storageRef);
  assert.equal(
    String(secretAfterIdempotent.tokens?.tokenFile || '').trim(),
    'legacy-token-content',
    'idempotent migration must not overwrite the existing secret',
  );

  // ── Case 4: 迁移后的 provider 可以正常准备 Run HOME
  const runResult = await prepareNativeRunProviderHome('run-migrated', {
    tool: 'agy',
    options: { model: 'gemini-3.7-flash@agy-official' },
  }, {
    configDir,
    providerHomesRoot,
    externalOAuthOwnership: false,
  });
  assert.equal(runResult.ok, true, `prepareNativeRunProviderHome should succeed: ${runResult.error || runResult.reason}`);
  assert.equal(runResult.providerId, 'agy-official');
  assert.ok(runResult.agyHomeDir, 'Run HOME should be set');

  // Run HOME 中的 token 来自迁移后的 secret-store（而非旧控制目录）
  const runToken = await readFile(
    join(runResult.agyHomeDir, AGY_AUTH_RELATIVE_PATH),
    'utf8',
  );
  assert.equal(
    runToken.trim(),
    'legacy-token-content',
    'Run HOME token must match the migrated credential, not the raw legacy path',
  );

  // Run HOME 不等于旧控制目录（隔离边界）
  assert.notEqual(
    runResult.agyHomeDir,
    legacyControlHome,
    'Run HOME must be isolated from the legacy control directory',
  );

  console.log('test-agy-account-migration: idempotent migration, secret-store, and Run HOME isolation OK');
} finally {
  await rm(root, { recursive: true, force: true });
}
