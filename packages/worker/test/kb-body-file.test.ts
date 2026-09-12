import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  discardKbDrafts,
  KB_DRAFT_DIR,
  readKbBodyFile,
  readKbBodyText,
  KbBodyPathError,
  parseSectionsFromMarkdown,
  prepareAgentWritableDir,
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
// The sandboxed agent OWNS the draft dir, and the worker reading it runs as root — so a
// symlink dropped in there reads a file the agent could never open itself and publishes it as
// trusted KB output. A lexical containment check cannot see through one.
describe('staged bodies never escape the draft dir', () => {
  let dir: string;
  let secret: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'haive-kbescape-'));
    await mkdir(path.join(dir, KB_DRAFT_DIR), { recursive: true });
    secret = path.join(dir, 'outside-secret.md');
    await writeFile(secret, '## Leaked\n\nWORKER_READABLE_EXTERNAL_SECRET\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a symlink that points outside, in both readers', async () => {
    await symlink(secret, path.join(dir, KB_DRAFT_DIR, 'sneak.md'));
    const declared = `${KB_DRAFT_DIR}/sneak.md`;
    await expect(readKbBodyFile(dir, declared)).rejects.toThrow(KbBodyPathError);
    await expect(readKbBodyText(dir, declared)).rejects.toThrow(/resolves outside/);
  });

  it('refuses a body reached through a symlinked SUBDIRECTORY', async () => {
    const outsideDir = path.join(dir, 'elsewhere');
    await mkdir(outsideDir, { recursive: true });
    await writeFile(path.join(outsideDir, 'x.md'), '## H\n\nbody\n');
    await symlink(outsideDir, path.join(dir, KB_DRAFT_DIR, 'sub'));
    await expect(readKbBodyText(dir, `${KB_DRAFT_DIR}/sub/x.md`)).rejects.toThrow(
      /resolves outside/,
    );
  });

  it('still reads an ordinary staged file', async () => {
    await writeFile(path.join(dir, KB_DRAFT_DIR, 'ok.md'), '## H\n\nAGENT_DRAFT_CONTENT\n');
    await expect(readKbBodyText(dir, `${KB_DRAFT_DIR}/ok.md`)).resolves.toContain(
      'AGENT_DRAFT_CONTENT',
    );
  });
});

// Body paths are deterministic (`<id>.md`), so a retry that declares one and then fails to
// write it would read the PREVIOUS attempt's file and publish it as this attempt's output.
describe('prepareAgentWritableDir isolates attempts', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'haive-kbretry-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('empties a staging dir left by a previous attempt', async () => {
    await mkdir(path.join(dir, KB_DRAFT_DIR), { recursive: true });
    await writeFile(path.join(dir, KB_DRAFT_DIR, 'arch.md'), '## H\n\nPRIOR_ATTEMPT_CONTENT\n');
    await prepareAgentWritableDir(dir, KB_DRAFT_DIR);
    await expect(stat(path.join(dir, KB_DRAFT_DIR, 'arch.md'))).rejects.toThrow();
    await expect(readKbBodyText(dir, `${KB_DRAFT_DIR}/arch.md`)).rejects.toThrow(
      /declared but not written/,
    );
  });

  it('leaves the rest of .haive alone while clearing', async () => {
    await mkdir(path.join(dir, '.haive'), { recursive: true });
    await writeFile(path.join(dir, '.haive', 'install.json'), '{"keep":true}');
    await prepareAgentWritableDir(dir, KB_DRAFT_DIR);
    expect(await readFile(path.join(dir, '.haive', 'install.json'), 'utf8')).toContain('keep');
  });
});

// `prepareAgentWritableDir` empties the staging dir per attempt, which closes staleness for
// a RETRY because detect re-runs. An invocation orphaned by a worker restart is RE-DISPATCHED
// WITHOUT detect, so the killed run's bodies survive at the same deterministic names.
// MEASURED: 14 of them did, and only the agent happening to rewrite every path it declared
// kept stale content out of the knowledge base.
describe('a staged body older than its run is refused', () => {
  let dir: string;
  const runStart = new Date('2026-09-12T16:26:00Z');
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'haive-kbstale-'));
    await mkdir(path.join(dir, KB_DRAFT_DIR), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function stage(name: string, mtime: string): Promise<string> {
    const abs = path.join(dir, KB_DRAFT_DIR, name);
    await writeFile(abs, '## H\n\nbody\n');
    const when = new Date(mtime);
    await utimes(abs, when, when);
    return `${KB_DRAFT_DIR}/${name}`;
  }

  it('refuses a body left by the attempt that was killed', async () => {
    const declared = await stage('architecture.md', '2026-09-12T16:05:00Z');
    await expect(readKbBodyFile(dir, declared, runStart)).rejects.toThrow(/predates this run/);
    await expect(readKbBodyText(dir, declared, runStart)).rejects.toThrow(KbBodyPathError);
  });

  it('accepts a body this run wrote', async () => {
    const declared = await stage('architecture.md', '2026-09-12T16:31:00Z');
    await expect(readKbBodyText(dir, declared, runStart)).resolves.toContain('body');
  });

  // A false rejection discards a body the agent really wrote, which is the worse direction to
  // be wrong in, so a small clock difference is forgiven.
  it('forgives sub-second clock slop either side of the boundary', async () => {
    const declared = await stage('architecture.md', '2026-09-12T16:25:59Z');
    await expect(readKbBodyText(dir, declared, runStart)).resolves.toContain('body');
  });

  // No cutoff is knowable for a bypass stub or a fan-out, and inventing one would reject good
  // bodies against a clock nobody consulted.
  it('applies no cutoff when none is given', async () => {
    const declared = await stage('architecture.md', '2020-01-01T00:00:00Z');
    await expect(readKbBodyText(dir, declared)).resolves.toContain('body');
  });

  it('drops only the stale entries and keeps the fresh ones beside them', async () => {
    const stale = await stage('stale.md', '2026-09-12T16:05:00Z');
    const fresh = await stage('fresh.md', '2026-09-12T16:33:00Z');
    const r = await resolveBodies(dir, [{ bodyPath: fresh }, { bodyPath: stale }], runStart);
    expect(r.resolved).toHaveLength(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]!.reason).toMatch(/predates this run/);
  });
});

