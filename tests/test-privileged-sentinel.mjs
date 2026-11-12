#!/usr/bin/env node
import assert from 'assert/strict';

import {
  PRIVILEGED_SENTINEL_PROGRAM,
  parsePrivilegedSentinel,
} from '../chat/privileged-sentinel.mjs';
import { classifyPrivilegedOperation } from '../chat/privileged-classifier.mjs';
import {
  CATEGORY_DELETE,
  CATEGORY_INSTALL,
  CATEGORY_OTHER,
} from '../chat/privileged-classifier.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}

// --- not a sentinel -> null ---
check('null on plain command', parsePrivilegedSentinel('ls -la') === null);
check('null on sudo direct (no wrapper)', parsePrivilegedSentinel('sudo apt-get install -y nginx') === null);
check('null on empty string', parsePrivilegedSentinel('') === null);
check('null on whitespace', parsePrivilegedSentinel('   ') === null);
check('null on non-string', parsePrivilegedSentinel(null) === null);
check('null on unrelated agentoc- prefix', parsePrivilegedSentinel('agentoc-foo -- true') === null);
check('constant exported', PRIVILEGED_SENTINEL_PROGRAM === 'ragent-privileged');
check('new sentinel accepted', parsePrivilegedSentinel('ragent-privileged -- true')?.valid === true);

// --- bare sentinel, no separator -> malformed ---
{
  const r = parsePrivilegedSentinel('agentoc-privileged');
  check('bare is sentinel', r?.isSentinel === true);
  check('bare not valid', r.valid === false);
  check('bare malformed reason', /separator/.test(r.malformedReason));
  check('bare realCommand empty', r.realCommand === '');
}

// --- canonical valid form ---
{
  const r = parsePrivilegedSentinel(
    'agentoc-privileged --description "install nginx" --category install -- apt-get install -y nginx',
  );
  check('valid', r.valid === true);
  check('description', r.description === 'install nginx');
  check('declaredCategory raw', r.declaredCategory === 'install');
  check('realCommand verbatim', r.realCommand === 'apt-get install -y nginx');
  check('no malformedReason when valid', r.malformedReason === undefined);
  check('program field', r.program === 'ragent-privileged');
}

// --- single-quoted description, delete ---
{
  const r = parsePrivilegedSentinel(
    "agentoc-privileged --description 'rm cache' --category delete -- rm -rf /tmp/x",
  );
  check('single-quote description', r.description === 'rm cache');
  check('delete category', r.declaredCategory === 'delete');
  check('rm realCommand', r.realCommand === 'rm -rf /tmp/x');
}

// --- no description, no category ---
{
  const r = parsePrivilegedSentinel('agentoc-privileged -- echo hi');
  check('minimal valid', r.valid === true);
  check('empty description', r.description === '');
  check('empty declaredCategory', r.declaredCategory === '');
  check('echo realCommand', r.realCommand === 'echo hi');
}

// --- category only ---
{
  const r = parsePrivilegedSentinel('agentoc-privileged --category other -- systemctl restart nginx');
  check('other category', r.declaredCategory === 'other');
  check('systemctl realCommand', r.realCommand === 'systemctl restart nginx');
}

// --- real command preserved verbatim even when composite ---
{
  const cmd = 'apt-get install -y nginx && systemctl restart nginx';
  const r = parsePrivilegedSentinel(`agentoc-privileged --description "pipe" --category other -- ${cmd}`);
  check('composite realCommand verbatim', r.realCommand === cmd);
}

// --- missing separator -> malformed (options present, no --) ---
{
  const r = parsePrivilegedSentinel('agentoc-privileged --description "x" --category install apt-get install nginx');
  check('no separator is sentinel', r.isSentinel === true);
  check('no separator invalid', r.valid === false);
  check('no separator reason', /separator/.test(r.malformedReason));
  check('no separator realCommand empty', r.realCommand === '');
}

// --- empty real command after -- ---
{
  const r = parsePrivilegedSentinel('agentoc-privileged --description "x" -- ');
  check('empty real invalid', r.valid === false);
  check('empty real reason', /empty real command/.test(r.malformedReason));
}

// --- path-prefixed program tolerated ---
{
  const r = parsePrivilegedSentinel('/usr/local/bin/agentoc-privileged -- true');
  check('path-prefixed is sentinel', r.isSentinel === true);
  check('path-prefixed valid', r.valid === true);
  check('path-prefixed realCommand', r.realCommand === 'true');
}

// --- flag boundary: --category immediately followed by --description ---
{
  const r = parsePrivilegedSentinel('agentoc-privileged --category --description "x" -- true');
  check('boundary category empty', r.declaredCategory === '');
  check('boundary description captured', r.description === 'x');
  check('boundary valid', r.valid === true);
}

// --- description value that starts with a dash (quoted) is kept ---
{
  const r = parsePrivilegedSentinel('agentoc-privileged --description "- note" --category other -- echo hi');
  check('dash-leading description kept', r.description === '- note');
}

// --- unknown flags before separator are ignored ---
{
  const r = parsePrivilegedSentinel('agentoc-privileged --foo bar --description "x" -- true');
  check('unknown flag ignored, description kept', r.description === 'x');
  check('unknown flag still valid', r.valid === true);
}

// --- --desc short alias works ---
{
  const r = parsePrivilegedSentinel('agentoc-privileged --desc "quick" --category install -- apt install nginx');
  check('desc alias', r.description === 'quick');
}

// --- leading/trailing whitespace trimmed ---
{
  const r = parsePrivilegedSentinel('   agentoc-privileged -- echo hi   ');
  check('trimmed valid', r.valid === true);
  check('trimmed realCommand', r.realCommand === 'echo hi');
}

// --- composition with the classifier (P1c-1 feeds P1a) ---
{
  const parsed = parsePrivilegedSentinel(
    'agentoc-privileged --description "install nginx" --category install -- apt-get install -y nginx',
  );
  const classified = classifyPrivilegedOperation({
    command: parsed.realCommand,
    declaredCategory: parsed.declaredCategory,
  });
  check('composition install category', classified.category === CATEGORY_INSTALL);
  check('composition install in-scope', classified.inScope === true);
}
{
  // declared "other" but real command is destructive -> reconcile to delete (more restrictive)
  const parsed = parsePrivilegedSentinel(
    'agentoc-privileged --description "cleanup" --category other -- rm -rf /var/log/x',
  );
  const classified = classifyPrivilegedOperation({
    command: parsed.realCommand,
    declaredCategory: parsed.declaredCategory,
  });
  check('composition reconciles to delete', classified.category === CATEGORY_DELETE);
  check('composition override flagged', classified.override === true);
}
{
  // no category declared -> classifier derives other
  const parsed = parsePrivilegedSentinel('agentoc-privileged -- true');
  const classified = classifyPrivilegedOperation({ command: parsed.realCommand });
  check('composition derives other', classified.category === CATEGORY_OTHER);
}

console.log(`privileged-sentinel: ${passed} checks passed`);
