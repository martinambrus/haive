import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  KB_DRAFT_DIR,
  KbBodyPathError,
  parseSectionsFromMarkdown,
  resolveBodies,
  resolveKbBodyPath,
} from '../src/step-engine/steps/onboarding/_kb-body-file.js';
import {
  parseKbEntries,
  parseKbUpdates,
} from '../src/step-engine/steps/onboarding/08-knowledge-acquisition.js';

// An entire knowledge base in one fenced JSON block hits the model's single-message
// ceiling. MEASURED on a live repo: 4,083s and 378,008 output tokens to produce 135,433
// characters — 3.7x the tokens of the run before it for FEWER bytes, all of it spent
// shortening and re-emitting. Staging the bodies in files removes the ceiling.
describe('parseSectionsFromMarkdown', () => {
  it('is the inverse of the renderer', () => {
    const md = [
      '# Architecture',
      '',
      '## Overview',
      '',
      'Body one.',
      '',
      '## Layout',
      '',
      'Body two.',
      '',
    ].join('\n');
    expect(parseSectionsFromMarkdown(md)).toEqual([
      { heading: 'Overview', body: 'Body one.' },
      { heading: 'Layout', body: 'Body two.' },
    ]);
  });

  // apply re-adds this block from the entry's own sourceFiles; keeping it would duplicate
  // the list on every re-render.
  it('drops the renderer-appended Source files block', () => {
    const md = ['# T', '', '## Real', '', 'x', '', '## Source files', '', '- `a.php`', ''].join(
      '\n',
    );
    expect(parseSectionsFromMarkdown(md).map((s) => s.heading)).toEqual(['Real']);
  });

  it('keeps fenced code and inner hashes intact', () => {
    const md = [
      '# T',
      '',
      '## Usage',
      '',
      '```php',
      '# not a heading',
      '```',
      '',
      '### deeper',
      '',
      'tail',
    ].join('\n');
    const [s] = parseSectionsFromMarkdown(md);
    expect(s!.heading).toBe('Usage');
    expect(s!.body).toContain('# not a heading');
    expect(s!.body).toContain('### deeper');
  });

  it('returns nothing for a file with no level-2 headings', () => {
    expect(parseSectionsFromMarkdown('# Title\n\njust prose\n')).toEqual([]);
  });
});

describe('resolveKbBodyPath', () => {
  // Every legitimate producer can name a path without `..`, so its presence is a payload
  // to refuse rather than one to repair.
  it('refuses an escape, an absolute path and an empty string', () => {
    for (const bad of [`${KB_DRAFT_DIR}/../../etc/passwd`, '/etc/passwd', '']) {
      expect(() => resolveKbBodyPath('/repo', bad), bad).toThrow(KbBodyPathError);
    }
  });

  it('refuses a path outside the draft dir', () => {
    expect(() => resolveKbBodyPath('/repo', '.haive-data/knowledge_base/ARCHITECTURE.md')).toThrow(
      KbBodyPathError,
    );
  });

  it('accepts a path inside it', () => {
    expect(resolveKbBodyPath('/repo', `${KB_DRAFT_DIR}/architecture.md`)).toBe(
      path.resolve('/repo', KB_DRAFT_DIR, 'architecture.md'),
    );
  });
});

describe('resolveBodies', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'haive-kbbody-'));
    await mkdir(path.join(dir, KB_DRAFT_DIR), { recursive: true });
    await writeFile(
      path.join(dir, KB_DRAFT_DIR, 'arch.md'),
      '# Architecture\n\n## Overview\n\nStaged body.\n',
    );
    await writeFile(path.join(dir, KB_DRAFT_DIR, 'empty.md'), '# Title\n\nno sections\n');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fills sections from the staged file', async () => {
    const r = await resolveBodies(dir, [{ bodyPath: `${KB_DRAFT_DIR}/arch.md` }]);
    expect(r.failures).toEqual([]);
    expect(r.resolved[0]!.sections).toEqual([{ heading: 'Overview', body: 'Staged body.' }]);
  });

  // A model ignoring the new contract, or a payload replayed from before it existed,
  // must behave exactly as it did.
  it('prefers inline sections and needs no file', async () => {
    const inline = [{ heading: 'H', body: 'B' }];
    const r = await resolveBodies(dir, [{ sections: inline }]);
    expect(r.resolved[0]!.sections).toEqual(inline);
    expect(r.failures).toEqual([]);
  });

  // Declared-but-missing must fail the ENTRY: a blank ARCHITECTURE.md reads as "this
  // project has no architecture" to every later reader.
  it('fails an entry whose file was never written', async () => {
    const r = await resolveBodies(dir, [{ bodyPath: `${KB_DRAFT_DIR}/nope.md` }]);
    expect(r.resolved).toEqual([]);
    expect(r.failures[0]!.reason).toMatch(/declared but not written/);
  });

  it('fails an entry whose file has no sections', async () => {
    const r = await resolveBodies(dir, [{ bodyPath: `${KB_DRAFT_DIR}/empty.md` }]);
    expect(r.failures[0]!.reason).toMatch(/no `## ` sections/);
  });

  // One bad body must not discard the good entries beside it.
  it('keeps the good entries when one fails', async () => {
    const r = await resolveBodies(dir, [
      { bodyPath: `${KB_DRAFT_DIR}/arch.md` },
      { bodyPath: `${KB_DRAFT_DIR}/nope.md` },
      { sections: [{ heading: 'H', body: 'B' }] },
    ]);
    expect(r.resolved).toHaveLength(2);
    expect(r.failures).toHaveLength(1);
  });

  it('rejects a traversing bodyPath as a failure, not a throw', async () => {
    const r = await resolveBodies(dir, [{ bodyPath: `${KB_DRAFT_DIR}/../../escape.md` }]);
    expect(r.resolved).toEqual([]);
    expect(r.failures[0]!.reason).toMatch(/must sit under/);
  });
});

// The step's own validators must accept an entry whose body is staged, and must keep
// accepting one that carries it inline — a model ignoring the new contract, or a payload
// replayed from before it existed, has to behave exactly as it did.
describe('08 entry/update validation with a staged body', () => {
  const fence = (obj: unknown): string => '```json\n' + JSON.stringify(obj) + '\n```';

  it('accepts an entry with bodyPath and no sections', () => {
    const out = parseKbEntries(
      fence({ entries: [{ id: 'arch', title: 'A', bodyPath: `${KB_DRAFT_DIR}/arch.md` }] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.bodyPath).toBe(`${KB_DRAFT_DIR}/arch.md`);
  });

  it('still accepts an entry with inline sections', () => {
    const out = parseKbEntries(
      fence({ entries: [{ id: 'arch', title: 'A', sections: [{ heading: 'H', body: 'B' }] }] }),
    );
    expect(out[0]!.sections).toEqual([{ heading: 'H', body: 'B' }]);
  });

  it('rejects an entry with neither', () => {
    expect(parseKbEntries(fence({ entries: [{ id: 'arch', title: 'A' }] }))).toHaveLength(0);
  });

  it('accepts an update with bodyPath', () => {
    const out = parseKbUpdates(
      fence({ updates: [{ path: 'OLD.md', title: 'T', bodyPath: `${KB_DRAFT_DIR}/old.md` }] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.bodyPath).toBe(`${KB_DRAFT_DIR}/old.md`);
  });
});
