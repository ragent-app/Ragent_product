#!/usr/bin/env node

import { basename } from 'path';

import { backfillOwnerBootstrapSessions } from '../chat/bootstrap-sessions.mjs';

const result = await backfillOwnerBootstrapSessions();
const instanceRoot = process.env.RAGENT_INSTANCE_ROOT || '';

console.log(JSON.stringify({
  instance: instanceRoot ? basename(instanceRoot) : '',
  created: result.created,
  updated: result.updated,
  welcomeSessionId: result.welcomeSession?.id || '',
}, null, 2));
