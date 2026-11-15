import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkRoleReaderPins,
  isRoleReaderSource,
  roleReaderSites,
  type ReaderPin,
} from './step-role-source-scan.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const pins = JSON.parse(
  readFileSync(new URL('./step-role-reader-pins.json', import.meta.url), 'utf8'),
) as ReaderPin[];

describe('ungated step-role reader ratchet', () => {
  it('pins every executable role literal and every use of role constants exactly', () => {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(isRoleReaderSource);
    const sites = files.flatMap((file) =>
      roleReaderSites(file, readFileSync(path.join(root, file), 'utf8')),
    );
    expect(checkRoleReaderPins(sites, pins)).toEqual([]);
    // ~4 s alone here; a CI runner sharing its cores with the other vitest workers went past
    // 20 s, so the bound follows fs-ratchet's.
  }, 60_000);
  it.each([
    `eq(schema.taskSteps.stepId, '08c-code-review')`,
    "sql`${schema.taskSteps.stepId} = '08c-code-review' and task_id = ${id}`",
    '`08c-code-review:${taskId}`',
    '`${taskId}:08c-code-review:${round}`',
    '`${taskId}:08c2-code-audit`',
    'const role = /^08c-code-review/;',

    `const load = loadPreviousStepOutput; load(db, taskId, '08c-code-review')`,
    `function wrap(id) {return loadPreviousStepOutput(db, t, id)}; wrap('08c2-code-audit')`,
    `const ids = new Set(['08c-code-review']); rows.filter(r => ids.has(r.stepId))`,
    `const ids = new Map([['08c2-code-audit',true]])`,
    `const view = <div step={'08c-code-review'} />`,
    `import {STEP_ROLES as roles} from '@haive/shared/step-outputs'; const alias=roles.codeReview; eq(schema.taskSteps.stepId,alias)`,
    `import * as outputs from '@haive/shared/step-outputs'; load(db,t,outputs.STEP_ROLES.codeReview)`,
  ])('rejects an unapproved predicate/alias/wrapper/collection/TSX %#', (source) => {
    expect(
      checkRoleReaderPins(roleReaderSites('packages/worker/src/negative.tsx', source), []).length,
    ).toBeGreaterThan(0);
  });
  it('collapses indentation and line-break whitespace in call contexts', () => {
    const file = 'packages/worker/src/negative.ts';
    expect(roleReaderSites(file, "loader\n  .read('08c-code-review')")).toEqual(
      roleReaderSites(file, "loader\n      .read('08c-code-review')"),
    );
  });
  it('rejects new reads inside a pinned symbol, changed counts and stale exemptions', () => {
    const file = 'packages/worker/src/negative.ts';
    const source = `function own() {write('08c-code-review')}`;
    const approved = roleReaderSites(file, source).map((site) => ({
      ...site,
      reason: 'Own producer identity',
    }));
    expect(checkRoleReaderPins(roleReaderSites(file, source), approved)).toEqual([]);
    for (const changed of [
      `function own() {write('08c-code-review'); load('08c-code-review')}`,
      `function own() {write('08c-code-review','08c-code-review')}`,
      '',
    ])
      expect(checkRoleReaderPins(roleReaderSites(file, changed), approved).length).toBeGreaterThan(
        0,
      );
  });
  it('rejects a new raw read through an already pinned scalar alias', () => {
    const file = 'packages/worker/src/existing.ts';
    const declaration = `import {STEP_ROLES as roles} from '@haive/shared/step-outputs'; const review = roles.codeReview; readStepRole(task,review,b => b)`;
    const approved = roleReaderSites(file, declaration).map((site) => ({
      ...site,
      reason: 'Existing approved role read',
    }));
    expect(checkRoleReaderPins(roleReaderSites(file, declaration), approved)).toEqual([]);
    expect(
      checkRoleReaderPins(
        roleReaderSites(file, declaration + '; loadPreviousStepOutput(db,t,review)'),
        approved,
      ).length,
    ).toBeGreaterThan(0);
  });
  it('ignores comments and excludes only explicit test/generated trees', () => {
    expect(roleReaderSites('source.ts', `// '08c-code-review'\n/* '08c2-code-audit' */`)).toEqual(
      [],
    );
    for (const file of [
      'packages/web/src/a.tsx',
      'packages/worker/scripts/a.ts',
      'packages/database/src/a.ts',
      'packages/web-kit/src/a.ts',
      'modules/example/src/a.ts',
      'scripts/a.mjs',
      'external-modules/example/src/a.ts',
    ])
      expect(isRoleReaderSource(file)).toBe(true);
    for (const file of [
      'packages/web/src/a.test.ts',
      'scripts/test/a.mjs',
      'modules/example/test/a.ts',
      'packages/web/src/generated/a.ts',
    ])
      expect(isRoleReaderSource(file)).toBe(false);
  });
});
