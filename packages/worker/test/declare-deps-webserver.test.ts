import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { ONBOARDING_ENVIRONMENT_SCHEMA_VERSION } from '@haive/shared';
import { declareDepsStep } from '../src/step-engine/steps/env-replicate/01-declare-deps.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

// The repo on disk is markerless — no .htaccess, no .ddev/config.yaml — so the scan
// answers nginx-fpm for want of a marker, not because nginx was detected. What the
// user confirmed at onboarding is the only evidence such a project has.

const TASK_ID = 'de98d843-2b03-463e-98fb-ff9bd99f2970';
const OWN_TEMPLATE_NAME = 'task-de98d843';

let repoPath: string;

beforeEach(async () => {
  repoPath = await mkdtemp(path.join(os.tmpdir(), 'haive-declare-deps-'));
});

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true });
});

function makeCtx(template: { name: string; declaredDeps: Record<string, unknown> } | null) {
  const db = {
    query: {
      tasks: {
        findFirst: vi.fn(async () => ({
          repositoryId: 'repo-1',
          title: 'Add DDEV',
          description: '',
          envTemplateId: template ? 'tpl-linked' : null,
        })),
      },
      repositories: {
        findFirst: vi.fn(async () => ({
          onboardingEnvironment: {
            schemaVersion: ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
            envDetectData: {},
            confirmedValues: { primaryLanguage: 'php', phpVersion: '5.6', webserver: 'apache' },
          },
        })),
      },
      envTemplates: { findFirst: vi.fn(async () => template ?? undefined) },
    },
    select: () => ({ from: async () => [] }),
  } as unknown as Database;
  return {
    db,
    taskId: TASK_ID,
    userId: 'user-1',
    cliProviderId: null,
    repoPath,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  } as unknown as StepContext;
}

describe('01-declare-deps detect webserver precedence', () => {
  it('offers the webserver confirmed at onboarding for a markerless repo', async () => {
    const detected = await declareDepsStep.detect(makeCtx(null));
    expect(detected.webserver).toBe('apache-fpm');
  });

  it('ignores a webserver stored on a template row this task does not own', async () => {
    // 02-generate-dockerfile relinks tasks onto each other's rows, so the linked row
    // can carry a choice made by (and for) a different task.
    const ctx = makeCtx({ name: 'task-73852f1b', declaredDeps: { webserver: 'nginx-fpm' } });
    const detected = await declareDepsStep.detect(ctx);
    expect(detected.webserver).toBe('apache-fpm');
  });

  it("keeps this task's own previously declared webserver", async () => {
    const ctx = makeCtx({ name: OWN_TEMPLATE_NAME, declaredDeps: { webserver: 'nginx-fpm' } });
    const detected = await declareDepsStep.detect(ctx);
    expect(detected.webserver).toBe('nginx-fpm');
  });
});
