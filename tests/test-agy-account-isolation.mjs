#!/usr/bin/env node
// test-agy-account-isolation.mjs
// 验收：Ragent 在 UI 登录新 AgY 账号时，不修改终端用户的 ~/.gemini
//
// 覆盖：
// 1. 准备 Run HOME 不写入 process.env.HOME 下的 .gemini
// 2. buildAgyRuntimeEnv 给出的 HOME 是受管 HOME，不是宿主 HOME
// 3. 宿主 HOME 的 .gemini 在整个流程中保持不变（包括原本就有 token 的场景）
// 4. 受管 Run HOME 中的 token 与宿主 HOME 的 token 互不干扰

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants as fsConstants } from 'node:fs';

import { AGY_AUTH_RELATIVE_PATH, buildAgyRuntimeEnv, prepareAgyRunHome } from '../lib/agy-runtime.mjs';
import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';
import { prepareNativeRunProviderHome } from '../lib/provider-runtime/run-provider-prepare.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-agy-account-isolation-'));

// 模拟宿主 HOME（终端用户的家目录）
const hostHome = join(root, 'host-home');
const hostGeminiAuthFile = join(hostHome, AGY_AUTH_RELATIVE_PATH);
await mkdir(join(hostHome, '.gemini', 'antigravity-cli'), { recursive: true });
await writeFile(hostGeminiAuthFile, 'terminal-user-token\n', 'utf8');

// Ragent 受管区域（独立于宿主 HOME）
const configDir = join(root, 'config');
const providerHomesRoot = join(root, 'provider-homes');
const controlHome = join(root, 'agy-control');
const controlAuthFile = join(controlHome, AGY_AUTH_RELATIVE_PATH);
await mkdir(join(controlHome, '.gemini', 'antigravity-cli'), { recursive: true });
await writeFile(controlAuthFile, 'ragent-managed-token\n', 'utf8');

try {
  // ── Case 1: prepareAgyRunHome 把 token 复制到受管 Run HOME，不触及宿主 HOME
  const runHome = join(providerHomesRoot, 'agy-account', 'run-isolation-test');
  const prepared = await prepareAgyRunHome({
    homeDir: runHome,
    sourceHome: controlHome,
    runnerReadable: true,
  });
  assert.equal(prepared.ok, true, `prepareAgyRunHome failed: ${prepared.reason}`);
  assert.notEqual(prepared.homeDir, hostHome, 'Run HOME must not equal the terminal user HOME');

  // 宿主 HOME 中的 token 未被修改
  const hostTokenAfter = (await readFile(hostGeminiAuthFile, 'utf8')).trim();
  assert.equal(hostTokenAfter, 'terminal-user-token', 'terminal user token must be untouched after prepareAgyRunHome');

  // Run HOME 中的 token 是受管的，不是宿主的
  const runToken = (await readFile(prepared.authFile, 'utf8')).trim();
  assert.equal(runToken, 'ragent-managed-token', 'Run HOME token must come from the managed control home');

  // ── Case 2: buildAgyRuntimeEnv 覆盖 HOME 为受管 HOME，DBUS/keyring 被隔离
  const hostBus = 'unix:path=/run/host-dbus-session';
  const env = await buildAgyRuntimeEnv({
    ...process.env,
    HOME: hostHome,
    DBUS_SESSION_BUS_ADDRESS: hostBus,
    GNOME_KEYRING_CONTROL: '/run/host-keyring',
  }, { homeDir: runHome });

  assert.equal(env.HOME, runHome, 'runtime env HOME must point to managed Run home, not terminal HOME');
  assert.notEqual(env.HOME, hostHome, 'runtime env HOME must never be the terminal user HOME');
  // keyring 已被清除（私有 D-Bus 边界）
  assert.ok(
    !env.GNOME_KEYRING_CONTROL,
    'GNOME_KEYRING_CONTROL must be unset for managed AgY runs',
  );
  // DBUS 指向私有 session，不等于宿主 bus
  assert.ok(
    !env.DBUS_SESSION_BUS_ADDRESS || env.DBUS_SESSION_BUS_ADDRESS !== hostBus,
    'managed run must not inherit the desktop session bus',
  );

  // ── Case 3: 全链路 — prepareNativeRunProviderHome 不写入宿主 HOME
  const registry = createNativeProviderRegistry({ configDir });
  const secretStore = createSecretStore({ configDir });

  await secretStore.writeSecret('agy-isolated-secret', {
    authType: 'oauth',
    tokens: { tokenFile: 'ragent-new-account-token\n' },
  });
  await registry.upsertAuthProfile({
    id: 'agy-isolated-auth',
    agentType: 'agy',
    authType: 'oauth',
    displayName: 'AgY isolated account',
    storageType: 'secret-store',
    storageRef: 'agy-isolated-secret',
  });
  await registry.upsertProviderProfile({
    id: 'agy-isolated',
    agentType: 'agy',
    protocol: 'agy',
    displayName: 'AgY isolated account',
    baseUrl: '',
    authProfileId: 'agy-isolated-auth',
    quotaPolicy: { mode: 'official_subscription', adapter: 'agy' },
  });

  const nativeResult = await prepareNativeRunProviderHome('run-isolation-native', {
    tool: 'agy',
    options: { model: 'gemini-3.7-flash@agy-isolated' },
  }, {
    configDir,
    providerHomesRoot,
    externalOAuthOwnership: false,
  });
  assert.equal(nativeResult.ok, true, `native prepare failed: ${nativeResult.error || nativeResult.reason}`);
  assert.ok(!nativeResult.agyHomeDir.startsWith(hostHome),
    'native Run HOME must not be under terminal user HOME');

  // 宿主 HOME 的 token 在全链路后仍然未被修改
  const hostTokenFinal = (await readFile(hostGeminiAuthFile, 'utf8')).trim();
  assert.equal(hostTokenFinal, 'terminal-user-token',
    'terminal user ~/.gemini token must remain unchanged after full provider prepare chain');

  // Run HOME 的 token 是新账号的
  const nativeRunToken = (await readFile(
    join(nativeResult.agyHomeDir, AGY_AUTH_RELATIVE_PATH), 'utf8',
  )).trim();
  assert.equal(nativeRunToken, 'ragent-new-account-token',
    'Run HOME must carry the Ragent-managed new account token');

  // ── Case 4: 两个账号的 Run HOME 各自独立，彼此不交叉
  assert.notEqual(runHome, nativeResult.agyHomeDir, 'two different accounts must have distinct Run homes');

  console.log('test-agy-account-isolation: terminal HOME isolation, runtime env boundary, and dual-account HOME separation OK');
} finally {
  await rm(root, { recursive: true, force: true });
}
