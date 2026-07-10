import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { hasFileLineEvidence } from './_review-findings.js';
import {
  parseGlobalCandidates,
  parseInvestigation,
  parseKbSync,
  parseSkillSync,
  parseLearningOutput,
  writeInvestigation,
  phase8LearningStep,
  planLearningReconciliation,
  learningOpsToDiffFiles,
  applyLearningOps,
  readExistingLearnings,
} from './11-phase-8-learning.js';

describe('KB admission bar', () => {
  describe('hasFileLineEvidence', () => {
    it('accepts a concrete path:line citation anywhere in the text', () => {
      expect(hasFileLineEvidence('packages/worker/src/step-runner.ts:1392')).toBe(true);
      expect(hasFileLineEvidence('see `src/a.ts:42` for the guard')).toBe(true);
      expect(hasFileLineEvidence('composer.json:12')).toBe(true);
      expect(hasFileLineEvidence('config/sync/system.site.yml:3')).toBe(true);
    });

    it('rejects text that only looks like a citation', () => {
      // An extension must start with a letter, so a version or a clock time is not evidence.
      expect(hasFileLineEvidence('upgrade to version 1.2:30')).toBe(false);
      expect(hasFileLineEvidence('at 12:30 the build failed')).toBe(false);
      expect(hasFileLineEvidence('see the file src/a.ts')).toBe(false); // no line
      expect(hasFileLineEvidence('Always validate your inputs.')).toBe(false);
    });

    it('accepts a citation in any of the texts, and rejects absent ones', () => {
      expect(hasFileLineEvidence('generic prose', 'src/a.ts:9')).toBe(true);
      expect(hasFileLineEvidence(undefined, null)).toBe(false);
    });
  });

  describe('learning entries', () => {
    it('drops a lesson that cites no file and line', () => {
      // The shape both unenforceable rules take: a lesson CI would catch, and one the
      // model knew before the run, each have nothing in THIS run to point at.
      const entries = parseLearningOutput({
        entries: [
          { id: 'generic', title: 'Validate inputs', body: 'Always validate user input.' },
          { id: 'ci', title: 'Run the linter', body: 'Unused imports should be removed.' },
        ],
      });
      expect(entries).toEqual([]);
    });

    it('keeps a lesson cited in its body, so the citation survives into the artifact', () => {
      const entries = parseLearningOutput({
        entries: [
          {
            id: 'real',
            title: 'Zod 4 z.unknown() is non-optional',
            body: 'A bare `z.unknown()` inside `z.object()` fails on a missing key — see packages/worker/src/step-engine/steps/workflow/08c-code-review.ts:102.',
          },
        ],
      });
      expect(entries).toHaveLength(1);
      expect(entries![0]!.id).toBe('real');
    });

    it('accepts a separate evidence field when the body omits the citation', () => {
      const entries = parseLearningOutput({
        entries: [{ id: 'x', title: 'X', body: 'a lesson', evidence: 'src/a.ts:7' }],
      });
      expect(entries).toHaveLength(1);
    });

    it('never demands evidence of a delete — it cites only its targetId', () => {
      const entries = parseLearningOutput({ entries: [{ op: 'delete', targetId: 'gone' }] });
      expect(entries).toHaveLength(1);
      expect(entries![0]!.op).toBe('delete');
    });

    it('re-rolls the draft when the bar leaves no entries', () => {
      // shouldRetryPreForm sees zero usable entries and asks for a fresh, grounded draft
      // rather than parking an empty one in front of the human.
      const gate = phase8LearningStep.llm!.shouldRetryPreForm!;
      expect(gate('```json\n{"entries":[{"id":"g","title":"G","body":"Be careful."}]}\n```')).toBe(
        true,
      );
    });
  });

  describe('global candidates', () => {
    it('drops a candidate with no evidence field', () => {
      // Its body must stay portable, so a citation cannot live there — it needs its own.
      expect(
        parseGlobalCandidates({
          globalCandidates: [{ title: 'T', tech: 'php', body: 'portable article' }],
        }),
      ).toEqual([]);
    });

    it('keeps a cited candidate and never leaks the citation into the portable body', () => {
      const cands = parseGlobalCandidates({
        globalCandidates: [
          { title: 'T', tech: 'php', body: 'portable article', evidence: 'src/a.ts:3' },
        ],
      });
      expect(cands).toHaveLength(1);
      expect(cands[0]!.body).toBe('portable article');
      expect(cands[0]).not.toHaveProperty('evidence');
    });

    it('rejects an evidence field that is not a real citation', () => {
      expect(
        parseGlobalCandidates({
          globalCandidates: [{ title: 'T', tech: 'php', body: 'x', evidence: 'the docs say so' }],
        }),
      ).toEqual([]);
    });
  });
});

