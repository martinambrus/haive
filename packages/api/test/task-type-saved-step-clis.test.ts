import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
    c.set('userRole', 'user');
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => true },
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { resolveDefaultCliProvider } from '@haive/shared';
import { taskTypeRoutes } from '../src/routes/task-types.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { resetStepFlagsCache } from '../src/lib/step-flags.js';
import type { AppEnv } from '../src/context.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
const CLI = '00000000-0000-4000-8000-0000000000b1';
const CLI_2 = '00000000-0000-4000-8000-0000000000b2';
const TYPE = 'saved-clis';
const PROMPT_ID = `custom.${TYPE}.review`;

const app = new Hono<AppEnv>();
app.route('/task-types', taskTypeRoutes);
app.onError(errorHandler);

const promptStep = {
  slug: 'review',
  title: 'Review step',
  template: 'Look at {{task.title}}',
  capabilities: [] as string[],
  timeoutMs: 300_000,
};

function setup() {
  const fake = createFakeDb({
    taskTypeDefinitions: schema.taskTypeDefinitions,
    stepCatalog: schema.stepCatalog,
    modules: schema.modules,
    userStepCliPreferences: schema.userStepCliPreferences,
    userStepCliRolePreferences: schema.userStepCliRolePreferences,
    cliProviders: schema.cliProviders,
  });
  h.db = fake.db;
  const defineType = (stepIds: string[], promptSteps: Record<string, unknown> = {}) =>
    fake.insert(schema.taskTypeDefinitions, {
      slug: TYPE,
      displayName: 'Saved CLIs',
      description: '',
      source: 'admin',
      enabled: true,
      selectable: true,
      runListStrategy: 'static',
      stepIds,
      promptSteps,
      preAnswerDefaults: {},
      stepLoopLimitDefaults: {},
      requiresRepository: true,
    });
  const save = (stepId: string, cliProviderId = CLI, userId = USER, explicit = true) =>
    fake.insert(schema.userStepCliPreferences, {
      userId,
      stepId,
      cliProviderId,
      effortLevel: null,
      explicit,
    });
  const saveRole = (stepId: string, role: string, cliProviderId = CLI, explicit = true) =>
    fake.insert(schema.userStepCliRolePreferences, {
      userId: USER,
      stepId,
      role,
      cliProviderId,
      effortLevel: null,
      explicit,
    });
  const addProvider = (id: string, createdAt: string, enabled = true, userId = USER) =>
    fake.insert(schema.cliProviders, {
      id: uidOf(id),
      userId,
      name: 'codex',
      label: id,
      enabled,
      createdAt: new Date(createdAt),
    });
  return { defineType, save, saveRole, addProvider, fake };
}

const get = (slug: string) => app.request(`/task-types/${slug}/saved-step-clis`);
const stepIds = async (slug: string): Promise<string[]> => {
  const res = await get(slug);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { steps: { stepId: string }[] };
  return body.steps.map((s) => s.stepId);
};

const shortIds = new Map<string, string>();
const uidOf = (name: string): string => {
  const hex = [...name].map((ch) => ch.charCodeAt(0).toString(16)).join('');
  const id = `00000000-0000-4000-8000-${hex.padEnd(12, '0')}`;
  shortIds.set(id, name);
  return id;
};

const defaultProviderId = async (): Promise<string | null | undefined> => {
  const res = await get('workflow');
  expect(res.status).toBe(200);
  const { defaultProviderId: id } = (await res.json()) as { defaultProviderId: string | null };
  return id === null || id === undefined ? id : (shortIds.get(id) ?? id);
};

const A = '07b-phase-4-validate';
const B = '08c-code-review';
const C = '08d-adversarial-qa';

beforeEach(() => {
  resetStepFlagsCache();
});

describe('GET /task-types/:slug/saved-step-clis', () => {
  it('lists a saved step of the type and not one outside its run list', async () => {
    const { defineType, save } = setup();
    defineType([A, B]);
    save(A);
    save(C);
    expect(await stepIds(TYPE)).toEqual([A]);
  });

  it('lists that step once it is in the run list', async () => {
    const { defineType, save } = setup();
    defineType([A, B, C]);
    save(A);
    save(C);
    expect(await stepIds(TYPE)).toEqual([A, C]);
  });

  it('lists a saved prompt step with its title', async () => {
    const { defineType, save } = setup();
    defineType([A, PROMPT_ID], { review: promptStep });
    save(PROMPT_ID);
    const res = await get(TYPE);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      steps: [{ stepId: PROMPT_ID, title: 'Review step', preferredCliProviderId: CLI }],
    });
  });

  it('leaves out a prompt step with nothing saved', async () => {
    const { defineType } = setup();
    defineType([A, PROMPT_ID], { review: promptStep });
    expect(await stepIds(TYPE)).toEqual([]);
  });

  it("leaves out another user's saved CLI", async () => {
    const { defineType, save } = setup();
    defineType([A, B]);
    save(A, CLI, OTHER);
    expect(await stepIds(TYPE)).toEqual([]);
  });

  it('lists the same step once the saved CLI is the requester’s', async () => {
    const { defineType, save } = setup();
    defineType([A, B]);
    save(A, CLI, OTHER);
    save(A, CLI_2, USER);
    expect(await stepIds(TYPE)).toEqual([A]);
  });

  it('leaves out a preference that was never explicit', async () => {
    const { defineType, save } = setup();
    defineType([A, B]);
    save(A, CLI, USER, false);
    expect(await stepIds(TYPE)).toEqual([]);
  });

  it('lists a step that holds only a role preference', async () => {
    const { defineType, saveRole } = setup();
    defineType(['08a-browser-verify', B]);
    saveRole('08a-browser-verify', 'fixer');
    const res = await get(TYPE);
    expect(await res.json()).toMatchObject({
      steps: [
        {
          stepId: '08a-browser-verify',
          preferredCliProviderId: null,
          cliRoleProviders: { tester: null, fixer: CLI },
        },
      ],
    });
  });

  it('leaves out a role preference that was never explicit', async () => {
    const { defineType, saveRole } = setup();
    defineType(['08a-browser-verify', B]);
    saveRole('08a-browser-verify', 'fixer', CLI, false);
    expect(await stepIds(TYPE)).toEqual([]);
  });

  it('lists a step that holds only a seat preference', async () => {
    const { defineType, saveRole } = setup();
    defineType([B, A]);
    const seat = 'security-code-reviewer';
    saveRole(B, seat);
    const res = await get(TYPE);
    const body = (await res.json()) as { steps: { stepId: string; miningSeatProviders: object }[] };
    expect(body.steps.map((s) => s.stepId)).toEqual([B]);
    expect(body.steps[0]!.miningSeatProviders).toMatchObject({
      [seat]: CLI,
      'peer-reviewer': null,
    });
  });

  it('never lists the model-health canary, even with a saved CLI', async () => {
    const { defineType, save } = setup();
    defineType([A]);
    save('00-model-health-workflow');
    expect(await stepIds(TYPE)).toEqual([]);
  });

  it('answers an empty list for a type with nothing saved', async () => {
    const { defineType } = setup();
    defineType([A, B]);
    const res = await get(TYPE);
    expect(await res.json()).toMatchObject({ steps: [] });
  });

  it('answers an empty list for run_app', async () => {
    const { save } = setup();
    save(A);
    expect(await stepIds('run_app')).toEqual([]);
  });

  it('lists workflow steps in catalog order', async () => {
    const { save } = setup();
    save(B);
    save(A);
    expect(await stepIds('workflow')).toEqual([A, B]);
  });

  it('refuses an unknown task type by name', async () => {
    setup();
    const res = await get('nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Unknown task type nope' });
  });
});

