import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { gzipSync } from 'node:zlib';
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
function Test-SafeWhereMember($node) {
  return $node -is [System.Management.Automation.Language.MemberExpressionAst] -and
    $node -isnot [System.Management.Automation.Language.InvokeMemberExpressionAst] -and -not $node.Static -and
    $node.Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
    $node.Expression.VariablePath.UserPath -iin @('_','PSItem') -and
    $node.Member -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
    [string]$node.Member.Value -match '^\w+$'
}
function Test-SafeWhereExpression($expr, $depth) {
  if ($null -eq $expr -or $depth -gt 12) { return $false }
  if (Test-SafeWhereMember $expr) { return $true }
  if ($expr -is [System.Management.Automation.Language.ParenExpressionAst]) {
    $pipeline = $expr.Pipeline
    if ($pipeline -isnot [System.Management.Automation.Language.PipelineAst] -or @($pipeline.PipelineElements).Count -ne 1) { return $false }
    $element = $pipeline.PipelineElements[0]
    if ($element -isnot [System.Management.Automation.Language.CommandExpressionAst] -or @($element.Redirections).Count -ne 0) { return $false }
    return Test-SafeWhereExpression $element.Expression ($depth + 1)
  }
  if ($expr -is [System.Management.Automation.Language.UnaryExpressionAst]) {
    if ([string]$expr.TokenKind -inotmatch '^(not|exclaim)$') { return $false }
    return Test-SafeWhereExpression $expr.Child ($depth + 1)
  }
  if ($expr -isnot [System.Management.Automation.Language.BinaryExpressionAst]) { return $false }
  if ([string]$expr.Operator -iin @('and','or')) {
    return (Test-SafeWhereExpression $expr.Left ($depth + 1)) -and (Test-SafeWhereExpression $expr.Right ($depth + 1))
  }
  if ([string]$expr.Operator -inotmatch '^(i|c)?(eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin)$') { return $false }
  $right = $expr.Right
  return (Test-SafeWhereMember $expr.Left) -and (
    $right -is [System.Management.Automation.Language.StringConstantExpressionAst] -or
    $right -is [System.Management.Automation.Language.ConstantExpressionAst] -or
    ($right -is [System.Management.Automation.Language.VariableExpressionAst] -and $right.VariablePath.UserPath -iin @('true','false','null')))
}
function Test-SafeWhereBlock($block) {
  if ($block -isnot [System.Management.Automation.Language.ScriptBlockExpressionAst] -or
      $block.Parent -isnot [System.Management.Automation.Language.CommandAst]) { return $false }
  $command = $block.Parent
  if ($command.GetCommandName() -inotmatch '^(where-object|where|\?)$' -or
      @($command.CommandElements).Count -ne 2 -or $command.CommandElements[1] -ne $block -or
      $command.Parent -isnot [System.Management.Automation.Language.PipelineAst] -or
      $command.Parent.PipelineElements[0] -eq $command) { return $false }
  $body = $block.ScriptBlock
  if ($null -ne $body.ParamBlock -or $null -ne $body.BeginBlock -or $null -ne $body.ProcessBlock -or
      $null -ne $body.DynamicParamBlock -or $null -eq $body.EndBlock -or
      @($body.EndBlock.Statements).Count -ne 1 -or @($body.EndBlock.Traps | Where-Object { $null -ne $_ }).Count -ne 0) { return $false }
  $pipeline = $body.EndBlock.Statements[0]
  if ($pipeline -isnot [System.Management.Automation.Language.PipelineAst] -or @($pipeline.PipelineElements).Count -ne 1) { return $false }
  $element = $pipeline.PipelineElements[0]
  if ($element -isnot [System.Management.Automation.Language.CommandExpressionAst] -or @($element.Redirections).Count -ne 0) { return $false }
  return Test-SafeWhereExpression $element.Expression 0
}
function Test-InSafeWhereBlock($node) {
  for ($item = $node; $null -ne $item; $item = $item.Parent) {
    if ($item -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) { return (Test-SafeWhereBlock $item) }
  }
  return $false
}
# Expansions are safe only in direct output expressions or Write-Output,
# and only for non-secret context values supplied to the agent process.
function Test-SafeContextExpansion($node) {
  if ($node -isnot [System.Management.Automation.Language.ExpandableStringExpressionAst] -or
      @($node.NestedExpressions).Count -eq 0) { return $false }
  $outputExpression = $node.Parent -is [System.Management.Automation.Language.CommandExpressionAst] -and $node.Parent.Expression -eq $node
  $outputCommand = $node.Parent -is [System.Management.Automation.Language.CommandAst] -and
      $node.Parent.GetCommandName() -iin @('Write-Output','echo','write')
  if (-not $outputExpression -and -not $outputCommand) { return $false }
  foreach ($part in @($node.NestedExpressions)) {
    if ($part -isnot [System.Management.Automation.Language.VariableExpressionAst] -or $part.Splatted -or
        [string]$part.VariablePath.UserPath -inotmatch '^env:(?:AGENTOC|RAGENT)_(?:CHAT_BASE_URL|PROJECT_ROOT|SESSION_ID)$') { return $false }
  }
  return $true
}
function Test-InSafeContextExpansion($node) {
  return $node -is [System.Management.Automation.Language.VariableExpressionAst] -and (Test-SafeContextExpansion $node.Parent)
}
# Resolve leading literal path assignments only. No variable is executed or
# expanded here; later file policy still checks every substituted target.
$boundPaths = @{}
$boundAssignmentOffsets = @{}
$reservedVariables = @('args','consolefilename','enabledexperimentalfeatures','error','errorview','event','executioncontext','false','foreach','formatenumerationlimit','home','host','input','iscoreclr','islinux','ismacos','iswindows','lastexitcode','matches','maximumaliascount','maximumdrivecount','maximumerrorcount','maximumfunctioncount','maximumhistorycount','maximumvariablecount','myinvocation','nestedpromptlevel','null','ofs','outputencoding','pid','profile','pwd','sender','shellid','stacktrace','switch','this','true','logcommandhealthevent','logcommandlifecycleevent','logenginehealthevent','logenginelifecycleevent','logproviderhealthevent','logproviderlifecycleevent')
function Test-UnsafeScriptRequirements($root) {
  $requirements = $root.ScriptRequirements
  if ($null -eq $requirements) { return $false }
  if ($requirements.IsElevationRequired) { return $true }
  foreach ($name in @('RequiredModules','RequiredAssemblies','RequiresPSSnapIns')) {
    $property = $requirements.PSObject.Properties[$name]
    if ($null -ne $property -and $null -ne $property.Value -and @($property.Value).Count -gt 0) { return $true }
  }
  return $false
}
# Recognize a complete, bounded HEAD/GET probe with status-only output.
# The inspected AST is never executed by this parser.
function Get-OnlyOutputExpression($statement) {
  if ($statement -isnot [System.Management.Automation.Language.PipelineAst] -or @($statement.PipelineElements).Count -ne 1) { return $null }
  $element = $statement.PipelineElements[0]
  if ($element -isnot [System.Management.Automation.Language.CommandExpressionAst] -or @($element.Redirections).Count -ne 0) { return $null }
  return $element.Expression
}
function Test-WebProbeMember($expr, [string]$variable, [bool]$isCatch) {
  if ($expr -isnot [System.Management.Automation.Language.MemberExpressionAst] -or
      $expr -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -or $expr.Static -or
      $expr.Member -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) { return $false }
  if ($isCatch) {
    if ([string]$expr.Member.Value -ine 'Message') { return $false }
    $inner = $expr.Expression
    return $inner -is [System.Management.Automation.Language.MemberExpressionAst] -and
      $inner -isnot [System.Management.Automation.Language.InvokeMemberExpressionAst] -and -not $inner.Static -and
      $inner.Member -is [System.Management.Automation.Language.StringConstantExpressionAst] -and [string]$inner.Member.Value -ieq 'Exception' -and
      $inner.Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and -not $inner.Expression.Splatted -and
      [string]$inner.Expression.VariablePath.UserPath -iin @('_','PSItem')
  }
  return [string]$expr.Member.Value -iin @('StatusCode','StatusDescription') -and
    $expr.Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and -not $expr.Expression.Splatted -and
    [string]$expr.Expression.VariablePath.UserPath -ieq $variable
}
function Test-WebProbeOutput($statement, [string]$variable, [bool]$isCatch) {
  $expr = Get-OnlyOutputExpression $statement
  if ($null -eq $expr) { return $false }
  if ($expr -is [System.Management.Automation.Language.StringConstantExpressionAst]) { return $true }
  if ($expr -is [System.Management.Automation.Language.MemberExpressionAst]) { return (Test-WebProbeMember $expr $variable $isCatch) }
  if ($expr -isnot [System.Management.Automation.Language.ExpandableStringExpressionAst]) { return $false }
  foreach ($part in @($expr.NestedExpressions)) {
    if ($part -isnot [System.Management.Automation.Language.SubExpressionAst] -or
        @($part.SubExpression.Statements).Count -ne 1) { return $false }
    $value = Get-OnlyOutputExpression $part.SubExpression.Statements[0]
    if (-not (Test-WebProbeMember $value $variable $isCatch)) { return $false }
  }
  return $true
}
function Get-SafeWebProbe($root) {
  if ($null -ne $root.ParamBlock -or $null -ne $root.BeginBlock -or $null -ne $root.ProcessBlock -or
      $null -ne $root.DynamicParamBlock -or $null -ne $root.CleanBlock -or (Test-UnsafeScriptRequirements $root) -or
      ($null -ne $root.UsingStatements -and @($root.UsingStatements).Count -ne 0) -or
      ($null -ne $root.Attributes -and @($root.Attributes).Count -ne 0) -or $null -eq $root.EndBlock -or @($root.EndBlock.Statements).Count -ne 1 -or ($null -ne $root.EndBlock.Traps -and @($root.EndBlock.Traps).Count -ne 0)) { return $null }
  $probe = $root.EndBlock.Statements[0]
  if ($probe -isnot [System.Management.Automation.Language.TryStatementAst] -or $null -ne $probe.Finally -or
      @($probe.CatchClauses).Count -ne 1 -or @($probe.CatchClauses[0].CatchTypes).Count -ne 0 -or
      @($probe.Body.Statements).Count -ne 2 -or ($null -ne $probe.Body.Traps -and @($probe.Body.Traps).Count -ne 0) -or
      @($probe.CatchClauses[0].Body.Statements).Count -ne 1 -or ($null -ne $probe.CatchClauses[0].Body.Traps -and @($probe.CatchClauses[0].Body.Traps).Count -ne 0)) { return $null }
  $assign = $probe.Body.Statements[0]
  if ($assign -isnot [System.Management.Automation.Language.AssignmentStatementAst] -or $assign.Operator.ToString() -ne 'Equals' -or
      $assign.Left -isnot [System.Management.Automation.Language.VariableExpressionAst] -or $assign.Left.Splatted -or
      $assign.Right -isnot [System.Management.Automation.Language.PipelineAst] -or @($assign.Right.PipelineElements).Count -ne 1) { return $null }
  $variable = [string]$assign.Left.VariablePath.UserPath
  if ($variable -notmatch '^[a-z_][a-z0-9_]*$' -or $variable -iin $reservedVariables -or
      $variable -imatch '^ps' -or $variable -imatch 'preference$') { return $null }
  $command = $assign.Right.PipelineElements[0]
  if ($command -isnot [System.Management.Automation.Language.CommandAst] -or $command.GetCommandName() -ine 'Invoke-WebRequest' -or
      $command.InvocationOperator.ToString() -ne 'Unknown' -or @($command.Redirections).Count -ne 0) { return $null }
  $elements = @($command.CommandElements); $options = @{}
  for ($i = 1; $i -lt $elements.Count; $i++) {
    $option = $elements[$i]
    if ($option -isnot [System.Management.Automation.Language.CommandParameterAst]) { return $null }
    $key = ([string]$option.ParameterName).ToLowerInvariant()
    if ($key -notin @('uri','method','usebasicparsing','timeoutsec','erroraction') -or $options.ContainsKey($key)) { return $null }
    if ($key -eq 'usebasicparsing') { if ($null -ne $option.Argument) { return $null }; $options[$key] = $true; continue }
    $value = $option.Argument
    if ($null -eq $value) { $i++; if ($i -ge $elements.Count) { return $null }; $value = $elements[$i] }
    if ($value -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -and
        $value -isnot [System.Management.Automation.Language.ConstantExpressionAst]) { return $null }
    $options[$key] = [string]$value.Value
  }
  if (-not $options.ContainsKey('uri') -or -not $options.ContainsKey('method') -or -not $options.ContainsKey('usebasicparsing') -or
      $options['method'] -inotmatch '^(GET|HEAD)$' -or
      ($options.ContainsKey('erroraction') -and $options['erroraction'] -inotmatch '^(Stop|Continue|SilentlyContinue)$') -or
      ($options.ContainsKey('timeoutsec') -and ($options['timeoutsec'] -notmatch '^\d{1,3}$' -or [int]$options['timeoutsec'] -lt 1 -or [int]$options['timeoutsec'] -gt 120))) { return $null }
  $uri = $null
  if (-not [uri]::TryCreate($options['uri'], [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http','https') -or
      -not $uri.Host -or $uri.UserInfo) { return $null }
  if (-not (Test-WebProbeOutput $probe.Body.Statements[1] $variable $false) -or
      -not (Test-WebProbeOutput $probe.CatchClauses[0].Body.Statements[0] $variable $true)) { return $null }
  return @{ url = [string]$uri.AbsoluteUri; method = ([string]$options['method']).ToUpperInvariant() }
}
function Get-LiteralPathText($node, [int]$depth) {
  if ($null -eq $node -or $depth -gt 8) { return $null }
  if ($node -is [System.Management.Automation.Language.StringConstantExpressionAst]) { return [string]$node.Value }
  if ($node -is [System.Management.Automation.Language.BinaryExpressionAst] -and $node.Operator.ToString() -eq 'Plus') {
    $leftText = Get-LiteralPathText $node.Left ($depth + 1)
    $rightText = Get-LiteralPathText $node.Right ($depth + 1)
    if ($null -eq $leftText -or $null -eq $rightText) { return $null }
    return [string]::Concat($leftText, $rightText)
  }
  if ($node -is [System.Management.Automation.Language.ParenExpressionAst] -and
      $node.Pipeline -is [System.Management.Automation.Language.PipelineAst] -and
      @($node.Pipeline.PipelineElements).Count -eq 1) {
    $element = $node.Pipeline.PipelineElements[0]
    if ($element -is [System.Management.Automation.Language.CommandExpressionAst] -and @($element.Redirections).Count -eq 0) {
      return Get-LiteralPathText $element.Expression ($depth + 1)
    }
  }
  return $null
}
foreach ($statement in @($ast.EndBlock.Statements)) {
  if ($statement -isnot [System.Management.Automation.Language.AssignmentStatementAst]) { break }
  $left = $statement.Left; $right = $statement.Right
  if ($statement.Operator.ToString() -ne 'Equals' -or $left -isnot [System.Management.Automation.Language.VariableExpressionAst] -or
      $left.Splatted -or $right -isnot [System.Management.Automation.Language.CommandExpressionAst] -or
      @($right.Redirections).Count -ne 0) { break }
  $name = [string]$left.VariablePath.UserPath; $value = Get-LiteralPathText $right.Expression 0
  if ($null -eq $value -or $value.Length -gt 32767) { break }
  if ($name -notmatch '^[a-z_][a-z0-9_]*$' -or $name -iin $reservedVariables -or $name -imatch '^ps' -or
      $name -imatch 'preference$' -or $value -notmatch '^[a-zA-Z]:[\\/]' -or
      $value.Substring(2).Contains(':') -or $value.Contains([char]0) -or $boundPaths.ContainsKey($name) -or $boundPaths.Count -ge 8) { break }
  $boundPaths[$name] = $value
  $boundAssignmentOffsets[[int]$statement.Extent.StartOffset] = $true
}
function Test-BoundPathVariable($node) {
  if ($node -isnot [System.Management.Automation.Language.VariableExpressionAst] -or $node.Splatted -or
      -not $boundPaths.ContainsKey([string]$node.VariablePath.UserPath)) { return $false }
  if ($node.Parent -is [System.Management.Automation.Language.AssignmentStatementAst]) {
    return $node.Parent.Left -eq $node -and $boundAssignmentOffsets.ContainsKey([int]$node.Parent.Extent.StartOffset)
  }
  if ($node.Parent -is [System.Management.Automation.Language.CommandAst]) {
    return $node.Parent.CommandElements[0] -ne $node
  }
  return $node.Parent -is [System.Management.Automation.Language.CommandParameterAst] -and
    $node.Parent.Argument -eq $node -and $node.Parent.Parent -is [System.Management.Automation.Language.CommandAst]
}
function Test-InBoundAssignment($node) {
  for ($parent = $node.Parent; $null -ne $parent; $parent = $parent.Parent) {
    if ($parent -is [System.Management.Automation.Language.AssignmentStatementAst]) {
      return $boundAssignmentOffsets.ContainsKey([int]$parent.Extent.StartOffset)
    }
  }
  return $false
}
$commands = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object {
  $command = $_
  $elements = @($command.CommandElements | ForEach-Object {
    if ($_ -is [System.Management.Automation.Language.CommandParameterAst]) {
      $value = $null; $argumentType = $null
      if ($null -ne $_.Argument) { $value = $_.Argument.Value; $argumentType = $_.Argument.GetType().Name }
      if (Test-ConfirmFalseArgument $_.Argument) { $value = 'false'; $argumentType = 'StaticConfirmFalse' }
      if (Test-BoundPathVariable $_.Argument) { $value = $boundPaths[[string]$_.Argument.VariablePath.UserPath]; $argumentType = 'StringConstantExpressionAst' }
      @{ kind = 'parameter'; name = $_.ParameterName; value = $value; argumentType = $argumentType }
    } elseif (Test-BoundPathVariable $_) {
      @{ kind = 'literal'; value = $boundPaths[[string]$_.VariablePath.UserPath] }
    } elseif ($_ -is [System.Management.Automation.Language.StringConstantExpressionAst] -or $_ -is [System.Management.Automation.Language.ConstantExpressionAst]) {
      @{ kind = 'literal'; value = [string]$_.Value }
    } elseif ($_ -is [System.Management.Automation.Language.ArrayLiteralAst] -and
        @($_.Elements).Count -gt 0 -and @($_.Elements | Where-Object {
          $_ -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -and
          $_ -isnot [System.Management.Automation.Language.ConstantExpressionAst]
        }).Count -eq 0) {
      @{ kind = 'literal_list'; values = @($_.Elements | ForEach-Object { [string]$_.Value }) }
    } elseif (Test-SafeContextExpansion $_) {
      @{ kind = 'literal'; value = 'safe-context-output' }
    } elseif (Test-SafeWhereBlock $_) {
      @{ kind = 'safe_where_predicate' }
    } else {
      @{ kind = 'dynamic'; node = $_.GetType().Name }
    }
  })
  $redirectFacts = @(Get-RedirectionFacts $command)
  $hasPipelineInput = $command.Parent -is [System.Management.Automation.Language.PipelineAst] -and $command.Parent.PipelineElements[0] -ne $command
  @{ name = $command.GetCommandName(); elements = $elements; invocation = [string]$command.InvocationOperator; redirections = @($command.Redirections).Count; redirectFacts = $redirectFacts; pipelineInput = $hasPipelineInput }
})
$expressions = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandExpressionAst] -and -not (Test-InSafeWhereBlock $n) -and -not (Test-InBoundAssignment $n) }, $true) | ForEach-Object {
  @{ expressionType = $_.Expression.GetType().Name; safeContextExpansion = (Test-SafeContextExpansion $_.Expression); safeLogicalNegation = ($_.Expression -is [System.Management.Automation.Language.UnaryExpressionAst] -and $_.Expression.TokenKind -in @('Not','Exclaim') -and $_.Expression.Child -is [System.Management.Automation.Language.ParenExpressionAst]); staticFileCall = (Get-SafeStaticFileCall $_.Expression); redirections = @($_.Redirections).Count; redirectFacts = @(Get-RedirectionFacts $_) }
})
$dynamicNodes = @($ast.FindAll({ param($n)
  -not (Test-InSafeWhereBlock $n) -and (
  (($n -is [System.Management.Automation.Language.VariableExpressionAst]) -and -not (Test-ConfirmFalseArgument $n) -and -not (Test-NullRedirection $n) -and -not (Test-BoundPathVariable $n) -and -not (Test-InSafeContextExpansion $n)) -or
  ($n -is [System.Management.Automation.Language.SubExpressionAst]) -or
  ($n -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) -or
  (($n -is [System.Management.Automation.Language.AssignmentStatementAst]) -and -not $boundAssignmentOffsets.ContainsKey([int]$n.Extent.StartOffset)) -or
  (($n -is [System.Management.Automation.Language.InvokeMemberExpressionAst]) -and $null -eq (Get-SafeStaticFileCall $n)) -or
  (($n -is [System.Management.Automation.Language.TypeExpressionAst]) -and $null -eq (Get-SafeStaticFileCall $n.Parent) -and
    -not ((Get-SafeStaticEncoding $n.Parent) -and $null -ne (Get-SafeStaticFileCall $n.Parent.Parent))) -or
  (($n.GetType().Name -eq 'MemberExpressionAst') -and
    -not ((Get-SafeStaticEncoding $n) -and $null -ne (Get-SafeStaticFileCall $n.Parent))) -or
  ($n.GetType().Name -in @('FunctionDefinitionAst','TypeDefinitionAst','IfStatementAst','ForStatementAst','ForEachStatementAst','WhileStatementAst','DoWhileStatementAst','DoUntilStatementAst','TryStatementAst','TrapStatementAst','UsingStatementAst','ExitStatementAst','ThrowStatementAst','DataStatementAst')) -or
  ($n -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -and @($n.NestedExpressions).Count -gt 0 -and -not (Test-SafeContextExpansion $n)))
}, $true) | ForEach-Object { $_.GetType().Name })
$errorMessages = @($errors | ForEach-Object { $_.Message })
@{ commands = $commands; expressions = $expressions; dynamicNodes = $dynamicNodes; errors = $errorMessages; unsafeRequirements = (Test-UnsafeScriptRequirements $ast); safeWebProbe = (Get-SafeWebProbe $ast); chainOperators = $chainOperators; assignmentCount = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)).Count; psVersion = $PSVersionTable.PSVersion.ToString() } | ConvertTo-Json -Depth 12 -Compress
`;

export const WINDOWS_POWERSHELL_AST_VERSION = 'powershell-native-ast/v1';

// Keep the fixed parser below Windows' process command-line limit as its AST
// checks grow. Only this trusted source is compressed; user commands remain
// JSON data on stdin and are passed to ParseInput, never to ScriptBlock.
const PARSER_COMPRESSED = gzipSync(Buffer.from(PARSER_SCRIPT, 'utf8')).toString('base64');
const PARSER_BOOTSTRAP = `$m=New-Object IO.MemoryStream(,[Convert]::FromBase64String('${PARSER_COMPRESSED}'));$g=New-Object IO.Compression.GzipStream($m,[IO.Compression.CompressionMode]::Decompress);$r=New-Object IO.StreamReader($g,[Text.Encoding]::UTF8);& ([scriptblock]::Create($r.ReadToEnd()))`;

// Use the Windows filesystem provider's own wildcard rules. The pattern is
// data on stdin, never interpolated into the fixed PowerShell program.
const GLOB_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
$request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$items = @(Get-ChildItem -Path ([string]$request.pattern) -File -ErrorAction Stop | Select-Object -First 10001 | ForEach-Object { $_.FullName })
@{ paths = $items } | ConvertTo-Json -Compress
`;

