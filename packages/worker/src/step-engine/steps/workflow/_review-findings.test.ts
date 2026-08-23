import { describe, it, expect } from 'vitest';
import {
  acceptRemainingReviewFindings,
  dispositionReviewFindings,
  findingFingerprint,
  parseLineRange,
  recordReviewFindings,
  splitLocation,
  type RecordableFinding,
} from './_review-findings.js';
import type { Database } from '@haive/database';
import type { StepContext } from '../../step-definition.js';

describe('findingFingerprint', () => {
  it('hashes the same defect equal after line numbers move', () => {
    const a = findingFingerprint('peer-reviewer', 'src/a.ts', 'Null deref at line 42');
    const b = findingFingerprint('peer-reviewer', 'src/a.ts', 'Null deref at line 87');
    expect(a).toBe(b);
  });

  it('keeps the path as part of the identity', () => {
    // Unlike fixLoopFingerprint, which strips paths out of a prose diagnosis: the
    // same defect in two files is two findings.
    const a = findingFingerprint('peer-reviewer', 'src/a.ts', 'null deref');
    const b = findingFingerprint('peer-reviewer', 'src/b.ts', 'null deref');
    expect(a).not.toBe(b);
  });

  it('namespaces by reviewer, so two reviewers naming the same issue do not collide', () => {
    const peer = findingFingerprint('peer-reviewer', 'src/a.ts', 'unsanitised input');
    const sec = findingFingerprint('security-code-reviewer', 'src/a.ts', 'unsanitised input');
    expect(peer).not.toBe(sec);
  });

  it('is insensitive to case, whitespace and embedded uuids', () => {
    const a = findingFingerprint('peer-reviewer', 'src/a.ts', 'Null   Deref');
    const b = findingFingerprint('peer-reviewer', 'SRC/A.TS', 'null deref');
    expect(a).toBe(b);
    const withUuid = findingFingerprint(
      'peer-reviewer',
      'src/a.ts',
      'task 3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed',
    );
    const withoutUuid = findingFingerprint('peer-reviewer', 'src/a.ts', 'task  failed');
    expect(withUuid).toBe(withoutUuid);
  });

  it('fits the fingerprint column', () => {
    expect(findingFingerprint('peer-reviewer', 'a.ts', 'x').length).toBeLessThanOrEqual(64);
  });
});

describe('parseLineRange', () => {
  it('reads a single line, a range, and a number', () => {
    expect(parseLineRange('12')).toEqual({ start: 12, end: 12 });
    expect(parseLineRange('12-18')).toEqual({ start: 12, end: 18 });
    expect(parseLineRange(7)).toEqual({ start: 7, end: 7 });
  });

  it('yields nulls when absent or unparseable', () => {
    expect(parseLineRange(undefined)).toEqual({ start: null, end: null });
    expect(parseLineRange(null)).toEqual({ start: null, end: null });
    expect(parseLineRange('somewhere near the top')).toEqual({ start: null, end: null });
  });
});

describe('splitLocation', () => {
  it('splits path:line and path:line:col', () => {
    expect(splitLocation('src/a.ts:42')).toEqual({ path: 'src/a.ts', lines: '42' });
    expect(splitLocation('src/a.ts:42:7')).toEqual({ path: 'src/a.ts', lines: '42' });
    expect(splitLocation('src/a.ts:12-18')).toEqual({ path: 'src/a.ts', lines: '12-18' });
  });

  it('leaves a bare path alone', () => {
    expect(splitLocation('src/a.ts')).toEqual({ path: 'src/a.ts', lines: null });
  });

  it('keeps a URL whole — 08d reports runtime findings by URL, not file', () => {
    expect(splitLocation('https://app.ddev.site:8443/admin')).toEqual({
      path: 'https://app.ddev.site:8443/admin',
      lines: null,
    });
  });

  it('handles absent locations', () => {
    expect(splitLocation(undefined)).toEqual({ path: '', lines: null });
    expect(splitLocation('')).toEqual({ path: '', lines: null });
  });
});

