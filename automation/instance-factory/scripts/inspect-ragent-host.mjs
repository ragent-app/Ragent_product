#!/usr/bin/env node
import { inspectRagentHost } from '../../../lib/instance-factory-command.mjs';

const report = await inspectRagentHost();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
