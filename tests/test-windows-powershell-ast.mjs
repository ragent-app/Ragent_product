import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parseWindowsPowerShellAst } from '../chat/windows-powershell-ast.mjs';

if (process.platform !== 'win32') {
  console.log('windows-powershell-ast: skipped (requires Windows PowerShell)');
  process.exit(0);
}
const plain = await parseWindowsPowerShellAst('Get-Content -LiteralPath "a b.txt"');
assert.equal(plain.errors.length, 0);
assert.equal(plain.assignmentCount, 0);
assert.deepEqual(plain.chainOperators, []);
assert.equal(plain.commands[0].name, 'Get-Content');
assert.deepEqual(plain.commands[0].elements.map((x) => x.kind), ['literal', 'parameter', 'literal']);
assert.equal(plain.commands[0].elements[2].value, 'a b.txt');
const unicode = await parseWindowsPowerShellAst('Get-Content "中文 文档.md"');
assert.equal(unicode.commands[0].elements[1].value, '中文 文档.md');
const literalPaths = await parseWindowsPowerShellAst('Get-Content -LiteralPath first.txt,second.txt');
assert.deepEqual(literalPaths.commands[0].elements[2], { kind: 'literal_list', values: ['first.txt', 'second.txt'] });
assert.equal(literalPaths.dynamicNodes.length, 0);
assert.ok((await parseWindowsPowerShellAst('Get-Content first.txt,$env:TEMP')).dynamicNodes.length);
const pipeline = await parseWindowsPowerShellAst('Get-Content README.md | Select-Object -First 1');
assert.deepEqual(pipeline.commands.map((x) => x.name), ['Get-Content', 'Select-Object']);
assert.deepEqual(pipeline.commands.map((x) => x.pipelineInput), [false, true]);
const pipedExpression = await parseWindowsPowerShellAst("'fixture' | Get-Command -ListImported");
assert.equal(pipedExpression.commands[0].pipelineInput, true);
const separateCommands = await parseWindowsPowerShellAst('Get-Date; Get-Command -ListImported');
assert.deepEqual(separateCommands.commands.map((x) => x.pipelineInput), [false, false]);
const redirect = await parseWindowsPowerShellAst('Write-Output hello >> "中文 文件.md"');
assert.equal(redirect.commands[0].redirections, 1);
assert.deepEqual(redirect.commands[0].redirectFacts[0], { type: 'FileRedirectionAst', location: '中文 文件.md', locationType: 'StringConstantExpressionAst' });
const literalRedirect = await parseWindowsPowerShellAst("'hello' > output.md");
assert.equal(literalRedirect.expressions[0].expressionType, 'StringConstantExpressionAst');
assert.equal(literalRedirect.expressions[0].redirectFacts[0].location, 'output.md');
const dynamic = await parseWindowsPowerShellAst('Get-Content $env:TEMP');
assert.equal((await parseWindowsPowerShellAst("$p='G:\\fixture'; Get-Item -LiteralPath $p")).assignmentCount, 1);
const confirmFalse = await parseWindowsPowerShellAst('Remove-Item -Confirm:$false fixture.txt');
assert.deepEqual(confirmFalse.dynamicNodes, []);
assert.equal(confirmFalse.commands[0].elements[1].argumentType, 'StaticConfirmFalse');
assert.ok((await parseWindowsPowerShellAst('Remove-Item -Confirm:$true fixture.txt')).dynamicNodes.length);
assert.ok((await parseWindowsPowerShellAst('Remove-Item -Confirm:$env:FLAG fixture.txt')).dynamicNodes.length);
const staticWrite = await parseWindowsPowerShellAst("[System.IO.File]::WriteAllText('文档.txt', 'hello')");
assert.deepEqual(staticWrite.dynamicNodes, []);
assert.deepEqual(staticWrite.expressions[0].staticFileCall, { kind: 'write', path: '文档.txt', method: 'WriteAllText' });
const encodedWrite = await parseWindowsPowerShellAst("[System.IO.File]::WriteAllText('文档.txt', 'hello', [System.Text.Encoding]::UTF8)");
assert.deepEqual(encodedWrite.dynamicNodes, []);
assert.deepEqual(encodedWrite.expressions[0].staticFileCall, { kind: 'write', path: '文档.txt', method: 'WriteAllText' });
for (const source of ["[System.IO.File]::Move('a', 'b')", "[System.IO.File]::WriteAllText('a', $env:TEMP)",
  "[System.IO.Directory]::Delete('a', $true)", "[System.IO.File]::WriteAllText('a', (Get-Date).ToString())",
  "[System.IO.File]::WriteAllText('a', 'b', [System.Text.Encoding]::GetEncoding(65001))",
  "[System.IO.File]::WriteAllText('a', 'b', [System.Environment]::CommandLine)",
  "[System.Text.Encoding]::UTF8"]) {
  assert.ok((await parseWindowsPowerShellAst(source)).dynamicNodes.length, source);
}
assert.ok(dynamic.dynamicNodes.includes('VariableExpressionAst'));
const syntax = await parseWindowsPowerShellAst('Get-Content "unterminated');
assert.ok(syntax.errors.length);
const literal = await parseWindowsPowerShellAst("Write-Output '$env:TEMP'");
assert.equal(literal.dynamicNodes.length, 0);
const nested = await parseWindowsPowerShellAst('Get-ChildItem . | ForEach-Object { $_.Name }');
assert.ok(nested.dynamicNodes.length > 0);
const commandChain = await parseWindowsPowerShellAst("Set-Content -LiteralPath 'a.txt' -Value 'PASS' && Get-Content -LiteralPath 'a.txt'");
assert.ok(commandChain.errors.length > 0, 'Windows PowerShell 5.1 reports PowerShell 7 chain syntax as an error');
assert.deepEqual(commandChain.chainOperators.map((item) => item.operator), ['AndAnd']);
const quotedChain = await parseWindowsPowerShellAst("Write-Output 'literal && text'");
assert.deepEqual(quotedChain.chainOperators, [], 'quoted operators are not command chains');
const nestedChain = await parseWindowsPowerShellAst('Write-Output (1 && 2)');
assert.deepEqual(nestedChain.chainOperators, [], 'nested operators are not top-level chains');
const where = spawnSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true });
const pwsh = process.env.AGENTOC_TEST_PWSH || (where.status === 0 ? where.stdout.split(/\r?\n/).find(Boolean) : '');
if (pwsh && existsSync(pwsh)) {
  const modern = await parseWindowsPowerShellAst('Get-Date; Get-Location', { executable: pwsh });
  assert.match(modern.psVersion, /^7\./);
  assert.deepEqual(modern.commands.map((x) => x.name), ['Get-Date', 'Get-Location']);
  const modernStatic = await parseWindowsPowerShellAst("[System.IO.File]::WriteAllText('文档.txt', 'hello')", { executable: pwsh });
  assert.deepEqual(modernStatic.dynamicNodes, []);
  assert.deepEqual(modernStatic.expressions[0].staticFileCall, { kind: 'write', path: '文档.txt', method: 'WriteAllText' });
  assert.deepEqual((await parseWindowsPowerShellAst("[System.IO.File]::ReadAllText('文档.txt', [System.Text.Encoding]::UTF8)", { executable: pwsh })).dynamicNodes, []);
  assert.ok((await parseWindowsPowerShellAst("[System.IO.File]::WriteAllText('a', $env:TEMP)", { executable: pwsh })).dynamicNodes.length);
}
await assert.rejects(parseWindowsPowerShellAst('x'.repeat(128 * 1024 + 1)));
// OS pipe reads may split a multibyte filename across data events.
const splitSpawn = () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => {};
  const payload = Buffer.from(JSON.stringify({ commands: [{ name: 'Get-Content', elements: [{ kind: 'literal', value: '中文.md' }] }], errors: [], dynamicNodes: [] }));
  const offset = payload.indexOf(Buffer.from('中')) + 1;
  queueMicrotask(() => { child.stdout.write(payload.subarray(0, offset)); child.stdout.write(payload.subarray(offset)); child.emit('close', 0); });
  return child;
};
const split = await parseWindowsPowerShellAst('Get-Content 中文.md', { spawnProcess: splitSpawn });
assert.equal(split.commands[0].elements[0].value, '中文.md');
console.log('windows-powershell-ast: real Windows PowerShell parser checks passed');
