import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = fileURLToPath(new URL('../..', import.meta.url));

/** The one module allowed to start a git process without going through `hardenGitArgs` itself. */
const WRAPPER = 'worker/src/repo/git-exec.ts';

async function sources(pkg: string): Promise<{ rel: string; text: string }[]> {
  const root = path.join(PACKAGES, pkg, 'src');
  const out: { rel: string; text: string }[] = [];
  for (const rel of await readdir(root, { recursive: true })) {
    if (!rel.endsWith('.ts') || rel.endsWith('.test.ts')) continue;
    out.push({ rel: `${pkg}/src/${rel}`, text: await readFile(path.join(root, rel), 'utf8') });
  }
  return out;
}

describe('every host-side git process', () => {
  it('is started through the hardened argv', async () => {
    const offenders: string[] = [];
    for (const pkg of ['worker', 'api', 'shared']) {
      for (const { rel, text } of await sources(pkg)) {
        if (rel === WRAPPER) continue;
        // A git spawn is `<fn>('git', <args>` — the args must be the hardened form.
        for (const m of text.matchAll(
          /\b(?:exec|execFile|execFileAsync|execGit|spawn)\(\s*'git',\s*([^\n]*)/g,
        )) {
          if (m[1]!.startsWith('hardenGitArgs(')) continue;
          offenders.push(`${rel}:${text.slice(0, m.index).split('\n').length}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