export function expandWindowsPowerShellGlob(pattern, { executable, timeoutMs = 5000, spawnProcess = spawn } = {}) {
  if (typeof pattern !== 'string' || !path.win32.isAbsolute(pattern) || Buffer.byteLength(pattern, 'utf8') > 32768) {
    return Promise.reject(new Error('Invalid wildcard path'));
  }
  const shell = executable || resolveWindowsSystemPaths()?.powershell;
  if (!shell || !path.win32.isAbsolute(shell)) return Promise.reject(new Error('Windows system PowerShell is unavailable'));
  const encoded = Buffer.from(GLOB_SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    let finished = false; let stdout = ''; const decoder = new StringDecoder('utf8');
    const child = spawnProcess(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = (error, result) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Wildcard expansion timed out')); }, timeoutMs);
    child.on('error', finish);
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => { stdout += decoder.write(chunk); if (stdout.length > 4 * 1024 * 1024) { child.kill(); finish(new Error('Wildcard expansion output exceeded limit')); } });
    child.on('close', code => {
      stdout += decoder.end();
      if (code !== 0) return finish(new Error('Wildcard expansion failed'));
      try {
        const result = JSON.parse(stdout.replace(/^\uFEFF/, ''));
        if (!Array.isArray(result.paths) || result.paths.length > 10000 || result.paths.some(value => typeof value !== 'string' || !path.win32.isAbsolute(value))) throw new Error('Invalid wildcard expansion result');
        finish(null, result.paths);
      } catch (error) { finish(error); }
    });
    child.stdin.on('error', finish);
    child.stdin.end(JSON.stringify({ pattern }));
  });
}

export function parseWindowsPowerShellAst(command, { executable, timeoutMs = 5000, spawnProcess = spawn } = {}) {
  if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command, 'utf8') > 128 * 1024) {
    return Promise.reject(new Error('PowerShell command is empty or exceeds the parser limit'));
  }
  const shell = executable || resolveWindowsSystemPaths()?.powershell;
  if (!shell || !path.win32.isAbsolute(shell)) return Promise.reject(new Error('Windows system PowerShell is unavailable'));
  const encoded = Buffer.from(PARSER_BOOTSTRAP, 'utf16le').toString('base64');
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