describe('parseSkillSync', () => {
  const existing = new Set(['fleet-search', 'boat-catalogue']);

  it('parses new_feature (capability) and update/removal (existing skillId)', () => {
    const ops = parseSkillSync(
      {
        skillSync: {
          ops: [
            { op: 'new_feature', capability: 'Daily Rental', rationale: 'adds rentals' },
            { op: 'feature_update', skillId: 'fleet-search', rationale: 'search changed' },
            { op: 'feature_removal', skillId: 'boat-catalogue', rationale: 'gone' },
          ],
        },
      },
      existing,
    );
    expect(ops).toHaveLength(3);
    expect(ops[0]).toEqual({
      op: 'new_feature',
      capability: 'Daily Rental',
      rationale: 'adds rentals',
    });
    expect(ops[1]).toEqual({
      op: 'feature_update',
      skillId: 'fleet-search',
      rationale: 'search changed',
    });
    expect(ops[2]!.op).toBe('feature_removal');
  });

  it('drops an update/removal whose skillId is not an existing skill', () => {
    const ops = parseSkillSync(
      {
        skillSync: {
          ops: [
            { op: 'feature_update', skillId: 'does-not-exist', rationale: 'x' },
            { op: 'feature_removal', skillId: 'also-missing', rationale: 'y' },
          ],
        },
      },
      existing,
    );
    expect(ops).toEqual([]);
  });

  it('drops a new_feature without a capability and any unknown op', () => {
    const ops = parseSkillSync(
      {
        skillSync: {
          ops: [
            { op: 'new_feature', rationale: 'no capability' },
            { op: 'frobnicate', skillId: 'fleet-search' },
          ],
        },
      },
      existing,
    );
    expect(ops).toEqual([]);
  });

  it('parses a fenced JSON string, tolerates the skill_sync alias, and returns [] when absent', () => {
    const ops = parseSkillSync(
      '```json\n{"skill_sync":{"ops":[{"op":"feature_update","skillId":"fleet-search","rationale":"z"}]}}\n```',
      existing,
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]!.skillId).toBe('fleet-search');
    expect(parseSkillSync({ entries: [] }, existing)).toEqual([]);
    expect(parseSkillSync(null, existing)).toEqual([]);
  });
});

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

