import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { RTK_ENABLED_UNIT, conflictSide } from '@haive/shared/project-state';
import { DEFAULT_MCP_SETTINGS_JSON } from '../src/sandbox/mcp-config.js';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { toolingInfrastructureStep } from '../src/step-engine/steps/onboarding/04-tooling-infrastructure.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tooling-rtk-converge-'));
  dirs.push(root);
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(join(root, '.claude/mcp_settings.json'), DEFAULT_MCP_SETTINGS_JSON);
  const fake = createFakeDb({
    tasks: schema.tasks,
    repositories: schema.repositories,
    projectStateConflicts: schema.projectStateConflicts,
    projectStateOutbox: schema.projectStateOutbox,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'r', rtkEnabled: true });
  fake.insert(schema.tasks, { id: TASK, userId: USER, repositoryId: REPO });
  fake.insert(schema.projectStateConflicts, {
    repositoryId: REPO,
    unit: RTK_ENABLED_UNIT,
    base: conflictSide(true),
    local: conflictSide(true),
    incoming: conflictSide(false),
  });
  const noop = () => undefined;
  const ctx = {
    db: fake.db,
    repoPath: root,
    taskId: TASK,
    userId: USER,
    cliProviderId: null,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as StepContext;
  const apply = (rtkEnabled: boolean) =>
    toolingInfrastructureStep.apply(ctx, {
      detected: { cliSupportsLsp: false, repoOwnedMcpServersFingerprint: 'none' },
      formValues: { mcpSettingsJson: DEFAULT_MCP_SETTINGS_JSON, rtkEnabled },
    } as never);
  const repo = () => fake.rows(schema.repositories)[0]!;
  const row = () => fake.rows(schema.projectStateConflicts)[0]!;
  const outbox = () => fake.rows(schema.projectStateOutbox);
  return { apply, repo, row, outbox };
}

describe('04 saving the RTK choice and a pending RTK question', () => {
  it('switching RTK off closes the question as converged, by the task user', async () => {
    const f = await fixture();

    await f.apply(false);

    expect(f.repo().rtkEnabled).toBe(false);
    expect(f.row()).toMatchObject({ resolution: 'converged', resolvedBy: USER });
  });

  it('keeping RTK on leaves the question pending', async () => {
    const f = await fixture();

    await f.apply(true);

    expect(f.repo().rtkEnabled).toBe(true);
    expect(f.row()).toMatchObject({ resolution: null, resolvedAt: null });
  });

  it('marks the project state record dirty, whichever way RTK is saved', async () => {
    const f = await fixture();

    await f.apply(true);
    await f.apply(false);

    expect(f.outbox()).toEqual([
      expect.objectContaining({ repositoryId: REPO, revision: 2, writtenRevision: 0 }),
    ]);
  });
});
