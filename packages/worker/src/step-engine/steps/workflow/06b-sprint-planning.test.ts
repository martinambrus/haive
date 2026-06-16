import { describe, it, expect } from 'vitest';
import { parseSprintPlan, sprintPlanningStep } from './06b-sprint-planning.js';

describe('06b sprint-planning form (single mode)', () => {
  it('surfaces the single-agent decision + rationale instead of returning null', () => {
    const schema = sprintPlanningStep.form!(undefined as never, undefined as never, {
      mode: 'single',
      rationale: 'change is small and tightly coupled',
      max_parallel: 1,
      issues: [],
      levels: [],
    });
    expect(schema).not.toBeNull();
    // No decision fields (nothing to confirm), but the rationale IS shown so the
    // user isn't left with a bare "Continue".
    expect(schema!.fields).toHaveLength(0);
    expect(schema!.infoSections?.[0]?.body).toContain('tightly coupled');
    // Flows through even in manual mode (nothing to decide).
    expect(schema!.autoSubmit).toBe(true);
  });
});

describe('parseSprintPlan', () => {
  it('parses a fenced single-mode plan ignoring surrounding prose', () => {
    const raw =
      'Here is my decision:\n```json\n{"mode":"single","rationale":"simple","max_parallel":1,"issues":[],"levels":[]}\n```\nthanks';
    const p = parseSprintPlan(raw);
    expect(p.mode).toBe('single');
    expect(p.issues).toEqual([]);
    expect(p.levels).toEqual([]);
  });

  it('parses a fenced dag plan with issues + levels', () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        mode: 'dag',
        rationale: 'complex',
        max_parallel: 2,
        issues: [
          { id: 'ISSUE-001', title: 'A', depends_on: [], level: 0 },
          { id: 'ISSUE-002', title: 'B', depends_on: ['ISSUE-001'], level: 1 },
        ],
        levels: [['ISSUE-001'], ['ISSUE-002']],
      }) +
      '\n```';
    const p = parseSprintPlan(raw);
    expect(p.mode).toBe('dag');
    expect(p.issues).toHaveLength(2);
    expect(p.levels).toEqual([['ISSUE-001'], ['ISSUE-002']]);
    expect(p.issues[0]!.id).toBe('ISSUE-001');
  });

  it('accepts an already-parsed object (bypass stub shape)', () => {
    const p = parseSprintPlan({
      mode: 'single',
      rationale: 'stub',
      max_parallel: 1,
      issues: [],
      levels: [],
    });
    expect(p.mode).toBe('single');
  });

  it('falls back to single-agent on garbled or empty output', () => {
    expect(parseSprintPlan('no json here').mode).toBe('single');
    expect(parseSprintPlan('```json\n{not valid}\n```').mode).toBe('single');
    expect(parseSprintPlan(null).mode).toBe('single');
    expect(parseSprintPlan(undefined).mode).toBe('single');
  });

  it('applies schema defaults for omitted issue fields', () => {
    const raw = '```json\n{"mode":"dag","issues":[{"id":"X","title":"t"}],"levels":[["X"]]}\n```';
    const p = parseSprintPlan(raw);
    expect(p.issues[0]!.depends_on).toEqual([]);
    expect(p.issues[0]!.level).toBe(0);
    expect(p.issues[0]!.spec_sections).toEqual([]);
    expect(p.max_parallel).toBe(1);
  });
});