describe('the default CLI the saved-step-clis answer names', () => {
  it('is the oldest enabled provider of the caller, inserted newest first', async () => {
    const { addProvider } = setup();
    addProvider('b3', '2026-03-01T00:00:00Z');
    addProvider('b2', '2026-02-01T00:00:00Z');
    addProvider('b1', '2026-01-01T00:00:00Z');
    expect(await defaultProviderId()).toBe('b1');
  });

  it('breaks a createdAt tie by the lowest id', async () => {
    const { addProvider } = setup();
    addProvider('bb', '2026-01-01T00:00:00Z');
    addProvider('aa', '2026-01-01T00:00:00Z');
    expect(await defaultProviderId()).toBe('aa');
  });

  it('skips a disabled older provider', async () => {
    const { addProvider } = setup();
    addProvider('off', '2025-01-01T00:00:00Z', false);
    addProvider('on', '2026-01-01T00:00:00Z');
    expect(await defaultProviderId()).toBe('on');
  });

  it("ignores another user's older enabled provider", async () => {
    const { addProvider } = setup();
    addProvider('theirs', '2025-01-01T00:00:00Z', true, OTHER);
    addProvider('mine', '2026-01-01T00:00:00Z');
    expect(await defaultProviderId()).toBe('mine');
  });

  it('is null with no providers and with only disabled ones', async () => {
    const { addProvider } = setup();
    expect(await defaultProviderId()).toBeNull();
    addProvider('off', '2025-01-01T00:00:00Z', false);
    addProvider('theirs', '2025-01-01T00:00:00Z', true, OTHER);
    expect(await defaultProviderId()).toBeNull();
  });

  it('keeps listing the saved steps beside it', async () => {
    const { defineType, save, addProvider } = setup();
    defineType([A, B]);
    save(A);
    addProvider('b1', '2026-01-01T00:00:00Z');
    const res = await get(TYPE);
    expect(await res.json()).toMatchObject({
      steps: [{ stepId: A, preferredCliProviderId: CLI }],
      defaultProviderId: uidOf('b1'),
    });
  });

  const rows = (...specs: [string, string, boolean?][]) =>
    specs.map(([id, createdAt, enabled = true]) => ({
      id,
      createdAt: new Date(createdAt),
      enabled,
    }));
  const table: [string, [string, string, boolean?][], string | null][] = [
    [
      'newest first',
      [
        ['n', '2026-03-01T00:00:00Z'],
        ['o', '2026-01-01T00:00:00Z'],
      ],
      'o',
    ],
    [
      'a tie',
      [
        ['bb', '2026-01-01T00:00:00Z'],
        ['aa', '2026-01-01T00:00:00Z'],
      ],
      'aa',
    ],
    [
      'a disabled oldest',
      [
        ['d', '2025-01-01T00:00:00Z', false],
        ['e', '2026-01-01T00:00:00Z'],
      ],
      'e',
    ],
    ['a single provider', [['s', '2026-01-01T00:00:00Z']], 's'],
    ['none enabled', [['x', '2026-01-01T00:00:00Z', false]], null],
    ['no providers', [], null],
    [
      'three, mixed',
      [
        ['c', '2026-02-01T00:00:00Z'],
        ['b', '2026-02-01T00:00:00Z'],
        ['a', '2026-02-02T00:00:00Z'],
      ],
      'b',
    ],
  ];
  for (const [what, specs, expected] of table) {
    it(`agrees with the shared default on ${what}`, async () => {
      const { addProvider } = setup();
      for (const [id, createdAt, enabled] of specs) addProvider(id, createdAt, enabled);
      expect(await defaultProviderId()).toBe(expected);
      expect(resolveDefaultCliProvider(rows(...specs))?.id ?? null).toBe(expected);
    });
  }
});
