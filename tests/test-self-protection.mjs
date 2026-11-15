#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  computeSelfProtectionFacts,
  deriveRagentSelfProtectionRoots,
  isWithinProtectedRoot,
} from '../chat/self-protection.mjs';

let passed = 0;
function check(label, value) {
  assert.ok(value, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.deepEqual(actual, expected, `failed: ${label}`);
  passed += 1;
}

check('POSIX child is inside protected root', isWithinProtectedRoot('/var/lib/ragent', '/var/lib/ragent/config', 'linux'));
check('POSIX prefix sibling is outside protected root', !isWithinProtectedRoot('/var/lib/ragent', '/var/lib/ragent-evil', 'linux'));
check('Windows drive root preserves root semantics', isWithinProtectedRoot('C:\\', 'C:\\Ragent\\config', 'win32'));
check('Windows path comparison is case-insensitive', isWithinProtectedRoot('C:\\Ragent', 'c:\\ragent\\config', 'win32'));
check('Windows prefix sibling is outside protected root', !isWithinProtectedRoot('C:\\Ragent', 'C:\\Ragent-evil', 'win32'));
check('Windows two-dot descendant is protected', isWithinProtectedRoot('C:\\Ragent', 'C:\\Ragent\\..metadata\\secret', 'win32'));
check('POSIX two-dot descendant is protected', isWithinProtectedRoot('/var/lib/ragent', '/var/lib/ragent/..metadata/secret', 'linux'));
check('Windows parent escape is outside protected root', !isWithinProtectedRoot('C:\\Ragent', 'C:\\other\\secret', 'win32'));
check('POSIX parent escape is outside protected root', !isWithinProtectedRoot('/var/lib/ragent', '/var/lib/other/secret', 'linux'));

eq('unmatched target is computed and not protected', computeSelfProtectionFacts({
  canonicalPaths: ['/work/project/file.txt'],
  protectedRoots: [{ label: 'config', path: '/var/lib/ragent/config' }],
  workspaceRoot: '/work/project',
  platform: 'linux',
}), {
  computed: true,
  matched: false,
  workspaceRecommended: true,
  boundary: 'none',
});

eq('protected target is matched', computeSelfProtectionFacts({
  canonicalPaths: ['C:\\Ragent\\config\\auth.json'],
  protectedRoots: [{ label: 'config', path: 'C:\\Ragent' }],
  workspaceRoot: 'C:\\Work',
  platform: 'win32',
}), {
  computed: true,
  matched: true,
  workspaceRecommended: false,
  boundary: 'ragent-service',
});

eq('two-dot descendant retains the self-protection ceiling', computeSelfProtectionFacts({
  canonicalPaths: ['C:\\Ragent\\..metadata\\auth.json'],
  protectedRoots: [{ label: 'config', path: 'C:\\Ragent' }],
  workspaceRoot: 'C:\\Ragent',
  platform: 'win32',
}), {
  computed: true,
  matched: true,
  workspaceRecommended: true,
  boundary: 'ragent-service',
});

eq('unavailable root fails closed', computeSelfProtectionFacts({
  canonicalPaths: ['/var/lib/ragent/config/auth.json'],
  protectedRoots: [{ label: 'config', path: '/var/lib/ragent', available: false }],
  workspaceRoot: '/work',
  platform: 'linux',
}), {
  computed: false,
  matched: false,
  workspaceRecommended: false,
  boundary: 'none',
});

const roots = deriveRagentSelfProtectionRoots({ platform: 'linux' });
check('Linux self-protection roots include source and config', roots.some((entry) => entry.label === 'ragent-source')
  && roots.some((entry) => entry.label === 'ragent-config'));

console.log(`self-protection: ${passed} checks passed`);
