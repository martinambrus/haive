import { describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger } from '@haive/shared';
import { detectionConfirmationStep } from '../src/step-engine/steps/onboarding/02-detection-confirmation.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

type Detected = Parameters<NonNullable<typeof detectionConfirmationStep.form>>[1];

const ctx = { logger: logger.child({ test: 'confirm' }) } as unknown as StepContext;

function det(over: Partial<Detected>): Detected {
  return {
    detectedName: 'x',
    detectedFramework: 'general',
    detectedLanguage: 'unknown',
    containerType: 'none',
    databaseType: null,
    databaseVersion: null,
    webserver: null,
    docroot: null,
    runtimeVersions: {},
    indicators: [],
    testPaths: [],
    testFrameworks: [],
    localUrl: null,
    buildTool: null,
    projectDescription: null,
    source: 'deterministic',
    ...over,
  } as Detected;
}

function fieldIds(detected: Detected): string[] {
  return detectionConfirmationStep.form!(ctx, detected, undefined)!.fields.map((f) => f.id);
}

describe('02 detection-confirmation conditional fields', () => {
  it('shows Node version but not PHP for a Node project', () => {
    const ids = fieldIds(
      det({
        detectedFramework: 'nextjs',
        detectedLanguage: 'javascript',
        indicators: ['package.json'],
      }),
    );
    expect(ids).toContain('nodeVersion');
    expect(ids).not.toContain('phpVersion');
  });

  it('shows PHP version but not Node for a Drupal project', () => {
    const ids = fieldIds(
      det({ detectedFramework: 'drupal', detectedLanguage: 'php', indicators: ['composer.json'] }),
    );
    expect(ids).toContain('phpVersion');
    expect(ids).not.toContain('nodeVersion');
  });

  it('shows both for a mixed Drupal + Node repo', () => {
    const ids = fieldIds(
      det({
        detectedFramework: 'drupal',
        detectedLanguage: 'php',
        indicators: ['composer.json', 'package.json'],
      }),
    );
    expect(ids).toContain('phpVersion');
    expect(ids).toContain('nodeVersion');
  });

  it('shows the Rust version field for a Rust project only', () => {
    const ids = fieldIds(
      det({ detectedFramework: 'rust', detectedLanguage: 'rust', indicators: ['Cargo.toml'] }),
    );
    expect(ids).toContain('rustVersion');
    expect(ids).not.toContain('phpVersion');
    expect(ids).not.toContain('nodeVersion');
  });

  it('shows the Go version field for a Go project only', () => {
    const ids = fieldIds(
      det({ detectedFramework: 'go', detectedLanguage: 'go', indicators: ['go.mod'] }),
    );
    expect(ids).toContain('goVersion');
    expect(ids).not.toContain('phpVersion');
  });

  it('always keeps the universal fields', () => {
    const ids = fieldIds(det({}));
    expect(ids).toEqual(
      expect.arrayContaining(['projectName', 'framework', 'primaryLanguage', 'databaseType']),
    );
  });
});

describe('02 detection-confirmation apply', () => {
  const TASK = '00000000-0000-4000-8000-0000000000c1';
  const REPO = '00000000-0000-4000-8000-0000000000b1';
  const OTHER = '00000000-0000-4000-8000-0000000000b2';
  const USER = '00000000-0000-4000-8000-0000000000a1';

  it('mirrors the environment onto the repository and marks its project state record dirty', async () => {
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      repositories: schema.repositories,
      projectStateOutbox: schema.projectStateOutbox,
    });
    for (const id of [REPO, OTHER]) {
      fake.insert(schema.repositories, { id, userId: USER, name: id, source: 'blank' });
    }
    fake.insert(schema.tasks, { id: TASK, userId: USER, repositoryId: REPO });
    const withDb = { ...ctx, db: fake.db, taskId: TASK } as unknown as StepContext;

    await detectionConfirmationStep.apply(withDb, {
      detected: det({}),
      formValues: { projectName: 'acme' },
      iteration: 0,
      previousIterations: [],
    } as never);

    const repo = fake.rows(schema.repositories).find((r) => r.id === REPO)!;
    expect(repo.onboardingEnvironment).toMatchObject({
      schemaVersion: 1,
      confirmedValues: { projectName: 'acme' },
    });
    const outbox = fake.rows(schema.projectStateOutbox);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ repositoryId: REPO, revision: 1, writtenRevision: 0 });
  });
});