describe('recordReviewFindings — credential snippets', () => {
  /** Captures the rows the insert would have written. */
  function captureCtx(): { ctx: StepContext; rows: Record<string, unknown>[] } {
    const rows: Record<string, unknown>[] = [];
    const ctx = {
      taskId: 'task-1',
      taskStepId: 'step-1',
      round: 0,
      logger: { warn: () => {} },
      db: {
        insert: () => ({
          values: (values: Record<string, unknown>[]) => {
            rows.push(...values);
            return { onConflictDoNothing: () => Promise.resolve() };
          },
        }),
      },
    } as unknown as StepContext;
    return { ctx, rows };
  }

  const finding = (over: Partial<RecordableFinding>): RecordableFinding => ({
    reviewerId: 'security-code-reviewer',
    severity: 'high',
    issue: 'an issue',
    path: 'src/a.ts',
    lines: '12',
    ...over,
  });

  it('drops the quoted line of a hard-coded-credential finding', async () => {
    // The line such a finding quotes as evidence IS the credential; path + line locate
    // the code without it, so persisting it only writes the secret to a second place.
    const { ctx, rows } = captureCtx();
    await recordReviewFindings(ctx, '08c-code-review', [
      finding({ raw: { cwe: 'CWE-798', snippet: 'AKIAIOSFODNN7EXAMPLE', issue: 'aws key' } }),
    ]);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.raw as Record<string, unknown>).snippet).toBe('');
    // Everything else survives — the finding is still fully locatable and actionable.
    expect((rows[0]!.raw as Record<string, unknown>).cwe).toBe('CWE-798');
    expect(rows[0]!.path).toBe('src/a.ts');
    expect(rows[0]!.lineStart).toBe(12);
  });

  it('keeps the snippet for a weakness whose evidence is ordinary code', async () => {
    const { ctx, rows } = captureCtx();
    await recordReviewFindings(ctx, '08c-code-review', [
      finding({ raw: { cwe: 'CWE-89', snippet: 'db.query("SELECT " + name)' } }),
    ]);
    expect((rows[0]!.raw as Record<string, unknown>).snippet).toBe('db.query("SELECT " + name)');
  });

  it('drops the snippet for the secret sweeper whatever CWE it names', async () => {
    // The sweeper looks for nothing but credentials, so its snippet is a secret by
    // construction — the redaction must not depend on the model naming a CWE.
    const { ctx, rows } = captureCtx();
    await recordReviewFindings(ctx, '07_7-secret-sweep', [
      finding({ reviewerId: 'secret-sweeper', raw: { snippet: 'ghp_realtokenvalue' } }),
    ]);
    expect((rows[0]!.raw as Record<string, unknown>).snippet).toBe('');
  });

  it('leaves a finding that carries no snippet untouched', async () => {
    const { ctx, rows } = captureCtx();
    await recordReviewFindings(ctx, '08c-code-review', [
      finding({ raw: { cwe: 'CWE-798', attack: 'reuse the key' } }),
    ]);
    expect(rows[0]!.raw).toEqual({ cwe: 'CWE-798', attack: 'reuse the key' });
  });

  it('records nothing but null when the finding carried no raw at all', async () => {
    const { ctx, rows } = captureCtx();
    await recordReviewFindings(ctx, '08c-code-review', [finding({})]);
    expect(rows[0]!.raw).toBeNull();
  });
});

