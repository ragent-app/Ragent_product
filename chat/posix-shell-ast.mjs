// POSIX shell structure from the pinned mvdan/sh WASM parser. Parsing never executes input.
import { isReadOnlyStdinFilter, parseLiteralBashWords } from './windows-bash-actions.mjs';
import { isRecognizedDeveloperTask, readOnlyRipgrepArgs } from './windows-powershell-actions.mjs';
import { isRecognizedRiskProgram } from './risk-classifier.mjs';

let parserPromise;
function parser() {
  parserPromise ||= import('sh-syntax');
  return parserPromise;
}

export async function assessPosixShellSyntax(command) {
  if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command, 'utf8') > 128 * 1024) {
    return { complete: false, reasonCode: 'shell_input_invalid', commands: [] };
  }
  try {
    const { parse, walk, LangVariant, BinCmdOperator } = await parser();
    const tree = await parse(command, { variant: LangVariant.LangBash });
    const bytes = Buffer.from(command, 'utf8');
    const commands = []; const pipes = []; const nodeTypes = new Set(); let unknown = false; let nodes = 0;
    const allowed = new Set(['File', 'Stmt', 'BinaryCmd', 'CallExpr', 'Word', 'Lit', 'SglQuoted', 'DblQuoted', 'Comment']);
    walk(tree, node => {
      nodeTypes.add(node.type);
      if (++nodes > 10000 || !allowed.has(node.type)) { unknown = true; return false; }
      if ((node.type === 'SglQuoted' || node.type === 'DblQuoted') && node.dollar) unknown = true;
      if (node.type === 'Lit' && /[*?\[\]{}]/.test(node.value || '')) unknown = true;
      if (node.type === 'Stmt' && (node.background || node.coprocess || node.disown || node.redirs?.length)) unknown = true;
      if (node.type === 'BinaryCmd') {
        if (node.op === BinCmdOperator.Pipe && node.x?.cmd?.type === 'CallExpr' && node.y?.cmd?.type === 'CallExpr') {
          pipes.push([node.x.cmd, node.y.cmd]);
        } else if (![BinCmdOperator.AndStmt, BinCmdOperator.OrStmt].includes(node.op)) unknown = true;
      }
      if (node.type === 'CallExpr') {
        if (node.assigns?.length || !node.args?.length || !Number.isSafeInteger(node.start) || !Number.isSafeInteger(node.end)
            || node.start < 0 || node.end <= node.start || node.end > bytes.length) { unknown = true; return; }
        const text = bytes.subarray(node.start, node.end).toString('utf8');
        if (Buffer.byteLength(text, 'utf8') !== node.end - node.start) { unknown = true; return; }
        commands.push(text);
      }
    });
    const sourceText = node => Number.isSafeInteger(node?.start) && Number.isSafeInteger(node?.end)
      && node.start >= 0 && node.end > node.start && node.end <= bytes.length
      ? bytes.subarray(node.start, node.end).toString('utf8') : '';
    for (const [left, right] of pipes) {
      const leftText = sourceText(left), rightText = sourceText(right);
      const words = parseLiteralBashWords(leftText);
      const ripgrep = words?.[0] === 'rg' ? readOnlyRipgrepArgs(words.slice(1)) : null;
      // The consumer is a known stdin-only filter; classify the search itself
      // through the same existing risk gate used for standalone commands.
      if (!ripgrep || !isReadOnlyStdinFilter(rightText)) unknown = true;
    }
    if (unknown || !commands.length || commands.length > 128) return { complete: false, reasonCode: 'shell_syntax_dynamic_or_unsupported', commands: [], nodeTypes: [...nodeTypes].sort(), commandCount: commands.length };
    const classifiedLiterals = commands.map(text => {
      const words = parseLiteralBashWords(text);
      if (!words?.length || /[\\/]/.test(words[0])) return false;
      if (['echo', 'pwd', 'true', 'false', ':'].includes(words[0])) return true;
      if (isReadOnlyStdinFilter(text)) return true;
      if (words[0] === 'rg') return Boolean(readOnlyRipgrepArgs(words.slice(1)));
      const developerTask = isRecognizedDeveloperTask(words[0], words.slice(1));
      if (['npm','pnpm','yarn','bun','npx','go','cargo','dotnet','gradle','mvn'].includes(words[0])) return developerTask;
      return isRecognizedRiskProgram(words[0]) || developerTask;
    });
    return { complete: true, reasonCode: 'shell_syntax_literal', commands, classifiedLiterals,
      nodeTypes: [...nodeTypes].sort(), commandCount: commands.length };
  } catch {
    // A missing package, invalid syntax, or failed runtime cannot authorize work.
    return { complete: false, reasonCode: 'shell_parser_unavailable_or_invalid', commands: [] };
  }
}
