import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type Counts = Record<string, number>;

function scanTree(dir: string): string[] {
  return readdirSync(new URL(`../src/${dir}`, import.meta.url), { withFileTypes: true }).flatMap(
    (entry) => {
      const child = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return scanTree(child);
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
      return [child];
    },
  );
}

const resolveCalls: Counts = {};
const noteCalls: Counts = {};
const effortEnqueues: Counts = {};
const violations: string[] = [];

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function propertyOf(
  obj: ts.ObjectLiteralExpression,
  key: string,
): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.find(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      p.name.getText() === key,
  );
}

for (const file of scanTree('')) {
  const source = ts.createSourceFile(
    file,
    readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const where = (node: ts.Node) =>
    `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name === 'resolveTaskDispatch') {
        resolveCalls[file] = (resolveCalls[file] ?? 0) + 1;
        const third = node.arguments[2];
        if (!third || !ts.isObjectLiteralExpression(third)) {
          throw new Error(
            `rule (i): resolveTaskDispatch at ${where(node)} needs an object literal as its third argument`,
          );
        }
        if (propertyOf(third, 'preferredProviderId') && !propertyOf(third, 'savedPreference')) {
          violations.push(
            `rule (i): resolveTaskDispatch at ${where(node)} passes preferredProviderId without savedPreference`,
          );
        }
      } else if (name === 'noteSavedCliSkip') {
        noteCalls[file] = (noteCalls[file] ?? 0) + 1;
      } else if (name === 'enqueueCliInvocation') {
        const payload = node.arguments[0];
        if (payload && ts.isObjectLiteralExpression(payload)) {
          const effort = propertyOf(payload, 'effortLevel');
          if (effort) {
            effortEnqueues[file] = (effortEnqueues[file] ?? 0) + 1;
            const text = ts.isPropertyAssignment(effort) ? effort.initializer.getText() : '';
            if (!text.includes('skippedSavedPreference')) {
              violations.push(
                `rule (ii): enqueueCliInvocation at ${where(node)} sends effortLevel without checking skippedSavedPreference`,
              );
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

describe('saved CLI skip call sites', () => {
  it('rule (i): every task dispatch states whether its preferred CLI is the saved one', () => {
    expect(violations.filter((v) => v.startsWith('rule (i)'))).toEqual([]);
    expect(resolveCalls).toEqual({
      'step-engine/step-runner.ts': 4,
      'step-engine/merge-resolver.ts': 1,
      'step-engine/dag-executor.ts': 4,
    });
  });

  it('rule (ii): an effort sent with a launch is dropped when the saved pick was skipped', () => {
    expect(violations.filter((v) => v.startsWith('rule (ii)'))).toEqual([]);
    expect(effortEnqueues).toEqual({ 'step-engine/step-runner.ts': 2 });
  });

  it('rule (iii): every launch that can skip a saved pick writes the notice', () => {
    expect(noteCalls).toEqual({
      'step-engine/step-runner.ts': 3,
      'step-engine/dag-executor.ts': 4,
      'step-engine/merge-resolver.ts': 1,
    });
  });
});
