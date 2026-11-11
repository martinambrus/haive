import path from 'node:path';
import { extractArchive } from '../src/repo/clone.js';
import { readReplacement, recordReplacementSwap } from '../src/repo/bundle-recovery.js';
const [root, archive] = process.argv.slice(2) as [string, string];
const archiveRel = path.relative(root, archive);
const destRel = `${path.posix.dirname(archiveRel)}/extracted`;
const replacement = await readReplacement(root, archiveRel);
if (!replacement) throw new Error('fixture replacement record missing');
await extractArchive(
  { anchor: root, rel: archiveRel },
  'zip',
  { anchor: root, rel: destRel },
  {
    keepLoneDir: () => true,
    beforeSwap: (stageRel) =>
      recordReplacementSwap(root, archiveRel, destRel, stageRel, replacement),
    afterSwap: async () => {
      process.kill(process.pid, 'SIGKILL');
    },
  },
);
