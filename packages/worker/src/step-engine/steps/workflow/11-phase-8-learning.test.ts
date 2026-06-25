import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  parseGlobalCandidates,
  parseInvestigation,
  parseKbSync,
  parseLearningOutput,
  writeInvestigation,
  phase8LearningStep,
  planLearningReconciliation,
  learningOpsToDiffFiles,
  applyLearningOps,
  readExistingLearnings,
} from './11-phase-8-learning.js';

describe('parseKbSync', () => {
  it('parses classification + changes and drops invalid ops / empty files', () => {
    const ks = parseKbSync({
      kbSync: {
        classification: 'new_feature',
        changes: [
          { file: '.claude/knowledge_base/BUSINESS_LOGIC.md', op: 'insert', summary: 'adds X' },
          { file: 'bad.md', op: 'frobnicate', summary: 'invalid op dropped' },
          { file: '', op: 'update', summary: 'no file dropped' },
        ],
      },
    });
    expect(ks).not.toBeNull();
    expect(ks!.classification).toBe('new_feature');
    expect(ks!.changes).toHaveLength(1);
    expect(ks!.changes[0]).toEqual({
      file: '.claude/knowledge_base/BUSINESS_LOGIC.md',
      op: 'insert',
      summary: 'adds X',
    });
  });

  it('parses from a fenced JSON string and tolerates the kb_sync alias', () => {
    const ks = parseKbSync(
      '```json\n{"kb_sync":{"classification":"feature_removal","changes":[{"file":"a.md","op":"delete","summary":"gone"}]}}\n```',
    );
    expect(ks?.classification).toBe('feature_removal');
    expect(ks?.changes[0]?.op).toBe('delete');
  });

  it('returns null when no kbSync block is present', () => {
    expect(parseKbSync({ entries: [] })).toBeNull();
    expect(parseKbSync('no json')).toBeNull();
    expect(parseKbSync(null)).toBeNull();
  });

  it('defaults classification to unknown and changes to [] when malformed', () => {
    const ks = parseKbSync({ kbSync: { changes: 'nope' } });
    expect(ks).not.toBeNull();
    expect(ks!.classification).toBe('unknown');
    expect(ks!.changes).toEqual([]);
  });
});

describe('parseInvestigation', () => {
  it('parses an investigation from a fenced object', () => {
    const raw =
      '```json\n{"entries":[],"investigation":{"title":"Null deref","root_cause":"missing guard","lesson":"guard inputs"}}\n```';
    const inv = parseInvestigation(raw);
    expect(inv).not.toBeNull();
    expect(inv!.title).toBe('Null deref');
    expect(inv!.rootCause).toBe('missing guard');
    expect(inv!.lesson).toBe('guard inputs');
  });

  it('accepts an already-parsed object', () => {
    const inv = parseInvestigation({
      investigation: { title: 'X', root_cause: 'y', lesson: 'z' },
    });
    expect(inv!.title).toBe('X');
  });

  it('returns null when there is no investigation or it lacks a root cause', () => {
    expect(parseInvestigation('```json\n{"entries":[]}\n```')).toBeNull();
    expect(
      parseInvestigation({ investigation: { title: 'X', root_cause: '', lesson: 'z' } }),
    ).toBeNull();
    expect(parseInvestigation('no json')).toBeNull();
    expect(parseInvestigation(null)).toBeNull();
  });

  it('parses symptoms when present and defaults to empty string when absent', () => {
    const withSym = parseInvestigation({
      investigation: {
        title: 'X',
        symptoms: 'TypeError: x is undefined',
        root_cause: 'y',
        lesson: 'z',
      },
    });
    expect(withSym!.symptoms).toBe('TypeError: x is undefined');

    const withoutSym = parseInvestigation({
      investigation: { title: 'X', root_cause: 'y', lesson: 'z' },
    });
    expect(withoutSym).not.toBeNull();
    expect(withoutSym!.symptoms).toBe('');
  });
});

