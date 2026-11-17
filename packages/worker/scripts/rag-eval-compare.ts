/** Offline, no database/embedding calls. Usage: tsx scripts/rag-eval-compare.ts before.json after.json [output.json] */
import path from 'node:path';
import { readTextNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import { compareRuns, type EvalRun } from './rag-eval-report.js';

async function read(name: string): Promise<EvalRun> {
  const full = path.resolve(name);
  const text = await readTextNoFollow(path.dirname(full), path.basename(full));
  if (text === null) throw new Error(`cannot read ${name}`);
  return JSON.parse(text) as EvalRun;
}
const [before, after, output] = process.argv.slice(2);
if (!before || !after)
  throw new Error('usage: rag-eval-compare.ts before.json after.json [output.json]');
const report = JSON.stringify(compareRuns(await read(before), await read(after)), null, 2) + '\n';
if (output) {
  const full = path.resolve(output);
  await writeFileNoFollow(path.dirname(full), path.basename(full), report, {
    mode: 'replace-atomic',
  });
} else process.stdout.write(report);
