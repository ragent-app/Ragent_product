#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createDemoAccountPolicy } from './demo-credentials.mjs';

// The operator supplies credentials on stdin. Never echo input or overwrite an
// existing policy. An optional preferred instance does not grant access.
try {
  const target = process.argv[2];
  if (process.argv.length !== 3 || !target || !isAbsolute(target)) throw new Error('Provide an absolute output path.');
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 8192) throw new Error('Input is too large.');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const policy = await createDemoAccountPolicy(input);
  await writeFile(target, `${JSON.stringify(policy, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write('Demo policy created.\n');
} catch (error) {
  process.stderr.write(error?.code === 'EEXIST' ? 'Policy already exists.\n' : 'Demo policy creation failed. Check the input and output path.\n');
  process.exitCode = 1;
}
