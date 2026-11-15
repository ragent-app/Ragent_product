// 实例级 ed25519 签名密钥：
//  - 每台 Ragent 实例生成一次，私钥留本机（0600）；公钥在短时设备配对时自动登记
//  - 设备入口切换（介绍人机制）：B 回调 A 握手用本机私钥签名；A 的介绍信（introSig）用本机私钥签名
//  - trusted-devices 只持有对方公钥（验签），本机签名能力由本文件提供，二者互补
import { generateKeyPairSync, sign } from 'crypto';
import { join } from 'path';
import { CONFIG_DIR } from './config.mjs';
import { readJson, writeJsonAtomic } from '../chat/fs-utils.mjs';

export const INSTANCE_SIGNING_KEY_FILE = join(CONFIG_DIR, 'instance-signing-key.json');

// 模块级单例：同进程内并发调用只生成一次（并发首次生成若各自落盘会互相覆盖，
// 导致「签名用的私钥 ≠ 上报的公钥」——曾经的真实 bug，勿改回无单例实现）
let signingKeyPromise = null;

// 保证本机密钥存在（首次生成并落盘）
export function ensureInstanceSigningKey() {
  if (!signingKeyPromise) {
    signingKeyPromise = (async () => {
      const existing = await readJson(INSTANCE_SIGNING_KEY_FILE, null);
      if (existing?.publicKeyPem && existing?.privateKeyPem) {
        return { publicKeyPem: existing.publicKeyPem, privateKeyPem: existing.privateKeyPem };
      }
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const keypair = {
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).trim(),
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).trim(),
        createdAt: new Date().toISOString(),
      };
      await writeJsonAtomic(INSTANCE_SIGNING_KEY_FILE, keypair, { mode: 0o600 });
      return keypair;
    })();
  }
  return signingKeyPromise;
}

// 本机公钥（SPKI PEM，trim 后；由配对客户端自动上报）
export async function getInstancePublicKey() {
  const keypair = await ensureInstanceSigningKey();
  return keypair.publicKeyPem;
}

// 本机私钥签名（base64url）；调用方负责构造消息
export async function signWithInstanceKey(message) {
  const keypair = await ensureInstanceSigningKey();
  return sign(
    null,
    Buffer.from(String(message), 'utf8'),
    keypair.privateKeyPem,
  ).toString('base64url');
}
