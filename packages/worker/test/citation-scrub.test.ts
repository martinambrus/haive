import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  citationCandidates,
  scrubCitations,
  splitIntoBlocks,
} from '../src/step-engine/steps/kb-author/_citation-scrub.js';

// A global KB article is retrieved by OTHER projects, so a path from the codebase that happened
// to be open is noise there and rots here. MEASURED on entry b15eebfb, which led with
// `sites/all/themes/activit/img/` and cited `internal_menu_block.tpl.php:83-88`.
let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'haive-scrub-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
});

const mk = async (rel: string) => {
  await mkdir(path.join(repo, path.dirname(rel)), { recursive: true });
  await writeFile(path.join(repo, rel), 'x');
};

describe('splitIntoBlocks', () => {
  it('keeps a fenced example whole, so half a sample is never left behind', () => {
    const blocks = splitIntoBlocks('intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter');
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toBe('```js\nconst a = 1;\n\nconst b = 2;\n```');
  });
});

describe('scrubCitations', () => {
  it('removes a line reference in either mode, with no repo to check against', async () => {
    const body =
      '## The rule\n\nAlways X.\n\nSee internal_menu_block.tpl.php:83-88 for the bad case.';
    const r = await scrubCitations(body, { repoPath: null });
    expect(r.body).not.toMatch(/83-88/);
    expect(r.body).toMatch(/Always X/);
    expect(r.removed[0]?.reason).toBe('internal_menu_block.tpl.php:83-88');
  });

  it('removes a path that RESOLVES in the anchor repo', async () => {
    await mk('sites/all/themes/activit/img/icon.png');
    const body =
      '## The rule\n\nUse files.\n\nThe convention is sites/all/themes/activit/img/ already.';
    const r = await scrubCitations(body, { repoPath: repo });
    expect(r.body).toMatch(/Use files/);
    expect(r.body).not.toMatch(/activit/);
    expect(r.removed).toHaveLength(1);
  });

  it('leaves an INVENTED example path alone — the whole point of verifying', async () => {
    // The prompt now asks for abstracted examples, which are full of plausible paths. A
    // shape-matching rule would delete exactly what we asked the model to write.
    const body =
      '## The right way\n\n```css\n.icon { background-image: url("/images/icon.svg"); }\n```\n\nPut it in src/components/Button.tsx.';
    const r = await scrubCitations(body, { repoPath: repo });
    expect(r.removed).toHaveLength(0);
    expect(r.body).toMatch(/Button\.tsx/);
    expect(r.body).toMatch(/icon\.svg/);
  });

  it('drops the whole block, not the sentence, so no claim outlives its evidence', async () => {
    await mk('web/modules/custom/acme/acme.module');
    const body =
      '## A\n\nkeep me\n\nThe helper lives in web/modules/custom/acme/acme.module and is cached.';
    const r = await scrubCitations(body, { repoPath: repo });
    expect(r.body).toBe('## A\n\nkeep me');
    expect(r.removed[0]?.excerpt).toMatch(/The helper lives in/);
  });

  it('removes a block leaning on a symbol defined in the anchor repo', async () => {
    const body = '## A\n\ngeneric advice\n\nCall activit_build_menu() first.';
    const r = await scrubCitations(body, {
      repoPath: repo,
      repoSymbols: new Set(['activit_build_menu']),
      findSymbol: (text, symbols) => [...symbols].find((s) => text.includes(s)) ?? null,
    });
    expect(r.body).toBe('## A\n\ngeneric advice');
    expect(r.removed[0]?.reason).toBe('activit_build_menu');
  });

  it('scrubs nothing from an article that was written correctly', async () => {
    await mk('sites/all/themes/activit/img/icon.png');
    const body =
      '## The rule\n\nReference SVG by URL.\n\n## The wrong way\n\n```html\n<!-- ANTI-PATTERN — do not copy -->\n<svg viewBox="0 0 16 16">...</svg>\n```\n\n## The right way\n\n```html\n<img src="/img/icon.svg" alt="">\n```';
    const r = await scrubCitations(body, { repoPath: repo });
    expect(r.removed).toEqual([]);
    expect(r.body).toBe(body);
  });
});

describe('citationCandidates', () => {
  it('ignores prose slashes and URLs that are not paths', () => {
    expect(citationCandidates('use and/or, see https://example.com/docs/x')).toEqual([]);
  });
});

// `activit.module:534` and `api.internal:8080` are the same token shape, so the shape alone
// cannot decide. Stripping on shape deleted whole blocks for naming a host and a port.
describe('line references vs host:port', () => {
  it('strips a ranged reference in either mode', async () => {
    const r = await scrubCitations('Look at internal_menu_block.tpl.php:83-88 for this.', {
      repoPath: null,
    });
    expect(r.removed).toHaveLength(1);
    expect(r.body).toBe('');
  });

  it('strips a slashed path reference in either mode', async () => {
    const r = await scrubCitations('See src/Cache/Backend.php:12 here.', { repoPath: null });
    expect(r.removed).toHaveLength(1);
  });

  it('keeps a host and port, which is not a file reference', async () => {
    const body = [
      'Point the app at db.example.com:5432 and the cache at api.internal:8080.',
      '',
      'A queue at redis://cache.local:6379/0 behaves the same way.',
    ].join('\n');
    const r = await scrubCitations(body, { repoPath: null });
    expect(r.removed).toEqual([]);
    expect(r.body).toContain('db.example.com:5432');
    expect(r.body).toContain('redis://cache.local:6379/0');
  });

  it('strips a bare reference only when it resolves in the anchor repo', async () => {
    const kept = await scrubCitations('Handled in api.internal:8080 today.', {
      repoPath: '/nonexistent-repo-root',
    });
    expect(kept.removed).toEqual([]);
  });
});
