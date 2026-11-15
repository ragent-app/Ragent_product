import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  triggerSessionTaskCardSuggestion,
  triggerSessionWorkflowStateSuggestion,
} from '../chat/summarizer.mjs';
import { closeOperationLedger } from '../chat/operation-ledger.mjs';

const previousTaskCardSetting = process.env.RAGENT_TASK_CARD_SUGGESTIONS;
const previousWorkflowSetting = process.env.RAGENT_WORKFLOW_STATE_SUGGESTIONS;
const previousHome = process.env.HOME;
const previousConfigDir = process.env.RAGENT_CONFIG_DIR;
const previousOperationLedgerDir = process.env.RAGENT_OPERATION_LEDGER_DIR;

// Gate-skips now emit operation-ledger events; point the ledger at a temp
// dir so this test never touches instance data.
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-suggestion-toggles-'));
process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, '.config', 'ragent');
process.env.RAGENT_OPERATION_LEDGER_DIR = join(tempHome, 'operations');

process.env.RAGENT_TASK_CARD_SUGGESTIONS = 'off';
process.env.RAGENT_WORKFLOW_STATE_SUGGESTIONS = 'off';

try {
  const sessionMeta = {
    id: 'sess_suggestion_toggle',
    folder: '/tmp',
    name: 'suggestion toggle test',
    tool: 'claude',
  };

  const taskCard = await triggerSessionTaskCardSuggestion(sessionMeta);
  assert.equal(taskCard.ok, false);
  assert.equal(taskCard.throttled, true);
  assert.equal(taskCard.taskCard, null);

  const workflowState = await triggerSessionWorkflowStateSuggestion(sessionMeta);
  assert.equal(workflowState.ok, false);
  assert.equal(workflowState.throttled, true);

  // Disabled-by-env gate skips should be visible in the operation ledger.
  await closeOperationLedger(); // flush buffered writes before reading
  const operationFiles = readdirSync(process.env.RAGENT_OPERATION_LEDGER_DIR);
  const events = operationFiles
    .flatMap((name) => readFileSync(join(process.env.RAGENT_OPERATION_LEDGER_DIR, name), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)));
  const taskCardSkips = events.filter((e) => e.operation === 'task_card_suggestion' && e.kind === 'skipped' && e.reason === 'disabled');
  const workflowSkips = events.filter((e) => e.operation === 'workflow_state_suggestion' && e.kind === 'skipped' && e.reason === 'disabled');
  assert.equal(taskCardSkips.length, 1, 'task-card disabled gate should be ledgered');
  assert.equal(workflowSkips.length, 1, 'workflow-state disabled gate should be ledgered');
  assert.ok(taskCardSkips[0].operationId.startsWith('op_'), 'skipped events must carry an operationId');
} finally {
  if (previousTaskCardSetting === undefined) delete process.env.RAGENT_TASK_CARD_SUGGESTIONS;
  else process.env.RAGENT_TASK_CARD_SUGGESTIONS = previousTaskCardSetting;
  if (previousWorkflowSetting === undefined) delete process.env.RAGENT_WORKFLOW_STATE_SUGGESTIONS;
  else process.env.RAGENT_WORKFLOW_STATE_SUGGESTIONS = previousWorkflowSetting;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousConfigDir === undefined) delete process.env.RAGENT_CONFIG_DIR;
  else process.env.RAGENT_CONFIG_DIR = previousConfigDir;
  if (previousOperationLedgerDir === undefined) delete process.env.RAGENT_OPERATION_LEDGER_DIR;
  else process.env.RAGENT_OPERATION_LEDGER_DIR = previousOperationLedgerDir;
  rmSync(tempHome, { recursive: true, force: true });
}
