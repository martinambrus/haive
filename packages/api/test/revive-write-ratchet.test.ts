import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../src');
const ENDED = new Set(['failed', 'cancelled', 'completed']);
const GUARD = 'refuseReviveBesideLive';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** The literal status a `.update(schema.tasks).set({ status })` chain writes, if any. */
function writtenStatus(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'set') return null;
  let inner: ts.Expression = callee.expression;
  while (ts.isCallExpression(inner) || ts.isPropertyAccessExpression(inner)) {
    if (
      ts.isCallExpression(inner) &&
      ts.isPropertyAccessExpression(inner.expression) &&
      inner.expression.name.text === 'update'
    ) {
      if (inner.arguments[0]?.getText() !== 'schema.tasks') return null;
      const arg = call.arguments[0];
      if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
      for (const p of arg.properties) {
        if (
          ts.isPropertyAssignment(p) &&
          p.name.getText() === 'status' &&
          ts.isStringLiteralLike(p.initializer)
        ) {
          return p.initializer.text;
        }
      }
      return null;
    }
    inner = ts.isCallExpression(inner) ? inner.expression : inner.expression;
  }
  return null;
}

function outermostFunction(node: ts.Node): ts.Node | null {
  let found: ts.Node | null = null;
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n)) found = n;
  }
  return found;
}

/** Every live-status write on a task row, with whether it is covered. */
function liveWrites(): { site: string; status: string; covered: boolean }[] {
  const out: { site: string; status: string; covered: boolean }[] = [];
  for (const file of sources(SRC)) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const status = writtenStatus(node);
        if (status !== null && !ENDED.has(status)) {
          const chain = node.parent?.parent?.getText() ?? '';
          const fromCreated = chain.includes("eq(schema.tasks.status, 'created')");
          const fn = outermostFunction(node);
          const guarded = fn !== null && fn.getText().includes(`${GUARD}(`);
          const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          out.push({
            site: `${relative(SRC, file)}:${line}`,
            status,
            covered: fromCreated || guarded,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

// A write that puts a task row back to a live status revives it, so it must run the revival's
// exclusion in the same function, unless it only starts a task that was never live.
describe('a live-status write on a task row', () => {
  it(`calls ${GUARD} in its function, or moves only a created task`, () => {
    const writes = liveWrites();
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.filter((w) => !w.covered)).toEqual([]);
  });
});
