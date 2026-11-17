/** Offline, no database/embedding calls. Usage: tsx scripts/rag-eval-compare.ts before.json after.json [output.json] */
import path from 'node:path';
import { readTextNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import { compareRuns, type EvalRun } from './rag-eval-report.js';

// Operator-supplied paths may sit under a repository a sandboxed agent writes. Hold every
// component from the filesystem root, so no linked parent can redirect the read or write.
function fromRoot(name: string): [string, string] {
  const full = path.resolve(name);
  const root = path.parse(full).root;
  return [root, full.slice(root.length)];
}

async function read(name: string): Promise<EvalRun> {
  const text = await readTextNoFollow(...fromRoot(name));
  if (text === null) throw new Error(`cannot read ${name}`);
  return JSON.parse(text) as EvalRun;
}
const [before, after, output] = process.argv.slice(2);
if (!before || !after)
  throw new Error('usage: rag-eval-compare.ts before.json after.json [output.json]');
const report = JSON.stringify(compareRuns(await read(before), await read(after)), null, 2) + '\n';
if (output) {
  await writeFileNoFollow(...fromRoot(output), report, {
    mode: 'replace-atomic',
  });
} else process.stdout.write(report);
