#!/usr/bin/env node

import { homedir } from 'os';
import { join } from 'path';
import { generateSessionToolReuseSidecar } from '../lib/session-tool-reuse.mjs';

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const date = readArg('--date');
const daysArg = readArg('--days');
const configDir = readArg('--config-dir') || join(homedir(), '.config', 'ragent');
const outputDir = readArg('--output-dir') || join(homedir(), '.ragent', 'reports', 'session-tool-reuse');
const days = daysArg ? Number(daysArg) : 1;

if (!Number.isInteger(days) || days < 1) {
  console.error('Expected --days to be an integer >= 1');
  process.exit(1);
}

const sidecar = await generateSessionToolReuseSidecar({
  configDir,
  outputDir,
  date,
  days,
});

console.log(sidecar.summary);
console.log(`Markdown: ${sidecar.markdownPath}`);
console.log(`JSON: ${sidecar.jsonPath}`);
