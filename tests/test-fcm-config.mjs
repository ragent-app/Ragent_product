#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const dir = await mkdtemp(join(tmpdir(), 'ragent-fcm-config-'));
const file = join(dir, 'service-account.json');
const account = {
  project_id: 'test-project',
  client_email: 'fcm@example.test',
  private_key: 'not-used-by-this-test',
};
const previous = {
  file: process.env.RAGENT_FCM_SERVICE_ACCOUNT_FILE,
  json: process.env.RAGENT_FCM_SERVICE_ACCOUNT_JSON,
  googleJson: process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
};

try {
  const { isFcmConfigured } = await import(pathToFileURL(join(process.cwd(), 'chat/fcm.mjs')).href);

  delete process.env.RAGENT_FCM_SERVICE_ACCOUNT_FILE;
  delete process.env.RAGENT_FCM_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  assert.equal(await isFcmConfigured(), false, '无配置时不能启用 FCM');

  await writeFile(file, JSON.stringify(account));
  process.env.RAGENT_FCM_SERVICE_ACCOUNT_FILE = file;
  assert.equal(await isFcmConfigured(), true, '应从文件读取 FCM service account');

  await writeFile(file, '{invalid');
  assert.equal(await isFcmConfigured(), false, '无效文件不能启用 FCM');

  process.env.RAGENT_FCM_SERVICE_ACCOUNT_JSON = JSON.stringify(account);
  assert.equal(await isFcmConfigured(), true, '文件不可用时应兼容 JSON 环境变量');

  console.log('test-fcm-config: 4 assertions passed');
} finally {
  if (previous.file === undefined) delete process.env.RAGENT_FCM_SERVICE_ACCOUNT_FILE;
  else process.env.RAGENT_FCM_SERVICE_ACCOUNT_FILE = previous.file;
  if (previous.json === undefined) delete process.env.RAGENT_FCM_SERVICE_ACCOUNT_JSON;
  else process.env.RAGENT_FCM_SERVICE_ACCOUNT_JSON = previous.json;
  if (previous.googleJson === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  else process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = previous.googleJson;
  await rm(dir, { recursive: true, force: true });
}
