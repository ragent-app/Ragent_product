import { win32 } from 'node:path';

// ProgramData is set by the protected service host from the Windows known
// folder. This helper only accepts the exact fixed owner instance layout.
export function ownerIdentityPathForService(env = process.env) {
  const data = typeof env.ProgramData === 'string' ? env.ProgramData.trim() : '';
  if (!/^[a-z]:[\\/]/i.test(data) || !win32.isAbsolute(data)) return null;
  const root = win32.join(data, 'Ragent', 'instances', 'owner');
  const config = win32.join(root, 'config');
  const same = (value, expected) => typeof value === 'string' && /^[a-z]:[\\/]/i.test(value)
    && win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase() === expected.toLowerCase();
  if (!same(env.RAGENT_INSTANCE_ROOT, root) || !same(env.RAGENT_CONFIG_DIR, config)) return null;
  return win32.join(config, 'instance-identity.json');
}
