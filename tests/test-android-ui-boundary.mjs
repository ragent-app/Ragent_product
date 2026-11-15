#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const featureFiles = [
  'android/feature/workbench/src/main/java/com/andysagent/ragent/feature/workbench/ProjectsSessionsSurface.kt',
  'android/feature/workbench/src/main/java/com/andysagent/ragent/feature/workbench/WorkbenchScreen.kt',
  'android/feature/workbench/src/main/java/com/andysagent/ragent/feature/workbench/accounts/GoogleAccountCard.kt',
];
const forbidden = [
  /androidx\.compose\.material3\.(AlertDialog|Button|Card|DropdownMenu|DropdownMenuItem|OutlinedTextField|TextField)/,
  /MaterialTheme\.colorScheme\./,
  /\b\d+\.dp\b/,
  /RoundedCornerShape\(/,
  /tween\(/,
];

for (const relativePath of featureFiles) {
  const source = readFileSync(join(repoRoot, relativePath), 'utf8');
  for (const pattern of forbidden) {
    assert.doesNotMatch(source, pattern, `${relativePath} must consume core design-system wrappers (${pattern})`);
  }
}

const designSystem = readFileSync(join(repoRoot, 'android/core/designsystem/src/main/java/com/andysagent/ragent/core/designsystem/RagentComponents.kt'), 'utf8');
assert.match(designSystem, /fun AgentoDropdownMenu\(/, 'design system should own dropdown menu construction');
assert.match(designSystem, /fun AgentoDropdownMenuItem\(/, 'design system should own dropdown menu items');
assert.match(designSystem, /fun AgentoIcon\(/, 'design system should own icon tint defaults');
assert.match(designSystem, /minHeight = RagentSpacing\.TouchTarget/, 'menu items should preserve touch target');
console.log('test-android-ui-boundary: ok');
