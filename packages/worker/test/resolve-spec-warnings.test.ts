import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logger } from '@haive/shared';
import { resolveSpecWarningsStep } from '../src/step-engine/steps/workflow/05a-resolve-spec-warnings.js';

const baseCtx = { logger: logger.child({ test: 'resolve-warnings' }) };

function detected(spec = 'SPEC BODY', findings = ['[WARN] goal_clarity: x']) {
  return {
    findings,
    warnCount: findings.filter((f) => f.startsWith('[WARN]')).length,
    errorCount: findings.filter((f) => f.startsWith('[ERROR]')).length,
    spec,
    specFilePath: '/haive/workdir/.haive/spec-review.md',
  };
}

describe('resolveSpecWarningsStep.apply', () => {
  it('continue: passes the 05 spec through unchanged', async () => {
    const out = (await resolveSpecWarningsStep.apply(
      baseCtx as never,
      {
        detected: detected('THE SPEC'),
        formValues: { action: 'continue' },
        iteration: 0,
        previousIterations: [],
      } as never,
    )) as { action: string; spec: string };
    expect(out).toMatchObject({ action: 'continue', spec: 'THE SPEC' });
  });

  it('agent: uses the fixing agent amendedSpec', async () => {
    const out = (await resolveSpecWarningsStep.apply(
      baseCtx as never,
      {
        detected: detected('OLD'),
        formValues: { action: 'agent' },
        llmOutput: '```json\n{"amendedSpec":"FIXED SPEC"}\n```',
        iteration: 0,
        previousIterations: [],
      } as never,
    )) as { action: string; spec: string };
    expect(out).toMatchObject({ action: 'agent', spec: 'FIXED SPEC' });
  });

  it('agent: falls back to the 05 spec when the agent output is unparseable', async () => {
    const out = (await resolveSpecWarningsStep.apply(
      baseCtx as never,
      {
        detected: detected('OLD'),
        formValues: { action: 'agent' },
        llmOutput: 'no json here',
        iteration: 0,
        previousIterations: [],
      } as never,
    )) as { spec: string };
    expect(out.spec).toBe('OLD');
  });

  it('manual: reads the edited spec file back from the workspace', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'haive-spec-'));
    try {
      await mkdir(path.join(dir, '.haive'), { recursive: true });
      await writeFile(path.join(dir, '.haive', 'spec-review.md'), 'EDITED BY USER', 'utf8');
      const out = (await resolveSpecWarningsStep.apply(
        { ...baseCtx, repoPath: dir } as never,
        {
          detected: detected('OLD'),
          formValues: { action: 'manual' },
          iteration: 0,
          previousIterations: [],
        } as never,
      )) as { action: string; spec: string };
      expect(out).toMatchObject({ action: 'manual', spec: 'EDITED BY USER' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('manual: falls back to the 05 spec when the file is missing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'haive-spec-'));
    try {
      const out = (await resolveSpecWarningsStep.apply(
        { ...baseCtx, repoPath: dir } as never,
        {
          detected: detected('FALLBACK'),
          formValues: { action: 'manual' },
          iteration: 0,
          previousIterations: [],
        } as never,
      )) as { spec: string };
      expect(out.spec).toBe('FALLBACK');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveSpecWarningsStep form + llm gating', () => {
  it('offers continue/manual/agent and surfaces the spec file path', () => {
    const fs = resolveSpecWarningsStep.form!(
      {} as never,
      detected('S', ['[WARN] d: c', '[ERROR] e: g']),
    );
    const action = fs.fields.find((f) => f.id === 'action') as
      | { type: string; options: { value: string }[] }
      | undefined;
    expect(action?.type).toBe('radio');
    expect(action?.options.map((o) => o.value)).toEqual(['continue', 'manual', 'agent']);
    expect(fs.description).toContain('/haive/workdir/.haive/spec-review.md');
  });

  it('llm.skipIf runs the fixing agent only when action=agent', () => {
    const skip = resolveSpecWarningsStep.llm!.skipIf!;
    expect(skip({ formValues: { action: 'continue' } } as never)).toBe(true);
    expect(skip({ formValues: { action: 'manual' } } as never)).toBe(true);
    expect(skip({ formValues: { action: 'agent' } } as never)).toBe(false);
  });
});
