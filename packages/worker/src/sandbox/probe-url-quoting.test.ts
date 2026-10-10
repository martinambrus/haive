import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(import.meta.dirname, '..');
const SITES = [
  'step-engine/steps/workflow/08a-browser-verify.ts',
  'step-engine/steps/workflow/09-gate-2-verify-approval.ts',
  'step-engine/steps/run-app/99-run-app-ready.ts',
  'queues/runtime-ensure-queue.ts',
];
const SPLICE = /browser-probe-connect\.js (\S+)/g;

describe('browser-probe-connect command lines', () => {
  const found = SITES.flatMap((file) => {
    const text = readFileSync(path.join(SRC, file), 'utf8');
    return [...text.matchAll(SPLICE)]
      .filter((hit) => hit[1]!.startsWith('$') || hit[1]!.startsWith("'"))
      .map((hit) => ({ file, argument: hit[1]! }));
  });

  it('finds every splice the sites make', () => {
    expect(found.length).toBe(12);
  });

  it.each(found)('$file hands the URL through shellQuote ($argument)', ({ argument }) => {
    expect(argument).toMatch(/^\$\{shellQuote\([\w()]+\)\}/);
  });
});
