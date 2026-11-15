import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const read = async name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const scripts = await Promise.all(['static/chat/approval-explanation.js', 'static/chat/attention-popup.js', 'static/chat/decisions-store.js', 'static/chat/decision-sheet.js'].map(read));
const html = await read('templates/chat.html');
assert.ok(html.indexOf('chat/approval-explanation.js') > 0);
assert.ok(html.indexOf('chat/approval-explanation.js') < html.indexOf('chat/attention-popup.js'));
assert.ok(html.indexOf('chat/approval-explanation.js') < html.indexOf('chat/decision-sheet.js'));
let browser;
try { browser = await chromium.launch({headless:true}); } catch { browser = await chromium.launch({headless:true,channel:'chrome'}); }
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><div id="inputArea"><div id="liveBar"></div></div>');
  await page.evaluate(() => {
    window.getChatStoreStateSnapshot = () => ({currentSessionId:'foreground'});
    window.getChatStoreSession = id => ({id, name:'QA'});
    window.getApprovalTitle = () => 'Bash';
    window.ragentT = (key, vars = {}) => ({
      'decisionSheet.operation.delete':'delete', 'decisionSheet.operation.may':'May {action}',
      'decisionSheet.operationRisk.partial':'Review conditional command',
      'decisionSheet.operationRisk.delete':'Deletion may be irreversible',
      'decisionSheet.operationRisk.provider_conflict':'The provider description may conflict',
      'decisionSheet.providerDescription':'Provider description',
      'decisionSheet.explanation.reason':'Why attention',
      'decisionSheet.explanation.summary':'Summary',
      'decisionSheet.explanation.title':'Explanation',
    }[key] || key).replace(/\{(\w+)\}/g, (_, k) => vars[k] || '');
  });
  for (const content of scripts) await page.addScriptTag({content});
  const event = {type:'approval_request',approvalId:'qa',kind:'command',status:'pending',reason:'Read target',
    command:'if true; then rm -f /tmp/example_file.txt; fi',explanation:{operation:'delete', targets:['/tmp/example_file.txt'],conditional:true,partial:true,riskCode:'composite_unanalyzed',summary:'old',reason:'old',providerConflict:true}};
  await page.evaluate(event => window.RagentAttentionPopup.onRealtimeEvents('background',[event]), event);
  assert.equal(await page.locator('#attentionPopupTitle').textContent(), 'May delete: /tmp/example_file.txt');
  await page.locator('#attentionPopupTitle').click();
  const popup = page.locator('#attentionPopupHost');
  assert.match(await popup.innerText(), /Deletion may be irreversible/);
  assert.match(await popup.innerText(), /Read target/);
  assert.match(await popup.innerText(), /provider description may conflict/);
  assert.match(await popup.innerText(), /rm -f/);
  await page.evaluate(() => window.RagentAttentionPopup._reset());
  await page.evaluate(explanation => window.RagentAttentionPopup.onRealtimeEvents('background', [{
    type:'privileged_batch_request',batchId:'batch',runId:'r',other:[
      {opId:'one',description:'First',command:'rm /tmp/example_file.txt',explanation},
      {opId:'two',description:'Second',command:'rm /tmp/other.txt',explanation:{...explanation,targets:['/tmp/other.txt']}}
    ],delete:[]
  }]), event.explanation);
  assert.equal(await page.locator('#attentionPopupTitle').textContent(), 'attention.danger.title');
  await page.locator('#attentionPopupTitle').click();
  const batchText = await page.locator('#attentionPopupHost').innerText();
  assert.match(batchText, /example_file\.txt/);
  assert.match(batchText, /other\.txt/);
  assert.match(batchText, /First/);
  assert.match(batchText, /Second/);
  await page.evaluate(() => window.RagentAttentionPopup._reset());
  await page.evaluate(event => window.RagentDecisions.noteRequest(event), event);
  assert.equal(await page.locator('#decisionSheet .oneui-notification__title').textContent(), 'May delete: /tmp/example_file.txt');
  await page.locator('#decisionSheet .oneui-notification__summary').click();
  const sheetText = await page.locator('#decisionSheet').innerText();
  assert.match(sheetText, /Read target/);
  assert.match(sheetText, /provider description may conflict/);
  assert.match(sheetText, /Deletion may be irreversible/);
  assert.match(sheetText, /rm -f/);
  assert.equal((sheetText.match(/May delete: \/tmp\/example_file\.txt/g) || []).length, 1);
  await page.evaluate(() => { window.RagentDecisions.noteResponse({approvalId:'qa'}); window.getApprovalTitle = e => e.reason; });
  await page.waitForTimeout(250);
  await page.evaluate(() => window.RagentDecisions.noteRequest({type:'approval_request',approvalId:'legacy',kind:'command',
    reason:'Remove example',command:'if true; then rm example; fi',explanation:{summary:'包含 3 步操作',
      reason:'命令串联了多个步骤，部分行为无法静态确认',saferAlternative:'拆成单条命令逐步确认后再执行'}}));
  await page.locator('#decisionSheet .oneui-notification__summary').click();
  const legacyText = await page.locator('#decisionSheet').innerText();
  assert.equal((legacyText.match(/Remove example/g) || []).length, 1);
  assert.doesNotMatch(legacyText, /包含 3 步操作|Run command/);
  assert.match(legacyText, /Review conditional command/);
  const localePage = await browser.newPage();
  await localePage.setContent('<!doctype html><html><head></head><body></body></html>');
  await localePage.addScriptTag({content: await read('static/chat/i18n.js')});
  await localePage.addScriptTag({content: scripts[0]});
  const localized = await localePage.evaluate(explanation => {
    window.ragentSetUiLanguagePreference('zh-CN');
    const zh = window.ragentApprovalExplanation(explanation, window.ragentT);
    window.ragentSetUiLanguagePreference('en');
    const en = window.ragentApprovalExplanation(explanation, window.ragentT);
    return {zh, en};
  }, event.explanation);
  assert.equal(localized.zh.summary, '可能删除: /tmp/example_file.txt');
  assert.equal(localized.en.summary, 'May delete: /tmp/example_file.txt');
  assert.doesNotMatch(localized.en.reason, /[\u4e00-\u9fff]/);
  await localePage.close();
  if (process.env.RAGENT_APPROVAL_REPLAY_FILE) {
    const encoded = await readFile(process.env.RAGENT_APPROVAL_REPLAY_FILE, 'utf8');
    const captured = JSON.parse(Buffer.from(encoded.trim(), 'base64').toString('utf8')).events[0];
    const replay = await browser.newPage();
    await replay.setContent('<!doctype html><div id="inputArea"><div id="liveBar"></div></div>');
    await replay.addScriptTag({content: await read('static/chat/i18n.js')});
    await replay.evaluate(() => window.ragentSetUiLanguagePreference('en'));
    await replay.addScriptTag({content: scripts[0]});
    await replay.addScriptTag({content: scripts[2]});
    await replay.addScriptTag({content: scripts[3]});
    await replay.evaluate(e => window.RagentDecisions.noteRequest(e), captured);
    const title = await replay.locator('#decisionSheet .oneui-notification__title').textContent();
    assert.ok(title.startsWith('May delete: '));
    assert.ok(title.includes(captured.explanation.targets[0]));
    await replay.locator('#decisionSheet .oneui-notification__summary').click();
    const replayText = await replay.locator('#decisionSheet').innerText();
    assert.match(replayText, /rm -f/);
    assert.match(replayText, /conditional or compound shell syntax/);
    assert.doesNotMatch(replayText, /包含 3 步操作/);
    await replay.close();
  }
  await page.close();
} finally { await browser.close(); }
console.log('approval web surfaces: passed');