describe('recordReviewFindings — invocation attribution', () => {
  function captureCtx(): { ctx: StepContext; rows: Record<string, unknown>[] } {
    const rows: Record<string, unknown>[] = [];
    const ctx = {
      taskId: 'task-1',
      taskStepId: 'step-1',
      round: 0,
      logger: { warn: () => {} },
      db: {
        insert: () => ({
          values: (values: Record<string, unknown>[]) => {
            rows.push(...values);
            return { onConflictDoNothing: () => Promise.resolve() };
          },
        }),
      },
    } as unknown as StepContext;
    return { ctx, rows };
  }

  const base: RecordableFinding = {
    reviewerId: 'security-code-reviewer',
    severity: 'high',
    issue: 'an issue',
    path: 'src/a.ts',
    lines: '12',
  };

  it('persists the invocation the finding came from', async () => {
    // The only DURABLE finding -> model link: a retry deletes task_step_agent_minings but
    // only supersedes cli_invocations and leaves review_findings alone.
    const { ctx, rows } = captureCtx();
    await recordReviewFindings(ctx, '08c-code-review', [{ ...base, cliInvocationId: 'inv-abc' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cliInvocationId).toBe('inv-abc');
  });

  it('writes null rather than undefined when the caller cannot name one', async () => {
    // A caller that genuinely has no single invocation leaves it unset; the column is
    // nullable and the row must still be written.
    const { ctx, rows } = captureCtx();
    await recordReviewFindings(ctx, '08c-code-review', [base]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cliInvocationId).toBeNull();
  });

  it('attributes each reviewer separately in one batch', async () => {
    const { ctx, rows } = captureCtx();
    await recordReviewFindings(ctx, '08c-code-review', [
      { ...base, reviewerId: 'peer-reviewer', cliInvocationId: 'inv-peer' },
      { ...base, reviewerId: 'security-code-reviewer', cliInvocationId: 'inv-sec' },
    ]);
    expect(rows.map((r) => [r.reviewerId, r.cliInvocationId])).toEqual([
      ['peer-reviewer', 'inv-peer'],
      ['security-code-reviewer', 'inv-sec'],
    ]);
  });
});

describe('dispositionReviewFindings', () => {
  function captureCtx(): { ctx: StepContext; sets: Record<string, unknown>[]; calls: number } {
    const sets: Record<string, unknown>[] = [];
    const state = { calls: 0 };
    const ctx = {
      taskId: 'task-1',
      taskStepId: 'step-1',
      round: 3,
      logger: { warn: () => {} },
      db: {
        update: () => {
          state.calls += 1;
          return {
            set: (values: Record<string, unknown>) => {
              sets.push(values);
              return { where: () => Promise.resolve() };
            },
          };
        },
      },
    } as unknown as StepContext;
    return {
      ctx,
      sets,
      get calls() {
        return state.calls;
      },
    };
  }

  it('writes the verdict and its source', async () => {
    const cap = captureCtx();
    await dispositionReviewFindings(cap.ctx, ['fp-a', 'fp-b'], 'dismissed_human', '08d2');
    expect(cap.sets).toHaveLength(1);
    expect(cap.sets[0]!.disposition).toBe('dismissed_human');
    expect(cap.sets[0]!.dispositionSource).toBe('08d2');
    expect(cap.sets[0]!.dispositionAt).toBeInstanceOf(Date);
  });

  it('does not touch the table when there is nothing to mark', async () => {
    // An empty list means the caller waived a finding whose rows predate fingerprint
    // carrying — an unfiltered UPDATE there would rewrite the whole round.
    const cap = captureCtx();
    await dispositionReviewFindings(cap.ctx, [], 'dismissed_human', '08d2');
    await dispositionReviewFindings(cap.ctx, [''], 'dismissed_human', '08d2');
    expect(cap.calls).toBe(0);
  });

  it('never throws — telemetry must not fail the gate that produced it', async () => {
    const ctx = {
      taskId: 'task-1',
      round: 0,
      logger: { warn: () => {} },
      db: {
        update: () => {
          throw new Error('db down');
        },
      },
    } as unknown as StepContext;
    await expect(
      dispositionReviewFindings(ctx, ['fp-a'], 'dismissed_human', '08d2'),
    ).resolves.toBeUndefined();
  });
});

describe('acceptRemainingReviewFindings', () => {
  function captureDb(): { db: Database; sets: Record<string, unknown>[] } {
    const sets: Record<string, unknown>[] = [];
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          sets.push(values);
          return { where: () => Promise.resolve() };
        },
      }),
    } as unknown as Database;
    return { db, sets };
  }

  it('records the acceptance as a decision, not a pending state', async () => {
    const { db, sets } = captureDb();
    await acceptRemainingReviewFindings(db, 'task-1', 3, 'fix-loop-gate');
    expect(sets).toHaveLength(1);
    expect(sets[0]!.disposition).toBe('accepted_risk');
    expect(sets[0]!.dispositionSource).toBe('fix-loop-gate');
    expect(sets[0]!.dispositionAt).toBeInstanceOf(Date);
  });

  it('never throws — the gate decision stands even if the write fails', async () => {
    const db = {
      update: () => {
        throw new Error('db down');
      },
    } as unknown as Database;
    await expect(
      acceptRemainingReviewFindings(db, 'task-1', 0, 'fix-loop-gate'),
    ).resolves.toBeUndefined();
  });
});
