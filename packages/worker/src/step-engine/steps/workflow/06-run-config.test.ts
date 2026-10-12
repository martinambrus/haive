import { describe, it, expect } from 'vitest';
import { runConfigStep } from './06-run-config.js';

// The run-config form is pure given `detected`, so it can be exercised directly.
// These lock the path-aware gating: browser fields are dead UI when 08a is filtered
// out, but the QA-level control must SURVIVE (08c-code-review reads the level for its
// extra review lenses even when the 08d adversarial agents don't run) — only relabelled.
describe('06-run-config path-aware fields', () => {
  const detect = (overrides: Record<string, unknown>) =>
    ({
      specBody: 'spec',
      ddevMode: true,
      appRunnerMode: false,
      taskAdversarialQaLevel: null,
      taskMaxFixRounds: 5,
      runsBrowserVerify: true,
      runsAdversarialQa: true,
      ...overrides,
    }) as never;

  const fields = (detected: never) => runConfigStep.form!({} as never, detected, null)!.fields;
  const fieldIds = (detected: never) => fields(detected).map((f) => f.id);
  const field = (detected: never, id: string) => fields(detected).find((f) => f.id === id);

  it('full_workflow shows browser fields and the Phase-7 QA label', () => {
    const d = detect({ runsBrowserVerify: true, runsAdversarialQa: true });
    expect(fieldIds(d)).toContain('browserMode');
    expect(field(d, 'adversarialQaLevel')?.label).toBe('Adversarial QA (Phase 7)');
  });

  it('omits the browser fields when 08a is filtered out (e.g. plan_tasklist)', () => {
    const ids = fieldIds(detect({ runsBrowserVerify: false, runsAdversarialQa: false }));
    expect(ids).not.toContain('browserMode');
  });

  it('keeps but relabels the QA-level control when 08d is filtered out', () => {
    const d = detect({ runsBrowserVerify: false, runsAdversarialQa: false });
    expect(fieldIds(d)).toContain('adversarialQaLevel'); // 08c still consumes it — must not vanish
    expect(field(d, 'adversarialQaLevel')?.label).toBe('Code review depth');
  });
});

describe('06-run-config declared verify commands', () => {
  const detected = (extra: Record<string, unknown>) =>
    ({
      specBody: 'spec',
      ddevMode: false,
      appRunnerMode: false,
      taskAdversarialQaLevel: null,
      taskMaxFixRounds: 5,
      runsBrowserVerify: true,
      runsAdversarialQa: true,
      ...extra,
    }) as never;
  const note = (d: never) =>
    runConfigStep.form!({} as never, d, null)!.fields.find(
      (f) => f.id === 'declaredVerifyCommands',
    );

  it('lists the declared commands and the slots that are off, read-only', () => {
    const field = note(detected({ verifyCommands: { test: 'make test', lint: null } })) as {
      type: string;
      body: string;
    };
    expect(field.type).toBe('note');
    expect(field.body).toContain('test: make test\nlint: (turned off)');
    expect(field.body).not.toContain('typecheck');
  });

  it('keeps a command that holds backticks inside one fence', () => {
    const field = note(detected({ verifyCommands: { test: 'echo ```id```' } })) as { body: string };
    expect(field.body).toContain('````\ntest: echo ```id```\n````');
  });

  it('shows nothing when none is declared, and for a payload without the field', () => {
    expect(note(detected({}))).toBeUndefined();
    expect(note(detected({ verifyCommands: {} }))).toBeUndefined();
  });
});
