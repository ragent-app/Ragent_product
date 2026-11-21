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
    const { parse, walk, LangVariant, BinCmdOperator, RedirOperator } = await parser();
    const tree = await parse(command, { variant: LangVariant.LangBash });
    const bytes = Buffer.from(command, 'utf8');
    // Separate manual-review proof. Wildcards here never contribute to the
    // automatic path-effect proof and remain anchored absolute ls operands.
    let metadataNodes = 0; let metadataSourceCount = 0; let metadataCommandCount = 0;
    const metadataWord = word => {
      if (word?.type !== 'Word' || !Array.isArray(word.parts) || !word.parts.length) return null;
      let result = '';
      for (const part of word.parts) {
        if (part.type === 'Lit' || (part.type === 'SglQuoted' && !part.dollar)) result += part.value;
        else if (part.type === 'DblQuoted' && !part.dollar && part.parts.every(item => item.type === 'Lit')) result += part.parts.map(item => item.value).join('');
        else return null;
      }
      return result.includes('\\') ? null : result;
    };
    const metadataStmt = (stmt, pipePosition = 'none') => {
      if (++metadataNodes > 10000 || stmt?.type !== 'Stmt' || stmt.background || stmt.coprocess || stmt.disown || stmt.negated) return false;
      if ((stmt.redirs || []).some(redir => redir.op !== RedirOperator.RdrOut || redir.n?.value !== '2'
          || redir.hdoc || metadataWord(redir.word) !== '/dev/null')) return false;
      const node = stmt.cmd;
      if (node?.type === 'BinaryCmd') {
        if (stmt.redirs?.length) return false;
        if (node.op === BinCmdOperator.Pipe) return pipePosition !== 'consumer'
          && metadataStmt(node.x, 'source') && metadataStmt(node.y, 'consumer');
        if (pipePosition !== 'none' || ![BinCmdOperator.AndStmt, BinCmdOperator.OrStmt].includes(node.op)) return false;
        return metadataStmt(node.x) && metadataStmt(node.y);
      }
      if (node?.type !== 'CallExpr' || node.assigns?.length || !node.args?.length || ++metadataCommandCount > 128) return false;
      const words = node.args.map(metadataWord);
      if (words.some(word => word === null)) return false;
      if (pipePosition === 'consumer') {
        const last = node.args[node.args.length - 1];
        return isReadOnlyStdinFilter(bytes.subarray(node.start, last.end).toString('utf8'))
          || (words.length === 2 && words[0] === 'head' && /^-\d{1,9}$/.test(words[1]));
      }
      if (words[0] === 'echo' && pipePosition === 'none') return words.every(word => !/[*?\[\]{}]/.test(word));
      if (words[0] !== 'ls') return false;
      let options = true; let operands = 0;
      for (const word of words.slice(1)) {
        if (options && word === '--') { options = false; continue; }
        if (options && (/^-[aAlh1dtrS]+$/.test(word) || /^--time-style=(?:full-iso|long-iso|iso)$/.test(word))) continue;
        if (!/^\/(?!\/)[A-Za-z0-9_./*?\[\]-]+$/.test(word) || word.includes('..')) return false;
        operands += 1;
      }
      metadataSourceCount += operands;
      return operands > 0;
    };
    const metadataManual = Array.isArray(tree.stmts) && tree.stmts.length > 0
      && tree.stmts.every(stmt => metadataStmt(stmt)) && metadataSourceCount > 0;
    const commands = []; const commandFacts = []; const commandIndexes = new Map(); const redirects = new Map(); let pipeCount = 0; const nodeTypes = new Set(); let unknown = false; let nodes = 0;
    const allowed = new Set(['File', 'Stmt', 'BinaryCmd', 'CallExpr', 'Redirect', 'Word', 'Lit', 'SglQuoted', 'DblQuoted', 'Comment']);
    walk(tree, node => {
      nodeTypes.add(node.type);
      if (++nodes > 10000 || !allowed.has(node.type)) { unknown = true; return false; }
      if ((node.type === 'SglQuoted' || node.type === 'DblQuoted') && node.dollar) unknown = true;
      if (node.type === 'Lit' && /[*?\[\]{}]/.test(node.value || '')) unknown = true;
      if (node.type === 'Stmt') {
        if (node.background || node.coprocess || node.disown || node.negated) unknown = true;
        if (node.redirs?.length) {
          if (node.cmd?.type !== 'CallExpr' || node.redirs.length > 2) unknown = true;
          else redirects.set(node.cmd, node.redirs);
        }
      }
      if (node.type === 'BinaryCmd') {
        if (node.op === BinCmdOperator.Pipe && ['CallExpr', 'BinaryCmd'].includes(node.x?.cmd?.type) && node.y?.cmd?.type === 'CallExpr') {
          pipeCount += 1;
        } else if ([BinCmdOperator.AndStmt, BinCmdOperator.OrStmt].includes(node.op)) { /* represented below */ }
        else unknown = true;
      }
      if (node.type === 'CallExpr') {
        if (node.assigns?.length || !node.args?.length || !Number.isSafeInteger(node.start) || !Number.isSafeInteger(node.end)
            || node.start < 0 || node.end <= node.start || node.end > bytes.length) { unknown = true; return; }
        const redirs = redirects.get(node) || [];
        const lastArg = node.args[node.args.length - 1];
        if (!Number.isSafeInteger(lastArg.end) || redirs.some(r => r.start < lastArg.end)) { unknown = true; return; }
        const end = redirs.length ? lastArg.end : node.end;
        const text = bytes.subarray(node.start, end).toString('utf8');
        if (Buffer.byteLength(text, 'utf8') !== end - node.start) { unknown = true; return; }
        const argv = node.args.map(arg => {
          if (!Number.isSafeInteger(arg.start) || !Number.isSafeInteger(arg.end) || arg.start < node.start || arg.end > end || arg.end <= arg.start) return null;
          const raw = bytes.subarray(arg.start, arg.end).toString('utf8');
          if (raw.startsWith('~')) return null;
          const value = parseLiteralBashWords(raw);
          return value?.length === 1 ? value[0] : null;
        });
        const whole = parseLiteralBashWords(text);
        if (argv.some(value => value === null) || !whole || whole.length !== argv.length || whole.some((value, index) => value !== argv[index])) { unknown = true; return; }
        commandIndexes.set(node, commands.length);
        commands.push(text);
        const fact = { source: text, argv, effects: [] };
        commandFacts.push(fact);
        for (const redirect of redirs) {
          const kind = redirect.op === RedirOperator.RdrOut ? 'write' : redirect.op === RedirOperator.AppOut ? 'append' : redirect.op === RedirOperator.RdrIn ? 'read' : null;
          const word = redirect.word;
          if (!kind || redirect.n || redirect.hdoc || !word || !Number.isSafeInteger(word.start) || !Number.isSafeInteger(word.end)
              || word.start < 0 || word.end <= word.start || word.end > bytes.length) { unknown = true; continue; }
          const raw = bytes.subarray(word.start, word.end).toString('utf8');
          const parsed = parseLiteralBashWords(raw);
          if (!parsed || parsed.length !== 1 || !parsed[0] || raw.startsWith('~')) { unknown = true; continue; }
          fact.effects.push({ kind, path: parsed[0] });
        }
      }
    });
    const listingOperands = text => {
      const words = parseLiteralBashWords(text);
      if (words?.[0] !== 'ls') return null;
      const operands = []; let options = true;
      for (const word of words.slice(1)) {
        if (options && word === '--') { options = false; continue; }
        if (options && /^-[aAlh1dtrS]+$/.test(word)) continue;
        if (options && /^--time-style=(?:full-iso|long-iso|iso)$/.test(word)) continue;
        if (options && word.startsWith('-')) return null;
        if (!word || word.startsWith('//')) return null;
        operands.push(word);
      }
      return operands;
    };
    const stdinFilter = text => isReadOnlyStdinFilter(text)
      || (() => {
        const words = parseLiteralBashWords(text);
        return words?.length === 2 && words[0] === 'head' && /^-\d{1,9}$/.test(words[1]);
      })();
    const contentOperand = text => {
      const words = parseLiteralBashWords(text);
      if (!words || !['cat', 'head', 'tail'].includes(words[0])) return null;
      let target = null; let options = true;
      for (let i = 1; i < words.length; i += 1) {
        const word = words[i];
        if (options && word === '--') { options = false; continue; }
        if (options && words[0] !== 'cat' && /^-(?:n|c)$/.test(word)) {
          if (!/^\d{1,9}$/.test(words[++i] || '')) return null;
          continue;
        }
        if (options && words[0] !== 'cat' && /^(?:-\d{1,9}|-(?:n|c)\d{1,9}|--(?:lines|bytes)=\d{1,9})$/.test(word)) continue;
        if ((options && word.startsWith('-')) || !word || word === '-' || target !== null) return null;
        target = word;
      }
      return target;
    };
    for (const fact of commandFacts) {
      const listing = listingOperands(fact.source);
      const content = contentOperand(fact.source);
      fact.readEffects = listing ? (listing.length ? listing : ['.']).map(target => ({ kind: 'list', path: target }))
        : content ? [{ kind: 'read', path: content }] : [];
      fact.boundedRead = Boolean(listing || content);
      fact.stdinOnly = Boolean(stdinFilter(fact.source));
    }
    const effects = commandFacts.flatMap((fact, commandIndex) => fact.effects.map(effect => ({ ...effect, commandIndex })));
    // Retain the AST's sequence, conditions and pipe edges; no branch is
    // assumed to execute, so every possible effect still needs proof.
    const structure = node => {
      if (node?.type === 'Stmt') return structure(node.cmd);
      if (node?.type === 'CallExpr') {
        const index = commandIndexes.get(node);
        return Number.isInteger(index) ? { type: 'command', index } : null;
      }
      if (node?.type !== 'BinaryCmd') return null;
      const type = node.op === BinCmdOperator.Pipe ? 'pipe'
        : node.op === BinCmdOperator.AndStmt ? 'and' : node.op === BinCmdOperator.OrStmt ? 'or' : null;
      const left = structure(node.x), right = structure(node.y);
      return type && left && right ? { type, left, right } : null;
    };
    const groups = (tree.stmts || []).map(structure);
    if (!groups.length || groups.some(group => !group)) unknown = true;
    const pipelines = [];
    const collect = node => {
      if (node.type === 'pipe') {
        const indexes = [];
        const flatten = part => {
          if (part.type === 'command') indexes.push(part.index);
          else if (part.type === 'pipe') { flatten(part.left); flatten(part.right); }
          else unknown = true;
        };
        flatten(node);
        const source = commandFacts[indexes[0]];
        const consumers = indexes.slice(1).map(index => commandFacts[index]);
        const bounded = source?.boundedRead && consumers.length && consumers.every(fact => stdinFilter(fact.source));
        const rg = source?.argv?.[0] === 'rg' && consumers.length === 1
          && readOnlyRipgrepArgs(source.argv.slice(1)) && isReadOnlyStdinFilter(consumers[0].source);
        if (!bounded && !rg) unknown = true;
        pipelines.push({ indexes, bounded: Boolean(bounded), recursiveSearch: Boolean(rg) });
      } else if (node.type === 'and' || node.type === 'or') { collect(node.left); collect(node.right); }
    };
    for (const group of groups) if (group) collect(group);
    if (unknown || !commands.length || commands.length > 128) return { complete: false, reasonCode: 'shell_syntax_dynamic_or_unsupported', metadataListing: metadataManual, commands: [], nodeTypes: [...nodeTypes].sort(), commandCount: commands.length };
    const classifiedLiterals = commands.map(text => {
      const words = parseLiteralBashWords(text);
      if (!words?.length || /[\\/]/.test(words[0])) return false;
      if (['echo', 'pwd', 'true', 'false', ':'].includes(words[0])) return true;
      if (stdinFilter(text)) return true;
      if (words[0] === 'rg') return Boolean(readOnlyRipgrepArgs(words.slice(1)));
      const developerTask = isRecognizedDeveloperTask(words[0], words.slice(1));
      if (['npm','pnpm','yarn','bun','npx','go','cargo','dotnet','gradle','mvn'].includes(words[0])) return developerTask;
      return isRecognizedRiskProgram(words[0]) || developerTask;
    });
    // This fact is only suitable for a manual same-sandbox approval. PATH and
    // filesystem identity are not authenticated by this parser. Require an
    // explicit absolute target and a deliberately small ls option set.
    const metadataSources = new Set();
    const metadataPipelineIndexes = new Set();
    let metadataPipelines = true;
    for (const pipeline of pipelines) {
      const [sourceIndex, ...consumerIndexes] = pipeline.indexes;
      const operands = listingOperands(commandFacts[sourceIndex]?.source);
      if (!operands?.length || !operands.every(word => word.startsWith('/') && !word.startsWith('//'))
          || !consumerIndexes.length || !consumerIndexes.every(index => commandFacts[index]?.stdinOnly)) metadataPipelines = false;
      metadataSources.add(sourceIndex);
      for (const index of pipeline.indexes) metadataPipelineIndexes.add(index);
    }
    const metadataListing = effects.length === 0 && metadataPipelines && commandFacts.some((fact, index) => {
      if (metadataSources.has(index)) return true;
      const operands = listingOperands(fact.source);
      return Boolean(operands?.length && operands.every(word => word.startsWith('/') && !word.startsWith('//')));
    }) && commandFacts.every((fact, index) => {
      if (metadataPipelineIndexes.has(index)) return true;
      const operands = listingOperands(fact.source);
      return Boolean(operands?.length && operands.every(word => word.startsWith('/') && !word.startsWith('//')))
        || fact.argv[0] === 'echo';
    });
    return { complete: true, reasonCode: 'shell_syntax_literal', commands, commandFacts, effects, classifiedLiterals, metadataListing: metadataListing || metadataManual, groups, pipelines,
      nodeTypes: [...nodeTypes].sort(), commandCount: commands.length };
  } catch {
    // A missing package, invalid syntax, or failed runtime cannot authorize work.
    return { complete: false, reasonCode: 'shell_parser_unavailable_or_invalid', commands: [] };
  }
}
