import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { projectStepPorts } from '@haive/shared/step-ports';
import { SPEC_ROLES, STEP_ROLES } from '@haive/shared/step-outputs';
import { CORE_COMPOSABLE_STEPS } from '../src/step-engine/composable-core.js';

const workflow = new URL('../src/step-engine/steps/workflow/', import.meta.url);
const sources = readdirSync(workflow).filter(
  (name) => name.endsWith('.ts') && !name.includes('.test.'),
);
function imports(name: string): { module: string; names: string[] }[] {
  const file = ts.createSourceFile(
    name,
    readFileSync(new URL(name, workflow), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  return file.statements.filter(ts.isImportDeclaration).map((statement) => ({
    module: (statement.moduleSpecifier as ts.StringLiteral).text,
    names:
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
        ? statement.importClause.namedBindings.elements.map(
            (item) => (item.propertyName ?? item.name).text,
          )
        : [],
  }));
}
const stepSources = sources.filter((name) => /^\d/.test(name));
const ids = stepSources.map((name) => name.slice(0, -3));
const nodes = () => projectStepPorts(ids).nodes;

it('mirrors every core spec input and output declaration including its exact contract', () => {
  const specRoles = new Set<string>(Object.values(SPEC_ROLES));
  for (const entry of CORE_COMPOSABLE_STEPS) {
    const node = projectStepPorts([entry.stepId]).nodes[0]!;
    const inputs = node.inputs
      .filter((input) => !input.adapter && specRoles.has(input.role))
      .map(({ id, role, contract, optional }) => ({ input: id, role, contract, optional }));
    const outputs = node.outputs
      .filter((output) => specRoles.has(output.role))
      .map(({ role, contract }) => ({ role, contract }));
    expect(inputs, entry.stepId).toEqual(entry.consumesRoles ?? []);
    expect(outputs, entry.stepId).toEqual(entry.providesRoles ?? []);
  }
});

it('covers actual effective-spec adapter importers, including the run-config stage adapter', () => {
  const consumers = stepSources
    .filter((name) =>
      imports(name).some(
        (item) =>
          item.module === './_spec-artifact.js' &&
          item.names.some(
            (symbol) =>
              ['resolveApprovedSpec', 'resolveSpecView'].includes(symbol) ||
              (symbol === 'readSpecStages' && name === '06-run-config.ts'),
          ),
      ),
    )
    .map((name) => name.slice(0, -3));
  expect(
    nodes()
      .filter((node) => node.inputs.some((input) => input.adapter === 'effective-spec'))
      .map((node) => node.id)
      .sort(),
  ).toEqual(consumers.sort());
  // Pin ALL importers, even those using only path/body helpers: a new importer forces review.
  expect(
    sources
      .filter((name) => imports(name).some((item) => item.module === './_spec-artifact.js'))
      .sort(),
  ).toEqual(
    [
      '05-phase-0b5-spec-quality.ts',
      '05a-resolve-spec-warnings.ts',
      '06-gate-1-spec-approval.ts',
      '06-run-config.ts',
      '06b-sprint-planning.ts',
      '07-phase-2-implement.ts',
      '07a-code-simplify.ts',
      '07b-phase-4-validate.ts',
      '08a-browser-verify.ts',
      '08b-test-management.ts',
      '08c-code-review.ts',
      '08c2-code-audit.ts',
      '08d-adversarial-qa.ts',
      '08e-insights-triage.ts',
      '11f-plan-reconcile.ts',
      '_screenshots.ts',
    ].sort(),
  );
});

it('pins review consumers to the direct gate reader and the house-rules/history adapters', () => {
  const consumers = ['09-gate-2-verify-approval', '10-gate-3-commit', '11-phase-8-learning'];
  expect(
    nodes()
      .filter((node) => node.inputs.some((input) => input.role === STEP_ROLES.codeReview))
      .map((node) => node.id)
      .sort(),
  ).toEqual(consumers);
  const direct = stepSources.filter((name) =>
    readFileSync(new URL(name, workflow), 'utf8').includes('role: STEP_ROLES.codeReview'),
  );
  expect(direct).toEqual(['09-gate-2-verify-approval.ts']);
  expect(imports('10-gate-3-commit.ts')).toContainEqual(
    expect.objectContaining({
      module: './_gate-house-rules.js',
      names: expect.arrayContaining(['loadGateHouseRules']),
    }),
  );
  expect(imports('11-phase-8-learning.ts')).toContainEqual(
    expect.objectContaining({
      module: './_task-history-digest.js',
      names: expect.arrayContaining(['buildTaskHistoryDigest']),
    }),
  );
  // A new caller of either adapter must be classified before updating the projection.
  for (const module of ['./_gate-house-rules.js', './_task-history-digest.js']) {
    const callers = stepSources.filter((name) =>
      imports(name).some((item) => item.module === module),
    );
    expect(callers.sort()).toEqual(
      module === './_gate-house-rules.js'
        ? [
            '07b-phase-4-validate.ts',
            '08c-code-review.ts',
            '09-gate-2-verify-approval.ts',
            '10-gate-3-commit.ts',
          ]
        : ['11-phase-8-learning.ts'],
    );
  }
  expect(
    nodes()
      .filter((node) => node.inputs.some((input) => input.role === STEP_ROLES.codeAudit))
      .map((node) => node.id),
  ).toEqual(['09-gate-2-verify-approval']);
});