describe('writeInvestigation', () => {
  const baseInv = {
    title: 'Null deref',
    symptoms: 'TypeError: cannot read x',
    rootCause: 'missing guard',
    lesson: 'guard inputs',
    scope: 'local' as const,
  };

  it('writes a Symptoms section + feature/affected_clients frontmatter when present', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'inv-'));
    try {
      const rel = await writeInvestigation(
        ws,
        baseInv,
        'Fix null deref',
        '',
        '2026-01-01T00:00:00.000Z',
        'checkout',
        ['acme', 'globex'],
      );
      const text = await readFile(path.join(ws, rel), 'utf8');
      expect(text).toContain('feature: "checkout"');
      expect(text).toContain('affected_clients: ["acme","globex"]');
      expect(text).toContain('## Symptoms');
      expect(text).toContain('TypeError: cannot read x');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('omits the Symptoms section + feature/clients frontmatter when absent', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'inv-'));
    try {
      const rel = await writeInvestigation(
        ws,
        { ...baseInv, symptoms: '' },
        'Task',
        '',
        '2026-01-01T00:00:00.000Z',
        null,
        [],
      );
      const text = await readFile(path.join(ws, rel), 'utf8');
      expect(text).not.toContain('## Symptoms');
      expect(text).not.toContain('feature:');
      expect(text).not.toContain('affected_clients:');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe('phase8LearningStep preForm retry gate', () => {
  const gate = phase8LearningStep.llm!.shouldRetryPreForm!;

  it('retries when the draft produced no usable entries (non-empty)', () => {
    expect(gate('prose, no learning json')).toBe(true);
  });

  it('does not retry on empty output', () => {
    expect(gate('')).toBe(false);
    expect(gate(null)).toBe(false);
  });

  it('does not retry when entries parsed', () => {
    const raw = '```json\n{"entries":[{"id":"x","title":"X","body":"b"}]}\n```';
    expect(gate(raw)).toBe(false);
  });
});

describe('parseLearningOutput op/targetId', () => {
  it('defaults op to insert when absent', () => {
    const entries = parseLearningOutput({ entries: [{ id: 'a', title: 'A', body: 'b' }] });
    expect(entries).toHaveLength(1);
    expect(entries![0]).toMatchObject({ id: 'a', op: 'insert' });
    expect(entries![0].targetId).toBeUndefined();
  });

  it('parses an update op + targetId', () => {
    const entries = parseLearningOutput({
      entries: [{ op: 'update', targetId: 'old', title: 'A', body: 'b' }],
    });
    expect(entries![0]).toMatchObject({ op: 'update', targetId: 'old' });
  });

  it('keeps a delete that has only a targetId (no body)', () => {
    const entries = parseLearningOutput({ entries: [{ op: 'delete', targetId: 'gone' }] });
    expect(entries).toHaveLength(1);
    expect(entries![0]).toMatchObject({ op: 'delete', id: 'gone', targetId: 'gone' });
  });

  it('falls back to insert for an unknown op and drops a bodyless insert', () => {
    expect(parseLearningOutput({ entries: [{ op: 'frob', title: 'A', body: 'b' }] })![0].op).toBe(
      'insert',
    );
    expect(parseLearningOutput({ entries: [{ op: 'insert', title: 'A' }] })).toHaveLength(0);
  });
});

describe('planLearningReconciliation', () => {
  const existing = [{ id: 'known', title: 'Known', body: '# Known\n\nold body' }];

  it('keeps an update whose targetId exists', () => {
    const entries = parseLearningOutput({
      entries: [{ op: 'update', targetId: 'known', title: 'New', body: 'new' }],
    })!;
    expect(planLearningReconciliation(entries, existing)).toEqual([
      {
        op: 'update',
        id: 'known',
        title: 'New',
        newBody: '# New\n\nnew',
        oldBody: '# Known\n\nold body',
      },
    ]);
  });

  it('downgrades an update with an unknown targetId to an insert', () => {
    const entries = parseLearningOutput({
      entries: [{ op: 'update', targetId: 'missing', title: 'New', body: 'new' }],
    })!;
    const plan = planLearningReconciliation(entries, existing);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ op: 'insert', id: 'new' });
  });

  it('drops a delete whose targetId is unknown and keeps a known one', () => {
    expect(
      planLearningReconciliation(
        parseLearningOutput({ entries: [{ op: 'delete', targetId: 'missing' }] })!,
        existing,
      ),
    ).toHaveLength(0);
    const keep = planLearningReconciliation(
      parseLearningOutput({ entries: [{ op: 'delete', targetId: 'known' }] })!,
      existing,
    );
    expect(keep[0]).toMatchObject({ op: 'delete', id: 'known', oldBody: '# Known\n\nold body' });
  });

  it('guards an insert whose slug collides with an existing learning', () => {
    const entries = parseLearningOutput({
      entries: [{ id: 'known', title: 'Known', body: 'fresh' }],
    })!;
    expect(planLearningReconciliation(entries, existing)[0]).toMatchObject({
      op: 'insert',
      id: 'known-2',
    });
  });

  it('disambiguates two inserts that share a slug in one batch', () => {
    const entries = parseLearningOutput({
      entries: [
        { title: 'Same', body: 'a' },
        { title: 'Same', body: 'b' },
      ],
    })!;
    expect(planLearningReconciliation(entries, []).map((p) => p.id)).toEqual(['same', 'same-2']);
  });
});

