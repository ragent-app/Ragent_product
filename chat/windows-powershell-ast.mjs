import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { resolveWindowsSystemPaths } from './windows-system-paths.mjs';

// Fixed parser program: the provider's command travels only on stdin as JSON.
// ParseInput builds an AST; it does not execute or evaluate that command.
const PARSER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
$raw = [Console]::In.ReadToEnd()
$request = ConvertFrom-Json -InputObject $raw
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput([string]$request.command, [ref]$tokens, [ref]$errors)
$chainOperators = @(); $delimiterDepth = 0
foreach ($token in $tokens) {
  $kind = $token.Kind.ToString()
  if ($kind -in @('RParen','RCurly','RBracket')) { $delimiterDepth = [Math]::Max(0, $delimiterDepth - 1) }
  if ($delimiterDepth -eq 0 -and $kind -in @('AndAnd','OrOr')) {
    $chainOperators += @{ operator = $kind; start = $token.Extent.StartOffset; end = $token.Extent.EndOffset }
  }
  if ($kind -in @('LParen','LCurly','LBracket','AtParen','AtCurly')) { $delimiterDepth++ }
}
function Test-NullRedirection($node) {
  return $node -is [System.Management.Automation.Language.VariableExpressionAst] -and
    $node.VariablePath.UserPath -ieq 'null' -and
    $node.Parent -is [System.Management.Automation.Language.FileRedirectionAst] -and $node.Parent.Location -eq $node
}
function Get-RedirectionFacts($node) {
  @($node.Redirections | ForEach-Object {
    $location = $null; $locationType = $null
    if ($_ -is [System.Management.Automation.Language.FileRedirectionAst] -and $null -ne $_.Location) {
      $locationType = $_.Location.GetType().Name
      if (Test-NullRedirection $_.Location) { $locationType = 'StaticNull' }
      elseif ($_.Location -is [System.Management.Automation.Language.StringConstantExpressionAst] -or $_.Location -is [System.Management.Automation.Language.ConstantExpressionAst]) { $location = [string]$_.Location.Value }
    }
    @{ type = $_.GetType().Name; location = $location; locationType = $locationType }
  })
}
function Get-SafeStaticEncoding($node) {
  if ($node -isnot [System.Management.Automation.Language.MemberExpressionAst] -or
      $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -or -not $node.Static -or
      $node.Expression -isnot [System.Management.Automation.Language.TypeExpressionAst] -or
      $node.Expression.TypeName.FullName -ine 'System.Text.Encoding' -or
      $node.Member -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) { return $false }
  return [string]$node.Member.Value -iin @('UTF8', 'Unicode', 'BigEndianUnicode', 'UTF32', 'ASCII', 'Default')
}
function Get-SafeStaticFileCall($node) {
  if ($node -isnot [System.Management.Automation.Language.InvokeMemberExpressionAst] -or
      -not $node.Static -or
      $node.Parent -isnot [System.Management.Automation.Language.CommandExpressionAst] -or
      $node.Expression -isnot [System.Management.Automation.Language.TypeExpressionAst] -or
      $node.Expression.TypeName.FullName -ine 'System.IO.File' -or
      $node.Member -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) { return $null }
  $method = [string]$node.Member.Value
  $kind = switch ($method.ToLowerInvariant()) {
    'readalltext' { 'read' }
    'writealltext' { 'write' }
    'appendalltext' { 'write' }
    'delete' { 'delete' }
    default { return $null }
  }
  $count = if ($kind -eq 'write') { 2 } else { 1 }
  $argumentCount = @($node.Arguments).Count
  if ($argumentCount -ne $count -and
      -not ($kind -ne 'delete' -and $argumentCount -eq ($count + 1) -and (Get-SafeStaticEncoding $node.Arguments[$count]))) { return $null }
  for ($index = 0; $index -lt $count; $index++) {
    if ($node.Arguments[$index] -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) { return $null }
  }
  return @{ kind = $kind; path = [string]$node.Arguments[0].Value; method = $method }
}
function Test-ConfirmFalseArgument($node) {
  return $node -is [System.Management.Automation.Language.VariableExpressionAst] -and
    $node.VariablePath.UserPath -ieq 'false' -and
    $node.Parent -is [System.Management.Automation.Language.CommandParameterAst] -and
    $node.Parent.ParameterName -ieq 'Confirm' -and $node.Parent.Argument -eq $node
}
$commands = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object {
  $command = $_
  $elements = @($command.CommandElements | ForEach-Object {
    if ($_ -is [System.Management.Automation.Language.CommandParameterAst]) {
      $value = $null; $argumentType = $null
      if ($null -ne $_.Argument) { $value = $_.Argument.Value; $argumentType = $_.Argument.GetType().Name }
      if (Test-ConfirmFalseArgument $_.Argument) { $value = 'false'; $argumentType = 'StaticConfirmFalse' }
      @{ kind = 'parameter'; name = $_.ParameterName; value = $value; argumentType = $argumentType }
    } elseif ($_ -is [System.Management.Automation.Language.StringConstantExpressionAst] -or $_ -is [System.Management.Automation.Language.ConstantExpressionAst]) {
      @{ kind = 'literal'; value = [string]$_.Value }
    } elseif ($_ -is [System.Management.Automation.Language.ArrayLiteralAst] -and
        @($_.Elements).Count -gt 0 -and @($_.Elements | Where-Object {
          $_ -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -and
          $_ -isnot [System.Management.Automation.Language.ConstantExpressionAst]
        }).Count -eq 0) {
      @{ kind = 'literal_list'; values = @($_.Elements | ForEach-Object { [string]$_.Value }) }
    } else {
      @{ kind = 'dynamic'; node = $_.GetType().Name }
    }
  })
  $redirectFacts = @(Get-RedirectionFacts $command)
  $hasPipelineInput = $command.Parent -is [System.Management.Automation.Language.PipelineAst] -and $command.Parent.PipelineElements[0] -ne $command
  @{ name = $command.GetCommandName(); elements = $elements; invocation = [string]$command.InvocationOperator; redirections = @($command.Redirections).Count; redirectFacts = $redirectFacts; pipelineInput = $hasPipelineInput }
})
$expressions = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandExpressionAst] }, $true) | ForEach-Object {
  @{ expressionType = $_.Expression.GetType().Name; staticFileCall = (Get-SafeStaticFileCall $_.Expression); redirections = @($_.Redirections).Count; redirectFacts = @(Get-RedirectionFacts $_) }
})
$dynamicNodes = @($ast.FindAll({ param($n)
  (($n -is [System.Management.Automation.Language.VariableExpressionAst]) -and -not (Test-ConfirmFalseArgument $n) -and -not (Test-NullRedirection $n)) -or
  ($n -is [System.Management.Automation.Language.SubExpressionAst]) -or
  ($n -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) -or
  ($n -is [System.Management.Automation.Language.AssignmentStatementAst]) -or
  (($n -is [System.Management.Automation.Language.InvokeMemberExpressionAst]) -and $null -eq (Get-SafeStaticFileCall $n)) -or
  (($n -is [System.Management.Automation.Language.TypeExpressionAst]) -and $null -eq (Get-SafeStaticFileCall $n.Parent) -and
    -not ((Get-SafeStaticEncoding $n.Parent) -and $null -ne (Get-SafeStaticFileCall $n.Parent.Parent))) -or
  (($n.GetType().Name -eq 'MemberExpressionAst') -and
    -not ((Get-SafeStaticEncoding $n) -and $null -ne (Get-SafeStaticFileCall $n.Parent))) -or
  ($n.GetType().Name -in @('FunctionDefinitionAst','TypeDefinitionAst','IfStatementAst','ForStatementAst','ForEachStatementAst','WhileStatementAst','DoWhileStatementAst','DoUntilStatementAst','TryStatementAst','TrapStatementAst','UsingStatementAst','ExitStatementAst','ThrowStatementAst','DataStatementAst')) -or
  ($n -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -and @($n.NestedExpressions).Count -gt 0)
}, $true) | ForEach-Object { $_.GetType().Name })
$errorMessages = @($errors | ForEach-Object { $_.Message })
@{ commands = $commands; expressions = $expressions; dynamicNodes = $dynamicNodes; errors = $errorMessages; chainOperators = $chainOperators; psVersion = $PSVersionTable.PSVersion.ToString() } | ConvertTo-Json -Depth 12 -Compress
`;

export const WINDOWS_POWERSHELL_AST_VERSION = 'powershell-native-ast/v1';

export function parseWindowsPowerShellAst(command, { executable, timeoutMs = 5000, spawnProcess = spawn } = {}) {
  if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command, 'utf8') > 128 * 1024) {
    return Promise.reject(new Error('PowerShell command is empty or exceeds the parser limit'));
  }
  const shell = executable || resolveWindowsSystemPaths()?.powershell;
  if (!shell || !path.win32.isAbsolute(shell)) return Promise.reject(new Error('Windows system PowerShell is unavailable'));
  const encoded = Buffer.from(PARSER_SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    let finished = false; let stdout = ''; let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const child = spawnProcess(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('PowerShell parser timed out')); }, timeoutMs);
    child.on('error', (error) => finish(error));
    child.stdout.on('data', (chunk) => {
      stdout += stdoutDecoder.write(chunk);
      if (stdout.length > 1024 * 1024) { child.kill(); finish(new Error('PowerShell parser output exceeded limit')); }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + stderrDecoder.write(chunk)).slice(-4096); });
    child.on('close', (code) => {
      stdout += stdoutDecoder.end();
      stderr = (stderr + stderrDecoder.end()).slice(-4096);
      if (code !== 0) return finish(new Error(`PowerShell parser failed (${code}): ${stderr}`));
      try {
        const result = JSON.parse(stdout.replace(/^\uFEFF/, ''));
        if (!Array.isArray(result.commands) || !Array.isArray(result.errors) || !Array.isArray(result.dynamicNodes)) throw new Error('Invalid PowerShell parser response');
        if (result.chainOperators !== undefined && (!Array.isArray(result.chainOperators) || result.chainOperators.some((item) =>
          !item || !['AndAnd', 'OrOr'].includes(item.operator) || !Number.isInteger(item.start) || !Number.isInteger(item.end)
          || item.start < 0 || item.end <= item.start || item.end > command.length))) throw new Error('Invalid PowerShell chain operator response');
        finish(null, { ...result, parserVersion: WINDOWS_POWERSHELL_AST_VERSION });
      } catch (error) { finish(error); }
    });
    child.stdin.on('error', (error) => finish(error));
    child.stdin.end(JSON.stringify({ command }));
  });
}
