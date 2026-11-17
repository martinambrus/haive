import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { hasReadyLspBridge } from '../src/lsp/configured-lsp.js';
import { fakeDockerRunner } from './fake-docker-runner.js';

// A captured valid verification row, not a reimplementation of its matcher. This
// also pins schema/recipe identity: regenerate deliberately when recipes change.
const captured = readFileSync(
  new URL('./fixtures/composed-lsp-readiness.json', import.meta.url),
  'utf8',
);
function fixture() {
  const data = JSON.parse(captured, (key, value) =>
    key.endsWith('At') && typeof value === 'string' ? new Date(value) : value,
  );
  return data;
}
async function ready(data: ReturnType<typeof fixture>) {
  const tables = {
    tasks: schema.tasks,
    envTemplates: schema.envTemplates,
    taskSteps: schema.taskSteps,
    cliProviders: schema.cliProviders,
    toolPackageVersions: schema.toolPackageVersions,
  };
  const f = createFakeDb(tables);
  for (const key of ['tasks', 'envTemplates', 'taskSteps', 'cliProviders'] as const)
    for (const row of data[key]) f.insert(tables[key], row);
  return hasReadyLspBridge(f.db as unknown as Database, data.ids.task, {
    providerId: data.ids.provider,
    runner: fakeDockerRunner({
      inspect: async () => ({ exists: true, imageId: 'sha256:verified' }),
    }),
  });
}
describe('completed composed identity through the existing readiness entry point', () => {
  it('accepts the captured complete current identity', async () => {
    expect(await ready(fixture())).toBe(true);
  });
  const fields = [
    ['schemaVersion'],
    ['envTemplateId'],
    ['installContract'],
    ['templateBodyHash'],
    ['environmentImageId'],
    ['recipeHash'],
    ['compositionHash'],
    ['tag'],
    ['imageId'],
    ['provider', 'id'],
    ['provider', 'name'],
    ['provider', 'cliVersion'],
    ['provider', 'extrasHash'],
    ['provider', 'configHash'],
    ['plugin', 'hash'],
    ['plugin', 'filesHash'],
    ['plugin', 'ready'],
    ['selection', 0, 'version'],
    ['selection', 0, 'server'],
  ] as const;
  it.each(fields.map((path) => [path.join('.'), path] as const))(
    'refuses stale %s although legacy reports passed',
    async (_label, path) => {
      const data = fixture();
      let current = data.taskSteps.find(
        (s: { stepId: string }) => s.stepId === '04-verify-environment',
      ).output.composedLsp.entries[0].identity;
      for (const part of path.slice(0, -1)) current = current[part];
      const key = path.at(-1)!;
      current[key] =
        typeof current[key] === 'number'
          ? 99
          : typeof current[key] === 'boolean'
            ? false
            : 'changed';
      expect(await ready(data)).toBe(false);
    },
  );
  it.each([
    'omitted',
    'skipped',
    'failed',
    'version',
    'duplicate',
    'schema',
    'outcome',
    'empty entries',
  ] as const)('refuses %s composed evidence although legacy reports passed', async (kind) => {
    const data = fixture();
    const evidence = data.taskSteps.find(
      (s: { stepId: string }) => s.stepId === '04-verify-environment',
    ).output.composedLsp;
    const entry = evidence.entries[0];
    if (kind === 'omitted') entry.reports = [];
    if (kind === 'skipped') entry.reports[0].skipped = true;
    if (kind === 'failed') entry.reports[0].passed = false;
    if (kind === 'version') entry.reports[0].installedVersion = null;
    if (kind === 'duplicate') entry.reports.push({ ...entry.reports[0] });
    if (kind === 'schema') evidence.schemaVersion = 99;
    if (kind === 'outcome') entry.outcome = 'failed';
    if (kind === 'empty entries') evidence.entries = [];
    expect(await ready(data)).toBe(false);
  });
});

it('refuses a successful plugin install for a different selection', async () => {
  const data = fixture();
  data.taskSteps.find(
    (s: { stepId: string }) => s.stepId === '01b-install-plugins',
  ).detectOutput.lspLanguages = ['typescript'];
  expect(await ready(data)).toBe(false);
});
