import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The roles table cannot see a dispatch whose capabilities are spelled out in place, or a tenth
// `resolveTaskDispatch` call: so every call takes its mode from the table or names an opt-out.

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

/** The text between the parentheses of the call that opens at `open`, skipping strings, template
 *  literals and comments, which may hold a parenthesis of their own. */
function callArguments(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) break;
    } else if (ch === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2) + 1;
    } else if (ch === "'" || ch === '"') {
      for (i += 1; source[i] !== ch; i += 1) if (source[i] === '\\') i += 1;
    } else if (ch === '`') {
      i = templateEnd(source, i);
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced call');
}

/** The index of the backtick that closes the template literal opened at `start`. */
function templateEnd(source: string, start: number): number {
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === '\\') i += 1;
    else if (source[i] === '`') return i;
    else if (source[i] === '$' && source[i + 1] === '{') {
      let depth = 0;
      for (i += 1; i < source.length; i += 1) {
        if (source[i] === '`') i = templateEnd(source, i);
        else if (source[i] === '{') depth += 1;
        else if (source[i] === '}' && --depth === 0) break;
      }
    }
  }
  throw new Error('unterminated template literal');
}

interface Call {
  file: string;
  line: number;
  args: string;
}

function dispatchCalls(): Call[] {
  const calls: Call[] = [];
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bresolveTaskDispatch\(/g)) {
      const before = source.slice(Math.max(0, match.index - 40), match.index);
      if (/function\s+$/.test(before)) continue;
      calls.push({
        file: path.relative(SRC, file),
        line: source.slice(0, match.index).split('\n').length,
        args: callArguments(source, match.index + match[0].length - 1),
      });
    }
  }
  return calls;
}

const calls = dispatchCalls();

describe('every resolveTaskDispatch call says whether it is shown the house rules', () => {
  it('finds the nine production calls, so the scan itself is not what passes', () => {
    expect(calls.map((c) => c.file).sort()).toEqual([
      'step-engine/dag-executor.ts',
      'step-engine/dag-executor.ts',
      'step-engine/dag-executor.ts',
      'step-engine/dag-executor.ts',
      'step-engine/merge-resolver.ts',
      'step-engine/step-runner.ts',
      'step-engine/step-runner.ts',
      'step-engine/step-runner.ts',
      'step-engine/step-runner.ts',
    ]);
  });

  it.each(calls.map((c) => [`${c.file}:${c.line}`, c] as const))(
    '%s passes houseRules from the roles table or names an opt-out',
    (_where, call) => {
      expect(call.args).toMatch(/\bhouseRules\s*:\s*(houseRulesFor|houseRulesOptOut)\(/);
    },
  );

  it('gives every opt-out a reason', () => {
    const optOuts = calls.flatMap((c) => [...c.args.matchAll(/\bhouseRulesOptOut\(([^)]*)\)/g)]);
    expect(optOuts.length).toBeGreaterThanOrEqual(4);
    for (const [, argument] of optOuts) {
      expect(argument).toMatch(/^\s*(['"`])[^'"`]{10,}\1,?\s*$/);
    }
  });

  it('never builds a request by hand: the mode comes from the table', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !/orchestrator\/(dispatcher|house-rules)\.ts$/.test(file))
      .filter((file) => /\bhouseRules\s*:\s*\{/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('asks the table for the roles the plan names: the step runner, the retry, the fan-out seats and the DAG agents', () => {
    const at = (file: string) => calls.filter((c) => c.file === file).map((c) => c.args);
    const stepRunner = at('step-engine/step-runner.ts');
    expect(
      stepRunner.filter((a) => /houseRulesFor\(\s*stepDef\.metadata\.id,\s*role\s*\)/.test(a)),
    ).toHaveLength(1);
    expect(
      stepRunner.filter((a) =>
        /resolveRole\?\.\(stepIterationsAsRecords\(current\)\.length\)/.test(a),
      ),
    ).toHaveLength(1);
    expect(
      stepRunner.filter((a) =>
        /houseRulesFor\(\s*stepDef\.metadata\.id,\s*dispatch\.roleKey \?\? 'default'\s*\)/.test(a),
      ),
    ).toHaveLength(1);
    // Only the step recap is still opted out.
    expect(stepRunner.filter((a) => /houseRulesOptOut\(/.test(a))).toHaveLength(1);
    const dag = at('step-engine/dag-executor.ts');
    expect(
      dag.filter((a) =>
        /houseRulesFor\(ra\.stepDef\.metadata\.id, role, issue\.estimatedFiles\)/.test(a),
      ),
    ).toHaveLength(1);
    expect(
      dag.filter((a) =>
        /houseRulesFor\(stepDef\.metadata\.id, 'coder', issue\.estimatedFiles\)/.test(a),
      ),
    ).toHaveLength(1);
  });
});