describe('learningOpsToDiffFiles', () => {
  it('maps ops to added/modified/deleted diff files', () => {
    const files = learningOpsToDiffFiles([
      { op: 'insert', id: 'a', title: 'A', newBody: 'na', oldBody: '' },
      { op: 'update', id: 'b', title: 'B', newBody: 'nb', oldBody: 'ob' },
      { op: 'delete', id: 'c', title: 'C', newBody: '', oldBody: 'oc' },
    ]);
    expect(files.map((f) => f.status)).toEqual(['added', 'modified', 'deleted']);
    expect(files[0]).toMatchObject({
      path: path.join('.claude', 'learnings', 'a.md'),
      oldContent: '',
      newContent: 'na',
    });
    expect(files[2]).toMatchObject({ oldContent: 'oc', newContent: '' });
  });
});

describe('applyLearningOps + readExistingLearnings', () => {
  it('inserts without overwriting a colliding file, updates the target, deletes by id', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'learn-'));
    try {
      const dir = path.join(ws, '.claude', 'learnings');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'dup.md'), '# Dup\n\nORIGINAL', 'utf8');
      await writeFile(path.join(dir, 'old.md'), '# Old\n\nold body', 'utf8');
      await writeFile(path.join(dir, 'gone.md'), '# Gone\n\nobsolete', 'utf8');

      const existing = await readExistingLearnings(ws);
      expect(existing.map((e) => e.id).sort()).toEqual(['dup', 'gone', 'old']);

      const entries = parseLearningOutput({
        entries: [
          { id: 'dup', title: 'Dup', body: 'NEW dup' },
          { op: 'update', targetId: 'old', title: 'Old', body: 'updated body' },
          { op: 'delete', targetId: 'gone' },
        ],
      })!;
      const plan = planLearningReconciliation(entries, existing);
      const res = await applyLearningOps(ws, plan, '');

      // collision-guarded insert wrote a new file and left the original untouched
      expect(await readFile(path.join(dir, 'dup.md'), 'utf8')).toBe('# Dup\n\nORIGINAL');
      expect(await readFile(path.join(dir, 'dup-2.md'), 'utf8')).toContain('NEW dup');
      // update overwrote the target
      expect(await readFile(path.join(dir, 'old.md'), 'utf8')).toContain('updated body');
      // delete removed the file
      await expect(readFile(path.join(dir, 'gone.md'), 'utf8')).rejects.toThrow();

      expect(res.deleted).toHaveLength(1);
      expect(res.written.some((w) => w.endsWith('dup-2.md'))).toBe(true);
      expect(res.written.some((w) => w.endsWith('old.md'))).toBe(true);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe('parseGlobalCandidates', () => {
  it('parses candidates, validates category, dedups ids', () => {
    const cands = parseGlobalCandidates({
      globalCandidates: [
        { title: 'Drupal hook pattern', category: 'best_practice', tech: 'drupal', body: 'a' },
        { title: 'Drupal hook pattern', category: 'bogus', tech: 'drupal', body: 'b' },
      ],
    });
    expect(cands).toHaveLength(2);
    expect(cands[0]).toMatchObject({
      id: 'drupal-hook-pattern',
      category: 'best_practice',
      tech: 'drupal',
    });
    // unknown category falls back to tech_pattern; colliding slug is disambiguated.
    expect(cands[1]!.category).toBe('tech_pattern');
    expect(cands[1]!.id).toBe('drupal-hook-pattern-2');
  });

  it('drops entries missing title, body, or tech', () => {
    const cands = parseGlobalCandidates({
      globalCandidates: [
        { title: '', tech: 'php', body: 'x' },
        { title: 'No body', tech: 'php', body: '   ' },
        { title: 'No tech', tech: '', body: 'x' },
        { title: 'Keep', tech: 'php', body: 'real' },
      ],
    });
    expect(cands).toHaveLength(1);
    expect(cands[0]!.title).toBe('Keep');
  });

  it('returns [] when no globalCandidates key or not an array', () => {
    expect(parseGlobalCandidates({ entries: [] })).toEqual([]);
    expect(parseGlobalCandidates({ globalCandidates: 'nope' })).toEqual([]);
    expect(parseGlobalCandidates(null)).toEqual([]);
  });

  it('parses from a fenced-json string', () => {
    const raw =
      'noise\n```json\n{"globalCandidates":[{"title":"T","category":"tech_pattern","tech":"mariadb","body":"B"}]}\n```\ntail';
    const cands = parseGlobalCandidates(raw);
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ title: 'T', tech: 'mariadb', category: 'tech_pattern' });
  });
});
