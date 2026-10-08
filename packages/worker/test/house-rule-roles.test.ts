import { describe, expect, it } from 'vitest';
import { HOUSE_RULE_EXEMPT, HOUSE_RULE_ROLES } from '@haive/shared';
import { StepRegistry } from '../src/step-engine/registry.js';
import { registerAllSteps } from '../src/step-engine/steps/index.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

const registry = new StepRegistry();
registerAllSteps(registry);
const byId = new Map(registry.all().map((def) => [def.metadata.id, def]));

// The roles dag-executor.ts resolves a provider under.
const DAG_ROLES = ['default', 'coder', 'reviewer', 'issue_advisor', 'replanner'];

const declaresFileWrite = (def: StepDefinition): boolean =>
  [def.metadata, def.llm, def.agentMining, def.dagExecute, def.mergeResolve].some((spec) =>
    spec?.requiredCapabilities?.includes('file_write'),
  );

const rolesOf = (def: StepDefinition): string[] =>
  def.dagExecute ? DAG_ROLES : (def.metadata.cliRoles?.map((role) => role.id) ?? ['default']);

const FILE_WRITERS = [
  '00a-sync-base',
  '01-plan-merge',
  '06c-dag-execute',
  '07-phase-2-implement',
  '07a-code-simplify',
  '07b-phase-4-validate',
  '08a-browser-verify',
  '08b-test-management',
  '08e-insights-triage',
  '09_5-skill-generation',
  '09_5b-skill-repair',
  '11d-skill-sync',
  '12-worktree-cleanup',
  '13-onboarding-push',
];

describe('house rule roles', () => {
  const writers = [...byId.values()].filter(declaresFileWrite);

  it('finds the steps that declare file_write', () => {
    expect(writers.map((def) => def.metadata.id)).toEqual(expect.arrayContaining(FILE_WRITERS));
  });

  it('puts every role of every file-writing step in exactly one table', () => {
    const unclassified: string[] = [];
    const inBoth: string[] = [];
    for (const def of writers) {
      const stepId = def.metadata.id;
      for (const role of rolesOf(def)) {
        const mode = HOUSE_RULE_ROLES[stepId]?.[role];
        const reason = HOUSE_RULE_EXEMPT[stepId]?.[role] ?? HOUSE_RULE_EXEMPT[stepId]?.['*'];
        if (mode === undefined && reason === undefined) unclassified.push(`${stepId}/${role}`);
        if (mode !== undefined && reason !== undefined) inBoth.push(`${stepId}/${role}`);
      }
    }
    expect(unclassified).toEqual([]);
    expect(inBoth).toEqual([]);
  });

  it('names only registered steps and the roles they dispatch under', () => {
    const stale: string[] = [];
    for (const [table, entries] of [
      ['HOUSE_RULE_ROLES', HOUSE_RULE_ROLES],
      ['HOUSE_RULE_EXEMPT', HOUSE_RULE_EXEMPT],
    ] as const) {
      for (const [stepId, roles] of Object.entries(entries)) {
        const def = byId.get(stepId);
        const known = def === undefined ? [] : rolesOf(def);
        if (def === undefined) stale.push(`${table}: ${stepId} is not a registered step`);
        for (const role of Object.keys(roles)) {
          const wildcard = role === '*' && table === 'HOUSE_RULE_EXEMPT';
          if (def !== undefined && !wildcard && !known.includes(role)) {
            stale.push(
              `${table}: ${stepId} never dispatches under "${role}" (${known.join(', ')})`,
            );
          }
        }
      }
    }
    expect(stale).toEqual([]);
  });

  it('gives every exemption a reason of one line', () => {
    const reasons = Object.values(HOUSE_RULE_EXEMPT).flatMap((roles) => Object.values(roles));
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) expect(reason).toMatch(/^\S[^\n]*\S$/);
  });

  it('shows the writers the rules to follow and the 07b validator the rules to check', () => {
    expect(HOUSE_RULE_ROLES).toEqual({
      '04-phase-0b-pre-planning': { default: 'write' },
      '05-phase-0b5-spec-quality': { corrector: 'write' },
      '05a-resolve-spec-warnings': { default: 'write' },
      '06b-sprint-planning': { default: 'write' },
      '06c-dag-execute': { coder: 'write' },
      '07-phase-2-implement': { default: 'write' },
      '07a-code-simplify': { simplifier: 'write', fixup: 'write' },
      '07b-phase-4-validate': { validator: 'review', fixer: 'write' },
      '08a-browser-verify': { fixer: 'write' },
      '08b-test-management': { default: 'write' },
      '08e-insights-triage': { default: 'write' },
    });
  });

  it('exempts the merge fixers, plan merge, the skill steps, kb_author, the advisor, the replanner, the 08a tester and the 06c reviewer', () => {
    const roles = Object.fromEntries(
      Object.entries(HOUSE_RULE_EXEMPT).map(([stepId, entries]) => [stepId, Object.keys(entries)]),
    );
    expect(roles).toEqual({
      '00a-sync-base': ['default'],
      '12-worktree-cleanup': ['default'],
      '13-onboarding-push': ['default'],
      '06c-dag-execute': ['default', 'reviewer', 'issue_advisor', 'replanner'],
      '08a-browser-verify': ['tester'],
      '01-plan-merge': ['default'],
      '09_5-skill-generation': ['*'],
      '09_5b-skill-repair': ['*'],
      '11d-skill-sync': ['*'],
      '01-kb-enrich': ['default'],
    });
  });

  it.each([
    ['05-phase-0b5-spec-quality', ['reviewer', 'corrector']],
    ['07a-code-simplify', ['simplifier', 'fixup']],
    ['07b-phase-4-validate', ['validator', 'fixer']],
    ['08a-browser-verify', ['tester', 'fixer']],
  ])('%s runs its loop in the roles the tables name', (stepId, passes) => {
    const resolveRole = byId.get(stepId)?.loop?.resolveRole;
    expect([resolveRole?.(0), resolveRole?.(1)]).toEqual(passes);
  });

  it('shows the 07b validator pass the rules to check and the fixer pass the rules to follow', () => {
    const resolveRole = byId.get('07b-phase-4-validate')!.loop!.resolveRole!;
    const table = HOUSE_RULE_ROLES['07b-phase-4-validate']!;
    expect(table[resolveRole(0)!]).toBe('review');
    expect(table[resolveRole(1)!]).toBe('write');
    expect(table[resolveRole(2)!]).toBe('review');
  });
});
