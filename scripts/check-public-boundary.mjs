#!/usr/bin/env node
// Checks the Git-visible source set. This is a boundary check, not a secret scan.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const forbidden = [
  /^(?:\.agents|\.codex|archive|design|notes|deploy)\//i,
  /^android\/(?:design|frames|review|screenshots)\//i,
  /^android\/app\/screenshots\//i,
  /^(?:app\/screenshots|web\/review|workspace)\//i,
  /^static\/chat\/img\/sticker-bear\.gif$/i,
  /^scripts\/clean-resp-msg-session-ids\.mjs$/i,
  /^tests\/(?:generate-goal-screenshots|test-notification-containers-visual)\.mjs$/i,
  /^tests\/(?:live-|windows-medium-|results\/)/i,
  /^scripts\/windows-a0-smoke\.mjs$/i,
  /^automation\/instance-factory\/(?:manifests|profiles)\//i,
  /^tests\/fixtures\/risk-datasets\/taglio4-[^/]+\.jsonl$/i,
  /\.bak-[^/]+$/i,
  /^android\/docs\/(?!README\.md$)/i,
  /^bin\/(?:agentoc|ragent)-p2p-host/i,
  /(^|\/)(?:node_modules|\.gradle|\.kotlin|build)\//i,
  /(^|\/)(?:google-services\.json|keystore\.properties)$/i,
  /(^|\/)\.env(?:$|\.(?!example$))/i,
  /(^|\/)turn-broker-signing-key\.json$/i,
  /(^|\/)(?:signing-key|accounts|auth|auth-sessions)\.json$/i,
  /\.(?:sqlite(?:-shm|-wal)?|db)$/i,
  /^cloudflare\/email-worker\/wrangler\.jsonc$/i,
  /(^|\/)\.dev\.vars$/i,
  /\.(?:apk|aab|msi|p12|pfx|pem|jks|keystore)$/i,
];
export function findForbiddenPaths(names) {
  return [...new Set(names.filter(name => forbidden.some(rule => rule.test(name))))];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const names = execFileSync('git', [
    'ls-files', '-z', '--cached', '--others', '--exclude-standard',
  ], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('\0').filter(Boolean);
  const matches = findForbiddenPaths(names);
  if (matches.length) {
    console.error('Public boundary contains forbidden files:');
    for (const name of matches) console.error(`  ${name}`);
    process.exitCode = 1;
  } else {
    console.log(`Public boundary check passed for ${names.length} Git-visible files.`);
  }
}
