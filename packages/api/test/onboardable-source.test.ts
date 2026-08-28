import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hasOnboardableSource } from '../src/routes/repos.js';

async function tree(entries: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'onboardable-'));
  for (const e of entries) {
    if (e.endsWith('/')) await mkdir(path.join(dir, e), { recursive: true });
    else {
      await mkdir(path.dirname(path.join(dir, e)), { recursive: true });
      await writeFile(path.join(dir, e), 'x');
    }
  }
  return dir;
}

describe('hasOnboardableSource', () => {
  it('is false for a repository holding only its scaffold', async () => {
    // Exactly what blank-repo init leaves behind. Nothing here is source, so an
    // onboarding run would have nothing to read.
    const dir = await tree(['.git/', 'README.md', '.claude/agents/', '.haive-data/', 'AGENTS.md']);
    expect(await hasOnboardableSource(dir)).toBe(false);
  });

  it('is false for a completely empty directory', async () => {
    expect(await hasOnboardableSource(await tree([]))).toBe(false);
  });

  it('ignores every CLI agents dir the scaffold can emit', async () => {
    // MEASURED on a real seeded repo: .agents, .codex and .grok appeared beside
    // .claude, one per enabled provider. A hardcoded ignore list knew only some
    // of them, so the repo read as having source and went back to demanding
    // onboarding — which is why the set is derived from CLI_PROVIDER_LIST.
    const dir = await tree([
      '.git/',
      'README.md',
      '.claude/agents/',
      '.agents/',
      '.codex/agents/',
      '.grok/',
      '.gemini/agents/',
    ]);
    expect(await hasOnboardableSource(dir)).toBe(false);
  });

  it('is true once a single source file appears', async () => {
    // The case that brings the Onboard offer back on its own.
    const dir = await tree(['.git/', 'README.md', '.claude/agents/', 'index.php']);
    expect(await hasOnboardableSource(dir)).toBe(true);
  });

  it('is true for a source directory, not just a file', async () => {
    expect(await hasOnboardableSource(await tree(['.git/', 'src/']))).toBe(true);
  });

  it('counts a dotfile the scaffold does not own as source', async () => {
    // .github, .env, .gitignore — a repo carrying those is not an empty project.
    expect(await hasOnboardableSource(await tree(['.git/', '.github/']))).toBe(true);
  });

  it('says a root it cannot read HAS source', async () => {
    // Failing the other way would withdraw the Onboard offer from a user who
    // genuinely has code. A stale offer costs a click; a missing one hides the
    // feature.
    expect(await hasOnboardableSource('/definitely/not/a/path')).toBe(true);
  });
});