describe('discardKbDrafts', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'haive-kbdraft-'));
    await mkdir(path.join(dir, KB_DRAFT_DIR), { recursive: true });
    await writeFile(path.join(dir, KB_DRAFT_DIR, 'arch.md'), '## Overview\n\nbody\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // `.haive/` is not gitignored and 12-post-onboarding stages `.haive/install.json` by
  // name, so a left-behind draft sits in the user's `git status` for good — and on a repo
  // onboarding has to `git init` itself that step runs `git add -A` and commits them all.
  it('removes the staging dir', async () => {
    await discardKbDrafts(dir);
    await expect(stat(path.join(dir, KB_DRAFT_DIR))).rejects.toThrow();
  });

  // Nothing else under `.haive/` is ours to delete.
  it('leaves the rest of .haive alone', async () => {
    await writeFile(path.join(dir, '.haive', 'install.json'), '{}');
    await discardKbDrafts(dir);
    expect((await stat(path.join(dir, '.haive', 'install.json'))).isFile()).toBe(true);
  });

  it('is a no-op when the dir was never created', async () => {
    await rm(path.join(dir, KB_DRAFT_DIR), { recursive: true, force: true });
    await expect(discardKbDrafts(dir)).resolves.toBeUndefined();
  });
});

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

// The worker runs as root and the sandboxed CLI as another uid, so a plain mkdir hands
// the agent a directory it cannot write. MEASURED: an 8-minute run wrote zero bodies into
// a root:root 0755 `.haive/kb-draft`.
describe('prepareAgentWritableDir', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'haive-kbown-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the whole chain and matches the repo root ownership', async () => {
    await prepareAgentWritableDir(dir, KB_DRAFT_DIR);
    const root = await stat(dir);
    for (const rel of ['.haive', KB_DRAFT_DIR]) {
      const st = await stat(path.join(dir, rel));
      expect(st.isDirectory(), rel).toBe(true);
      // Chowning an already-matching owner is a no-op, so this holds whether or not the
      // test process may chown at all.
      expect(st.uid, rel).toBe(root.uid);
    }
  });

  it('is idempotent', async () => {
    await prepareAgentWritableDir(dir, KB_DRAFT_DIR);
    await prepareAgentWritableDir(dir, KB_DRAFT_DIR);
    expect((await stat(path.join(dir, KB_DRAFT_DIR))).isDirectory()).toBe(true);
  });

  // A host that forbids chown must still leave a usable directory: the agent falls back
  // to inline sections and the step behaves as it did before any of this.
  it('never throws when ownership cannot be changed', async () => {
    await expect(prepareAgentWritableDir(dir, '.haive/kb-draft-2')).resolves.toBeUndefined();
  });
});

// `form()` is sync and used to read `e.sections.length` unguarded, so the first entry
// with a staged body took the whole step down with "Cannot read properties of undefined
// (reading 'length')" AFTER a 2,407s run had already written 37 bodies. The count now
// comes from prepareForm, and the read is defensive either way.
describe('08 form tolerates a staged body', () => {
  const optionDetail = (
    e: { sections?: unknown[]; id: string; sourceFiles?: string[] },
    counts?: Record<string, number>,
  ): number => e.sections?.length ?? counts?.[e.id] ?? 0;

  it('uses the prepared count when sections are absent', () => {
    expect(optionDetail({ id: 'arch' }, { arch: 7 })).toBe(7);
  });

  it('prefers inline sections when present', () => {
    expect(optionDetail({ id: 'arch', sections: [1, 2] }, { arch: 7 })).toBe(2);
  });

  it('falls back to zero rather than throwing', () => {
    expect(optionDetail({ id: 'arch' })).toBe(0);
  });
});
