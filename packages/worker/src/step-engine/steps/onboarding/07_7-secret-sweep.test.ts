import { describe, it, expect } from 'vitest';
import { parseSecretFindings, secretSweepStep } from './07_7-secret-sweep.js';

const fenced = (body: unknown) => `\`\`\`json\n${JSON.stringify(body)}\n\`\`\``;

describe('parseSecretFindings', () => {
  it('parses a fenced report', () => {
    const findings = parseSecretFindings(
      fenced({
        findings: [
          {
            severity: 'critical',
            path: 'tests/fixtures/creds.json',
            line: 3,
            symbol: 'aws',
            kind: 'aws access key',
            cwe: 'cwe_798',
            issue: 'an AWS access key is committed',
            fix: 'rotate it, then purge it from history',
          },
        ],
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'critical',
      path: 'tests/fixtures/creds.json',
      line: 3,
      kind: 'aws access key',
      // normalized on the way in, so the credential-snippet rule can key on it
      cwe: 'CWE-798',
    });
  });

  it('rates an unrecognised severity high, not medium', () => {
    // This sweeper reports one kind of thing. Under-rating a live key costs the user
    // unboundedly; over-rating an inert one costs them a line they scroll past.
    const findings = parseSecretFindings(
      fenced({ findings: [{ severity: 'spicy', path: 'a.env', issue: 'token' }] }),
    );
    expect(findings[0]!.severity).toBe('high');
  });

  it('drops an entry with no location or no description', () => {
    const findings = parseSecretFindings(
      fenced({
        findings: [
          { severity: 'high', path: '', issue: 'somewhere' },
          { severity: 'high', path: 'a.env', issue: '' },
          { severity: 'high', path: 'b.env', issue: 'a token' },
        ],
      }),
    );
    expect(findings.map((f) => f.path)).toEqual(['b.env']);
  });

  it('does not read a JSON file it opened as its own report', () => {
    // Without the key guard, an empty array quoted out of some config parses as
    // "this repository is clean" — the one wrong answer this step must never give.
    expect(parseSecretFindings(fenced({ compilerOptions: { strict: true } }))).toEqual([]);
    expect(parseSecretFindings('I searched the tree and found nothing.')).toEqual([]);
    expect(parseSecretFindings(null)).toEqual([]);
  });
});

describe('secretSweepStep.form', () => {
  const form = (llmOutput: unknown) =>
    secretSweepStep.form!({} as never, { repoPath: '/repo', scannable: true }, llmOutput);

  it('renders no form for a clean repository, so onboarding flows through', () => {
    expect(form(fenced({ findings: [] }))).toBeNull();
  });

  it('renders one note per finding plus an acknowledgment, and never blocks', () => {
    const schema = form(
      fenced({
        findings: [
          { severity: 'critical', path: 'a.env', line: 2, kind: 'stripe key', issue: 'live key' },
          { severity: 'low', path: 'b.env', issue: 'stale token' },
        ],
      }),
    )!;
    expect(schema.fields.map((f) => f.type)).toEqual(['note', 'note', 'checkbox']);
    // Severity drives emphasis only; nothing here can stop the step.
    expect(schema.fields[0]).toMatchObject({ variant: 'warning' });
    expect(schema.fields[1]).toMatchObject({ variant: 'info' });
    expect(schema.fields[2]).toMatchObject({ id: 'acknowledged' });
    // Not required: ticking it is a note to the user, never a condition on continuing.
    expect(schema.fields[2]!.required).toBeFalsy();
  });

  it('says how many findings it did not list rather than silently dropping them', () => {
    const schema = form(
      fenced({
        findings: Array.from({ length: 30 }, (_, i) => ({
          severity: 'high',
          path: `f${i}.env`,
          issue: 'a token',
        })),
      }),
    )!;
    const truncated = schema.fields.find((f) => f.id === 'truncated');
    expect(truncated).toBeDefined();
    expect((truncated as { body: string }).body).toContain('5 further finding(s)');
  });
});

describe('secretSweepStep.apply', () => {
  const ctx = {
    taskId: 't1',
    taskStepId: 's1',
    round: 0,
    logger: { info: () => {}, warn: () => {} },
    db: {
      insert: () => ({
        values: () => ({ onConflictDoNothing: async () => undefined }),
      }),
    },
  } as never;

  it('reports swept:false when there was no readable tree', async () => {
    // "No tree to sweep" and "no secrets found" are different statements, and only one of
    // them is a clean bill of health.
    const out = await secretSweepStep.apply(ctx, {
      detected: { repoPath: '/gone', scannable: false },
      llmOutput: undefined,
    } as never);
    expect(out.swept).toBe(false);
    expect(out.counts.total).toBe(0);
  });

  it('counts the blocking-tier findings separately for the summary', async () => {
    const out = await secretSweepStep.apply(ctx, {
      detected: { repoPath: '/repo', scannable: true },
      llmOutput: fenced({
        findings: [
          { severity: 'critical', path: 'a.env', issue: 'k' },
          { severity: 'high', path: 'b.env', issue: 'k' },
          { severity: 'low', path: 'c.env', issue: 'k' },
        ],
      }),
    } as never);
    expect(out.swept).toBe(true);
    expect(out.counts).toEqual({ critical: 1, high: 1, total: 3 });
  });
});
