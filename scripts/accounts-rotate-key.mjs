#!/usr/bin/env node
// Accounts 签名密钥轮换：读取 key ring 文件，生成新主 key，旧主 key 标记退役
// （宽限期 24h 内仍出现在 JWKS 供旧 assertion 按 kid 校验），原子写回。
// 超过宽限期的已退役 key 会被清理。
// 用法：
//   node scripts/accounts-rotate-key.mjs [--file <signing-key.json>]
import { join } from 'node:path';
import {
  KEY_RETIRED_GRACE_MS,
  loadOrCreateSigningKeyRing,
  rotateSigningKey,
  saveSigningKeyRing,
} from '../accounts/keys.mjs';

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const file =
  argValue('--file', process.env.RAGENT_ACCOUNTS_SIGNING_KEY_FILE || '') ||
  join(process.env.RAGENT_ACCOUNTS_DATA_DIR || '.', 'signing-key.json');

const ring = await loadOrCreateSigningKeyRing(file);
const previousKid = ring.primaryKid;
const next = await saveSigningKeyRing(file, rotateSigningKey(ring));

console.log(`accounts-rotate-key: ${file}`);
console.log(`  previous primary: ${previousKid}`);
console.log(`  new primary:      ${next.primaryKid}`);
console.log(
  `  jwks keys:        ${Object.values(next.keys).filter((key) => !key.retiredAt || Date.now() - Date.parse(key.retiredAt) < KEY_RETIRED_GRACE_MS).length}`,
);
console.log('old assertions remain verifiable via JWKS until the retire grace window ends');
