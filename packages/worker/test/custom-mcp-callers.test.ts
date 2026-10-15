import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const CALLERS = ['exec-core.ts', 'sub-agent.ts'];

/** The arguments of every `resolveMcpExtraFiles(` call: its text up to the line holding the closing paren. */
function callArguments(source: string): string[] {
  return [...source.matchAll(/resolveMcpExtraFiles\(/g)].map((match) => {
    const rest = source.slice(match.index + match[0].length);
    return rest.slice(0, rest.search(/\n\s*\)/));
  });
}

// Removing the argument leaves every other test green: a run that names custom tools would simply get none.
describe('the callers of resolveMcpExtraFiles', () => {
  it('hand it the run, so a prompt step with tools is wired on every path that executes it', async () => {
    const calls: string[] = [];
    for (const name of CALLERS) {
      const url = new URL(`../src/queues/cli-exec/${name}`, import.meta.url);
      calls.push(...callArguments(await readFile(url, 'utf8')));
    }
    expect(calls).toHaveLength(3);
    for (const args of calls) expect(args.trimEnd()).toMatch(/\n\s*payload,$/);
  });
});
