// AgY Provider Authentication Manager
// Handles AgY CLI credential management and authentication state

import { access, chmod, mkdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import { join } from 'path';

import {
  AGY_CONTROL_HOME_DIR,
  CONFIG_DIR,
} from '../lib/config.mjs';
import { AGY_AUTH_RELATIVE_PATH } from './agy-runtime.mjs';

const AGY_AUTH_STATE_FILE = join(CONFIG_DIR, 'agy-auth-state.json');
const AGY_CONFIG_MARKER = '# Ragent-managed AgY runtime home.';

// AgY configuration files
// Keep the old export name for compatibility, but point it at the same
// control-owned home used by the native provider management path.
const AGY_MANAGED_HOME_DIR = AGY_CONTROL_HOME_DIR;
const AGY_MANAGED_FILES = [AGY_AUTH_RELATIVE_PATH];

async function ensureAgyManagedHome() {
  await mkdir(AGY_MANAGED_HOME_DIR, { recursive: true });
  await chmod(AGY_MANAGED_HOME_DIR, 0o700);
}

async function getAgyAuthState() {
  try {
    const data = await readFile(AGY_AUTH_STATE_FILE, 'utf8');
    const parsed = JSON.parse(data);
    const normalized = normalizeAgyAuthState(parsed);
    if (parsed?.managedHome !== normalized.managedHome) {
      await saveAgyAuthState(normalized);
    }
    return normalized;
  } catch {
    return normalizeAgyAuthState();
  }
}

function normalizeAgyAuthState(value = {}) {
  const state = value && typeof value === 'object' ? value : {};
  return {
    version: Number.isInteger(state.version) ? state.version : 1,
    providers: Array.isArray(state.providers) ? state.providers : [],
    lastSync: typeof state.lastSync === 'string' ? state.lastSync : null,
    // The state file can survive an instance relocation. Never trust its
    // historical path when reporting or updating the active control home.
    managedHome: AGY_MANAGED_HOME_DIR,
  };
}

async function saveAgyAuthState(state) {
  await writeFile(AGY_AUTH_STATE_FILE, JSON.stringify(normalizeAgyAuthState(state), null, 2), { mode: 0o600 });
}

async function discoverAgyCredentials() {
  // Ragent owns only its registry/vault and the legacy migration source.
  // Never scan the terminal user's HOME, AGY_HOME, or keyring: doing so makes
  // a terminal login appear to be an Ragent account and reintroduces the
  // exact cross-client overwrite bug this runtime is designed to remove.
  const homes = new Set([AGY_MANAGED_HOME_DIR]);
  const credentials = [];

  const searchPaths = [...homes];

  for (const searchPath of searchPaths) {
    try {
      await access(searchPath);

      // Look for AgY configuration files
      for (const file of AGY_MANAGED_FILES) {
        const filePath = join(searchPath, file);
        try {
          const data = await readFile(filePath, 'utf8');
          if (data.trim()) {
            credentials.push({
              source: filePath,
              type: file.replace('.json', ''),
              data,
              lastModified: Date.now()
            });
          }
        } catch {
          // File doesn't exist or can't be read
        }
      }
    } catch {
      // Path doesn't exist
    }
  }

  return credentials;
}

async function syncAgyCredentials() {
  await ensureAgyManagedHome();

  const credentials = await discoverAgyCredentials();
  const state = await getAgyAuthState();

  // Update state with discovered credentials
  state.providers = credentials.map(cred => ({
    source: cred.source,
    type: cred.type,
    lastSync: new Date().toISOString()
  }));
  state.lastSync = new Date().toISOString();

  await saveAgyAuthState(state);

  return {
    success: true,
    credentialsFound: credentials.length,
    providers: state.providers
  };
}

async function createAgyManagedConfig(config = {}) {
  await ensureAgyManagedHome();

  const configPath = join(AGY_MANAGED_HOME_DIR, 'config.json');
  const defaultConfig = {
    marker: AGY_CONFIG_MARKER,
    managedBy: 'Ragent',
    version: 1,
    ...config
  };

  await writeFile(configPath, JSON.stringify(defaultConfig, null, 2), { mode: 0o600 });
  return configPath;
}

async function getAgyStatus() {
  try {
    const state = await getAgyAuthState();
    const authPath = join(AGY_MANAGED_HOME_DIR, AGY_AUTH_RELATIVE_PATH);
    const authExists = await stat(authPath)
      .then((info) => info.isFile() && info.size > 0)
      .catch(() => false);

    return {
      configured: authExists,
      managedHome: AGY_MANAGED_HOME_DIR,
      providers: state.providers || [],
      lastSync: state.lastSync
    };
  } catch {
    return {
      configured: false,
      managedHome: AGY_MANAGED_HOME_DIR,
      providers: [],
      lastSync: null
    };
  }
}

async function setupAgyAuthentication(authConfig = {}) {
  await ensureAgyManagedHome();

  const configPath = await createAgyManagedConfig(authConfig);

  // Update authentication state
  const state = await getAgyAuthState();
  state.providers.push({
    source: configPath,
    type: 'managed',
    setupDate: new Date().toISOString()
  });
  state.lastSync = new Date().toISOString();

  await saveAgyAuthState(state);

  return {
    success: true,
    configPath,
    managedHome: AGY_MANAGED_HOME_DIR
  };
}

async function removeAgyCredentials() {
  await unlink(join(AGY_MANAGED_HOME_DIR, AGY_AUTH_RELATIVE_PATH)).catch(() => {});
  await unlink(join(AGY_MANAGED_HOME_DIR, 'auth.json')).catch(() => {});
  await unlink(join(AGY_MANAGED_HOME_DIR, 'config.json')).catch(() => {});

  // Update state
  const state = await getAgyAuthState();
  state.providers = [];
  state.lastSync = new Date().toISOString();
  await saveAgyAuthState(state);

  return { success: true };
}

export {
  syncAgyCredentials,
  getAgyStatus,
  setupAgyAuthentication,
  removeAgyCredentials,
  createAgyManagedConfig,
  AGY_MANAGED_HOME_DIR,
  AGY_CONFIG_MARKER
};