describe('phase8LearningStep apply refine/accept routing', () => {
  it('records a refine instruction (trimmed) and returns refineRequested without writing', async () => {
    const events: { eventType: string; payload: { instruction?: string } }[] = [];
    const ctx = {
      db: {
        insert: () => ({
          values: async (v: { eventType: string; payload: { instruction?: string } }) => {
            events.push(v);
          },
        }),
      },
      taskId: 't1',
      taskStepId: 's1',
      userId: 'u1',
      logger: { info: () => {}, warn: () => {} },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const out = await phase8LearningStep.apply(ctx, {
      formValues: { instruction: '  limit the DDEV article to v1.25.2  ' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(out.refineRequested).toBe(true);
    expect(out.written).toEqual([]);
    expect(out.promotedCandidates).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('learning.refine');
    expect(events[0]!.payload.instruction).toBe('limit the DDEV article to v1.25.2');
  });

  it('reviseLoop self-targets step 11 on refineRequested, else finalizes', () => {
    const evaluate = phase8LearningStep.reviseLoop!.evaluate;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(evaluate({ refineRequested: true } as any)).toEqual({
      targetStepId: '11-phase-8-learning',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(evaluate({ refineRequested: false } as any)).toBeNull();
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
    const raw = '```json\n{"entries":[{"id":"x","title":"X","body":"b src/a.ts:1"}]}\n```';
    expect(gate(raw)).toBe(false);
  });
});

describe('parseLearningOutput op/targetId', () => {
  it('defaults op to insert when absent', () => {
    const entries = parseLearningOutput({
      entries: [{ id: 'a', title: 'A', body: 'b src/a.ts:1' }],
    });
    expect(entries).toHaveLength(1);
    expect(entries![0]).toMatchObject({ id: 'a', op: 'insert' });
    expect(entries![0].targetId).toBeUndefined();
  });

  it('parses an update op + targetId', () => {
    const entries = parseLearningOutput({
      entries: [{ op: 'update', targetId: 'old', title: 'A', body: 'b src/a.ts:1' }],
    });
    expect(entries![0]).toMatchObject({ op: 'update', targetId: 'old' });
  });

  it('keeps a delete that has only a targetId (no body)', () => {
    const entries = parseLearningOutput({ entries: [{ op: 'delete', targetId: 'gone' }] });
    expect(entries).toHaveLength(1);
    expect(entries![0]).toMatchObject({ op: 'delete', id: 'gone', targetId: 'gone' });
  });

  it('falls back to insert for an unknown op and drops a bodyless insert', () => {
    expect(
      parseLearningOutput({ entries: [{ op: 'frob', title: 'A', body: 'b src/a.ts:1' }] })![0].op,
    ).toBe('insert');
    expect(parseLearningOutput({ entries: [{ op: 'insert', title: 'A' }] })).toHaveLength(0);
  });
});

describe('planLearningReconciliation', () => {
  const existing = [{ id: 'known', title: 'Known', body: '# Known\n\nold body' }];

  it('keeps an update whose targetId exists', () => {
    const entries = parseLearningOutput({
      entries: [{ op: 'update', targetId: 'known', title: 'New', body: 'new src/a.ts:1' }],
    })!;
    expect(planLearningReconciliation(entries, existing)).toEqual([
      {
        op: 'update',
        id: 'known',
        title: 'New',
        newBody: '# New\n\nnew src/a.ts:1',
        oldBody: '# Known\n\nold body',
      },
    ]);
  });

  it('downgrades an update with an unknown targetId to an insert', () => {
    const entries = parseLearningOutput({
      entries: [{ op: 'update', targetId: 'missing', title: 'New', body: 'new src/a.ts:1' }],
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
      entries: [{ id: 'known', title: 'Known', body: 'fresh src/a.ts:1' }],
    })!;
    expect(planLearningReconciliation(entries, existing)[0]).toMatchObject({
      op: 'insert',
      id: 'known-2',
    });
  });

  it('disambiguates two inserts that share a slug in one batch', () => {
    const entries = parseLearningOutput({
      entries: [
        { title: 'Same', body: 'a src/a.ts:1' },
        { title: 'Same', body: 'b src/b.ts:2' },
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
          { id: 'dup', title: 'Dup', body: 'NEW dup src/a.ts:1' },
          { op: 'update', targetId: 'old', title: 'Old', body: 'updated body src/b.ts:2' },
          { op: 'delete', targetId: 'gone' },
        ],
      })!;
      const plan = planLearningReconciliation(entries, existing);
      const res = await applyLearningOps(ws, plan);

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
        {
          title: 'Drupal hook pattern',
          category: 'best_practice',
          tech: 'drupal',
          body: 'a',
          evidence: 'src/a.ts:1',
        },
        {
          title: 'Drupal hook pattern',
          category: 'bogus',
          tech: 'drupal',
          body: 'b',
          evidence: 'src/b.ts:2',
        },
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
        { title: '', tech: 'php', body: 'x', evidence: 'src/a.ts:1' },
        { title: 'No body', tech: 'php', body: '   ', evidence: 'src/a.ts:1' },
        { title: 'No tech', tech: '', body: 'x', evidence: 'src/a.ts:1' },
        { title: 'Keep', tech: 'php', body: 'real', evidence: 'src/a.ts:1' },
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
      'noise\n```json\n{"globalCandidates":[{"title":"T","category":"tech_pattern","tech":"mariadb","body":"B","evidence":"src/a.ts:1"}]}\n```\ntail';
    const cands = parseGlobalCandidates(raw);
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ title: 'T', tech: 'mariadb', category: 'tech_pattern' });
  });
});
