import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/db.js', () => ({ getDb: () => undefined }));

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  enrichStepsWithCliPreferences,
  buildUpcomingCliSteps,
  resolveCurrentStepCliProviderIds,
} from '../src/routes/tasks/_helpers.js';
import { eq } from 'drizzle-orm';
import { STEP_MINING_SEATS } from '@haive/shared';
import { staticStepFlags } from './step-flags-fixture.js';

// Exercise the real worker resolver without pulling its source tree into the API's
// TypeScript root (the same runtime-import seam as park-fold-db). Load it with the
// fixture so module initialization is outside the individual test's timeout.
const workerPath = new URL(
  '../../worker/src/step-engine/steps/workflow/_fix-round-cli.ts',
  import.meta.url,
).pathname;
const { FixRoundCliUnavailable, resolveFixRoundCli } = await import(workerPath);

const flags = staticStepFlags();
const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-000000000001';
const TASK_CLI = '00000000-0000-4000-8000-0000000000b1';
const SAVED_CLI = '00000000-0000-4000-8000-0000000000b2';
const PICKED_CLI = '00000000-0000-4000-8000-0000000000b3';

function setup() {
  const fake = createFakeDb({
    tasks: schema.tasks,
    envTemplates: schema.envTemplates,
    cliProviders: schema.cliProviders,
    taskStepCliChoices: schema.taskStepCliChoices,
    userStepCliPreferences: schema.userStepCliPreferences,
    userStepCliRolePreferences: schema.userStepCliRolePreferences,
  });
  for (const id of [TASK_CLI, SAVED_CLI, PICKED_CLI]) {
    fake.insert(schema.cliProviders, { id, userId: USER, name: 'codex', enabled: true });
  }
  const save = (stepId: string, cliProviderId: string, role = 'default') =>
    role === 'default'
      ? fake.insert(schema.userStepCliPreferences, {
          userId: USER,
          stepId,
          cliProviderId,
          effortLevel: 'low',
          explicit: true,
        })
      : fake.insert(schema.userStepCliRolePreferences, {
          userId: USER,
          stepId,
          role,
          cliProviderId,
          explicit: true,
        });
  const choose = (
    stepId: string,
    cliProviderId: string | null,
    role = 'default',
    updatedAt = new Date(1),
  ) =>
    fake.insert(schema.taskStepCliChoices, {
      taskId: TASK,
      stepId,
      role,
      cliProviderId,
      effortLevel: cliProviderId ? 'high' : null,
      updatedAt,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { fake, db: fake.db as any, save, choose };
}

describe("a step card's CLI", () => {
  it("shows this task's pick over the saved one, with its effort", async () => {
    const { db, save, choose } = setup();
    save('08c-code-review', SAVED_CLI);
    choose('08c-code-review', PICKED_CLI);
    const [step] = await enrichStepsWithCliPreferences(
      db,
      flags,
      USER,
      [{ stepId: '08c-code-review' }],
      TASK,
    );
    expect(step).toMatchObject({
      preferredCliProviderId: PICKED_CLI,
      preferredEffortLevel: 'high',
    });
  });

  it('shows nothing saved in a slot this task cleared, and the saved one elsewhere', async () => {
    const { db, save, choose } = setup();
    save('08c-code-review', SAVED_CLI);
    save('08d-adversarial-qa', SAVED_CLI);
    choose('08c-code-review', null);
    const steps = await enrichStepsWithCliPreferences(
      db,
      flags,
      USER,
      [{ stepId: '08c-code-review' }, { stepId: '08d-adversarial-qa' }],
      TASK,
    );
    expect(steps.map((s) => s.preferredCliProviderId)).toEqual([null, SAVED_CLI]);
  });

  it("shows this task's pick under ignore_saved_step_clis", async () => {
    const { db, save, choose } = setup();
    save('08c-code-review', SAVED_CLI);
    save('08d-adversarial-qa', SAVED_CLI);
    choose('08c-code-review', PICKED_CLI);
    const steps = await enrichStepsWithCliPreferences(
      db,
      flags,
      USER,
      [{ stepId: '08c-code-review' }, { stepId: '08d-adversarial-qa' }],
      TASK,
      true,
    );
    expect(steps.map((s) => s.preferredCliProviderId)).toEqual([PICKED_CLI, null]);
  });

  it('shows no effort for a slot whose chosen provider was deleted since', async () => {
    const { fake, db, save } = setup();
    save('08c-code-review', SAVED_CLI);
    // What ON DELETE SET NULL leaves: the provider gone, the effort that went with it kept.
    fake.insert(schema.taskStepCliChoices, {
      taskId: TASK,
      stepId: '08c-code-review',
      role: 'default',
      cliProviderId: null,
      effortLevel: 'max',
    });
    const [step] = await enrichStepsWithCliPreferences(
      db,
      flags,
      USER,
      [{ stepId: '08c-code-review' }],
      TASK,
    );
    expect(step).toMatchObject({ preferredCliProviderId: null, preferredEffortLevel: null });
  });

  it("shows a role's own pick in this task", async () => {
    const { db, save, choose } = setup();
    save('08a-browser-verify', SAVED_CLI, 'fixer');
    choose('08a-browser-verify', PICKED_CLI, 'fixer');
    const [step] = await enrichStepsWithCliPreferences(
      db,
      flags,
      USER,
      [{ stepId: '08a-browser-verify' }],
      TASK,
    );
    expect(step?.cliRoleProviders).toMatchObject({ fixer: PICKED_CLI, tester: null });
  });
});

describe('active fix-round CLI readers', () => {
  const stepId = '07-phase-2-implement';
  const CUSTOM = 'module.fix-demo.repair';
  const pin = (id: string) => ({
    version: 1,
    guardedSpans: [],
    fixTarget: { stepId: id, capabilityVersion: 1 },
  });
  const targets = [
    { name: 'legacy 07', fixStep: stepId, contract: null },
    { name: 'pinned custom target', fixStep: CUSTOM, contract: pin(CUSTOM) },
  ];
  const states = ['deleted', 'missing', 'foreign', 'disabled', 'enabled'];
  it.each(targets.flatMap((target) => states.map((state) => ({ ...target, state }))))(
    '$name: matches worker refusal for an active $state round choice without fallback',
    async ({ fixStep, contract, state }) => {
      const { fake, db, choose, save } = setup();
      fake.insert(schema.tasks, { id: TASK, executionContract: contract });
      const stepFlags = new Map(flags).set(fixStep, {
        ...flags.get(stepId)!,
        stepId: fixStep,
        title: fixStep,
      });
      choose(fixStep, state === 'deleted' ? null : PICKED_CLI, 'fix:2:default');
      save(fixStep, SAVED_CLI);
      const change =
        state === 'disabled'
          ? { enabled: false }
          : state === 'foreign'
            ? { userId: 'another-owner' }
            : state === 'missing'
              ? { id: 'no-longer-listed' }
              : {};
      await db
        .update(schema.cliProviders)
        .set(change)
        .where(eq(schema.cliProviders.id, PICKED_CLI));
      let refused = false;
      try {
        await resolveFixRoundCli(db, USER, TASK, fixStep, 'default', 2);
      } catch (error) {
        expect(error).toBeInstanceOf(FixRoundCliUnavailable);
        refused = true;
      }
      expect(refused).toBe(state !== 'enabled');
      const [card] = await enrichStepsWithCliPreferences(
        db,
        stepFlags,
        USER,
        [{ stepId: fixStep, round: 2 }],
        TASK,
      );
      expect(Boolean((card as { roundCliUnavailable?: true }).roundCliUnavailable)).toBe(refused);
      const listing = await resolveCurrentStepCliProviderIds(db, stepFlags, USER, [
        {
          id: TASK,
          currentStepId: fixStep,
          currentRound: 2,
          cliProviderId: TASK_CLI,
          ignoreSavedStepClis: false,
        },
      ]);
      expect(listing.get(TASK)).toEqual(refused ? [] : [PICKED_CLI]);
      const upcoming = await buildUpcomingCliSteps(
        db,
        stepFlags,
        USER,
        TASK,
        'workflow',
        [],
        false,
        [fixStep],
        2,
      );
      expect(Boolean((upcoming[0] as { roundCliUnavailable?: true }).roundCliUnavailable)).toBe(
        refused,
      );
    },
  );

  it('lists no usage provider behind a deleted round slot', async () => {
    const { db, choose } = setup();
    choose(stepId, null, 'fix:2:default');
    const listing = await resolveCurrentStepCliProviderIds(db, flags, USER, [
      {
        id: TASK,
        currentStepId: stepId,
        currentRound: 2,
        cliProviderId: TASK_CLI,
        ignoreSavedStepClis: false,
      },
    ]);
    expect(listing.get(TASK)).toEqual([]);
  });

  it.each(['later', 'tie', 'other-round', 'other-step', 'no-choice'])(
    'keeps ordinary clear and no-override output unchanged: %s',
    async (state) => {
      const { db, choose } = setup();
      if (state !== 'no-choice') choose(stepId, null, 'fix:2:default', new Date(1));
      if (state === 'later' || state === 'tie')
        choose(stepId, null, 'default', new Date(state === 'later' ? 2 : 1));
      const target = state === 'other-step' ? '08c-code-review' : stepId;
      const round = state === 'other-round' ? 3 : 2;
      const [card] = await enrichStepsWithCliPreferences(
        db,
        flags,
        USER,
        [{ stepId: target, round }],
        TASK,
      );
      expect(card).not.toHaveProperty('roundCliUnavailable');
      const listing = await resolveCurrentStepCliProviderIds(db, flags, USER, [
        {
          id: TASK,
          currentStepId: target,
          currentRound: round,
          cliProviderId: TASK_CLI,
          ignoreSavedStepClis: false,
        },
      ]);
      expect(listing.get(TASK)).toEqual([TASK_CLI]);
    },
  );

  it('shows and meters the round choice above an older card choice, only for that round', async () => {
    const { db, choose } = setup();
    choose(stepId, TASK_CLI);
    choose(stepId, PICKED_CLI, 'fix:2:default', new Date(2));
    const cards = await enrichStepsWithCliPreferences(
      db,
      flags,
      USER,
      [
        { stepId, round: 1 },
        { stepId, round: 2 },
        { stepId, round: 3 },
      ],
      TASK,
      true,
    );
    expect(cards.map((s) => s.preferredCliProviderId)).toEqual([TASK_CLI, PICKED_CLI, TASK_CLI]);
    const listing = await resolveCurrentStepCliProviderIds(db, flags, USER, [
      {
        id: TASK,
        currentStepId: stepId,
        currentRound: 2,
        cliProviderId: TASK_CLI,
        ignoreSavedStepClis: true,
      },
    ]);
    expect(listing.get(TASK)).toEqual([PICKED_CLI]);
  });

  it('meters the active round override in the task listing', async () => {
    const { db, choose } = setup();
    choose(stepId, PICKED_CLI, 'fix:2:default', new Date(2));
    const listing = await resolveCurrentStepCliProviderIds(db, flags, USER, [
      {
        id: TASK,
        currentStepId: stepId,
        currentRound: 2,
        cliProviderId: TASK_CLI,
        ignoreSavedStepClis: false,
      },
    ]);
    expect(listing.get(TASK)).toEqual([PICKED_CLI]);
  });

  it('shows the round choice on the CLIs tab before the step has a row', async () => {
    const { db, choose } = setup();
    choose(stepId, PICKED_CLI, 'fix:2:default');
    const upcoming = await buildUpcomingCliSteps(
      db,
      flags,
      USER,
      TASK,
      'workflow',
      [],
      false,
      [stepId],
      2,
    );
    expect(upcoming[0]?.preferredCliProviderId).toBe(PICKED_CLI);
  });

  it('keeps a newer card pick above the round choice, including its effort', async () => {
    const { db, choose } = setup();
    choose(stepId, PICKED_CLI, 'fix:2:default', new Date(1));
    choose(stepId, TASK_CLI, 'default', new Date(2));
    const [card] = await enrichStepsWithCliPreferences(
      db,
      flags,
      USER,
      [{ stepId, round: 2 }],
      TASK,
    );
    expect(card).toMatchObject({ preferredCliProviderId: TASK_CLI, preferredEffortLevel: 'high' });
    const listing = await resolveCurrentStepCliProviderIds(db, flags, USER, [
      {
        id: TASK,
        currentStepId: stepId,
        currentRound: 2,
        cliProviderId: SAVED_CLI,
        ignoreSavedStepClis: false,
      },
    ]);
    expect(listing.get(TASK)).toEqual([TASK_CLI]);
  });
});

describe('a slot with and without ignore_saved_step_clis', () => {
  const UNLISTED = '00000000-0000-4000-8000-0000000000b9';
  const SEAT = STEP_MINING_SEATS['08c-code-review']![0]!.id;
  type Setup = ReturnType<typeof setup>;
  type Target = { stepId: string; role: string };
  const dflt: Target = { stepId: '08d-adversarial-qa', role: 'default' };
  const roleT: Target = { stepId: '08a-browser-verify', role: 'fixer' };
  const seatT: Target = { stepId: '08c-code-review', role: SEAT };
  // [name, target, arrange, [card off, listing off], [card on, listing on]]
  type Row = [
    string,
    Target,
    (s: Setup, t: Target) => void,
    [string | null, string[]],
    [string | null, string[]],
  ];
  const cleared = (s: Setup, t: Target, role = t.role) => s.choose(t.stepId, null, role);
  const rows: Row[] = [
    [
      'default: task pick over a saved row',
      dflt,
      (s, t) => {
        s.save(t.stepId, SAVED_CLI);
        s.choose(t.stepId, PICKED_CLI);
      },
      [PICKED_CLI, [PICKED_CLI]],
      [PICKED_CLI, [PICKED_CLI]],
    ],
    [
      'default: cleared task pick with a saved row',
      dflt,
      (s, t) => {
        s.save(t.stepId, SAVED_CLI);
        cleared(s, t);
      },
      [null, [TASK_CLI]],
      [null, [TASK_CLI]],
    ],
    [
      'default: task pick on an unlisted provider',
      dflt,
      (s, t) => {
        s.save(t.stepId, SAVED_CLI);
        s.choose(t.stepId, UNLISTED);
      },
      [UNLISTED, [TASK_CLI]],
      [UNLISTED, [TASK_CLI]],
    ],
    [
      'default: saved row only',
      dflt,
      (s, t) => s.save(t.stepId, SAVED_CLI),
      [SAVED_CLI, [SAVED_CLI]],
      [null, [TASK_CLI]],
    ],
    [
      'default: saved row on a disabled provider',
      dflt,
      (s, t) => {
        s.save(t.stepId, SAVED_CLI);
        s.fake.patch(schema.cliProviders, SAVED_CLI, { enabled: false });
      },
      [SAVED_CLI, [SAVED_CLI]],
      [null, [TASK_CLI]],
    ],
    [
      'default: saved row on an unlisted provider',
      dflt,
      (s, t) => s.save(t.stepId, UNLISTED),
      [UNLISTED, [TASK_CLI]],
      [null, [TASK_CLI]],
    ],
    ['default: nothing', dflt, () => {}, [null, [TASK_CLI]], [null, [TASK_CLI]]],
    ...(
      [
        ['08a role', roleT],
        ['08c seat', seatT],
      ] as [string, Target][]
    ).flatMap(([label, t]): Row[] => [
      [
        `${label}: role pick`,
        t,
        (s) => {
          s.save(t.stepId, SAVED_CLI, t.role);
          s.save(t.stepId, SAVED_CLI);
          s.choose(t.stepId, PICKED_CLI, t.role);
        },
        [PICKED_CLI, [SAVED_CLI, PICKED_CLI]],
        [PICKED_CLI, [TASK_CLI, PICKED_CLI]],
      ],
      [
        `${label}: cleared role pick with a default pick`,
        t,
        (s) => {
          s.save(t.stepId, SAVED_CLI, t.role);
          cleared(s, t);
          s.choose(t.stepId, PICKED_CLI);
        },
        [null, [PICKED_CLI]],
        [null, [PICKED_CLI]],
      ],
      [
        `${label}: role saved only`,
        t,
        (s) => s.save(t.stepId, SAVED_CLI, t.role),
        [SAVED_CLI, [TASK_CLI, SAVED_CLI]],
        [null, [TASK_CLI]],
      ],
      [
        `${label}: role saved plus default saved`,
        t,
        (s) => {
          s.save(t.stepId, PICKED_CLI, t.role);
          s.save(t.stepId, SAVED_CLI);
        },
        [PICKED_CLI, [SAVED_CLI, PICKED_CLI]],
        [null, [TASK_CLI]],
      ],
      [
        `${label}: default saved only`,
        t,
        (s) => s.save(t.stepId, SAVED_CLI),
        [null, [SAVED_CLI]],
        [null, [TASK_CLI]],
      ],
    ]),
  ];

  const cardValue = (card: Record<string, unknown>, t: Target) =>
    t.role === 'default'
      ? card.preferredCliProviderId
      : t === roleT
        ? (card.cliRoleProviders as Record<string, string | null>)[t.role]
        : (card.miningSeatProviders as Record<string, string | null>)[t.role];

  it.each(rows)('%s', async (_name, t, arrange, off, on) => {
    for (const [flag, [card, ids]] of [
      [false, off],
      [true, on],
    ] as const) {
      const s = setup();
      arrange(s, t);
      const [enriched] = await enrichStepsWithCliPreferences(
        s.db,
        flags,
        USER,
        [{ stepId: t.stepId }],
        TASK,
        flag,
      );
      expect(cardValue(enriched as Record<string, unknown>, t)).toBe(card);
      const listing = await resolveCurrentStepCliProviderIds(s.db, flags, USER, [
        {
          id: TASK,
          currentStepId: t.stepId,
          cliProviderId: TASK_CLI,
          ignoreSavedStepClis: flag,
        },
      ]);
      expect(listing.get(TASK)).toEqual(ids);
    }
  });
});

describe("the listing's usage strip", () => {
  const task = (currentStepId: string) => ({
    id: TASK,
    currentStepId,
    cliProviderId: TASK_CLI,
    ignoreSavedStepClis: false,
  });

  it("meters this task's pick, and the task CLI where it cleared the slot", async () => {
    const picked = setup();
    picked.save('08c-code-review', SAVED_CLI);
    picked.choose('08c-code-review', PICKED_CLI);
    const a = await resolveCurrentStepCliProviderIds(picked.db, flags, USER, [
      task('08c-code-review'),
    ]);
    expect(a.get(TASK)?.[0]).toBe(PICKED_CLI);

    const cleared = setup();
    cleared.save('08c-code-review', SAVED_CLI);
    cleared.choose('08c-code-review', null);
    const b = await resolveCurrentStepCliProviderIds(cleared.db, flags, USER, [
      task('08c-code-review'),
    ]);
    expect(b.get(TASK)?.[0]).toBe(TASK_CLI);
  });

  it("keeps this task's pick when its provider is disabled since", async () => {
    const { fake, db, save, choose } = setup();
    save('08c-code-review', SAVED_CLI);
    choose('08c-code-review', PICKED_CLI);
    fake.patch(schema.cliProviders, PICKED_CLI, { enabled: false });
    const out = await resolveCurrentStepCliProviderIds(db, flags, USER, [task('08c-code-review')]);
    expect(out.get(TASK)?.[0]).toBe(PICKED_CLI);
  });

  it('keeps a saved step pick whose provider is disabled', async () => {
    const { fake, db, save } = setup();
    save('08c-code-review', SAVED_CLI);
    fake.patch(schema.cliProviders, SAVED_CLI, { enabled: false });
    const out = await resolveCurrentStepCliProviderIds(db, flags, USER, [task('08c-code-review')]);
    expect(out.get(TASK)?.[0]).toBe(SAVED_CLI);
  });

  it('keeps a fan-out seat pick on a disabled provider', async () => {
    const { fake, db, save } = setup();
    const seat = STEP_MINING_SEATS['08c-code-review']![0]!.id;
    save('08c-code-review', SAVED_CLI, seat);
    fake.patch(schema.cliProviders, SAVED_CLI, { enabled: false });
    const out = await resolveCurrentStepCliProviderIds(db, flags, USER, [task('08c-code-review')]);
    expect(out.get(TASK)).toContain(SAVED_CLI);
  });
});

describe("the listing's usage strip for a task with no CLI of its own", () => {
  const OTHER_USER = '00000000-0000-4000-8000-0000000000a2';
  const P1 = '00000000-0000-4000-8000-0000000000c1';
  const P2 = '00000000-0000-4000-8000-0000000000c2';
  const P3 = '00000000-0000-4000-8000-0000000000c3';
  const day = (n: number) => new Date(Date.UTC(2026, 0, n));
  const none = (currentStepId = '08c-code-review') => ({
    id: TASK,
    currentStepId,
    cliProviderId: null,
    ignoreSavedStepClis: false,
  });

  function providers(rows: { id: string; createdAt: Date; enabled?: boolean; userId?: string }[]) {
    const fake = createFakeDb({
      tasks: schema.tasks,
      cliProviders: schema.cliProviders,
      taskStepCliChoices: schema.taskStepCliChoices,
      userStepCliPreferences: schema.userStepCliPreferences,
      userStepCliRolePreferences: schema.userStepCliRolePreferences,
    });
    for (const r of rows) {
      fake.insert(schema.cliProviders, {
        name: 'codex',
        userId: USER,
        enabled: true,
        ...r,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { fake, db: fake.db as any };
  }

  it('meters the oldest enabled provider whatever the insert order', async () => {
    const { db } = providers([
      { id: P3, createdAt: day(3) },
      { id: P1, createdAt: day(1) },
      { id: P2, createdAt: day(2) },
    ]);
    const out = await resolveCurrentStepCliProviderIds(db, flags, USER, [none()]);
    expect(out.get(TASK)).toEqual([P1]);
  });

  it('breaks a createdAt tie on the lowest id', async () => {
    const { db } = providers([
      { id: P2, createdAt: day(1) },
      { id: P1, createdAt: day(1) },
      { id: P3, createdAt: day(2) },
    ]);
    const out = await resolveCurrentStepCliProviderIds(db, flags, USER, [none()]);
    expect(out.get(TASK)).toEqual([P1]);
  });

  it('skips a disabled oldest provider', async () => {
    const { db } = providers([
      { id: P1, createdAt: day(1), enabled: false },
      { id: P2, createdAt: day(2) },
      { id: P3, createdAt: day(3) },
    ]);
    const out = await resolveCurrentStepCliProviderIds(db, flags, USER, [none()]);
    expect(out.get(TASK)).toEqual([P2]);
  });

  it("ignores another user's older provider", async () => {
    const { db } = providers([
      { id: P1, createdAt: day(1), userId: OTHER_USER },
      { id: P2, createdAt: day(2) },
    ]);
    const out = await resolveCurrentStepCliProviderIds(db, flags, USER, [none()]);
    expect(out.get(TASK)).toEqual([P2]);
  });

  it('keeps a saved step pick over the default', async () => {
    const { fake, db } = providers([
      { id: P1, createdAt: day(1) },
      { id: P2, createdAt: day(2) },
    ]);
    fake.insert(schema.userStepCliPreferences, {
      userId: USER,
      stepId: '08c-code-review',
      cliProviderId: P2,
      effortLevel: 'low',
      explicit: true,
    });
    const out = await resolveCurrentStepCliProviderIds(db, flags, USER, [none()]);
    expect(out.get(TASK)).toEqual([P2]);
  });

  it("keeps the task's own CLI over the default", async () => {
    const { db } = providers([
      { id: P1, createdAt: day(1) },
      { id: P2, createdAt: day(2) },
    ]);
    const out = await resolveCurrentStepCliProviderIds(db, flags, USER, [
      { ...none(), cliProviderId: P2 },
    ]);
    expect(out.get(TASK)).toEqual([P2]);
  });

  it('names nothing when the user has no enabled provider', async () => {
    const { db } = providers([{ id: P1, createdAt: day(1), enabled: false }]);
    const out = await resolveCurrentStepCliProviderIds(db, flags, USER, [none()]);
    expect(out.get(TASK)).toEqual([]);
  });
});

describe('composed provider lock readers', () => {
  it.each([true, false])(
    'listing and detail skip a saved outside CLI, enabled=%s',
    async (enabled) => {
      const { fake, db, save } = setup();

      const template = '00000000-0000-4000-8000-0000000000e1';
      fake.insert(schema.envTemplates, {
        id: template,
        declaredDeps: { lspInstallContractVersion: 2 },
      });
      fake.insert(schema.tasks, {
        id: TASK,
        userId: USER,
        cliProviderId: TASK_CLI,
        envTemplateId: template,
      });
      fake.patch(schema.cliProviders, TASK_CLI, { name: 'claude-code' });
      fake.patch(schema.cliProviders, SAVED_CLI, { enabled });
      save('08c-code-review', SAVED_CLI);
      save('08c-code-review', SAVED_CLI, 'peer-reviewer');
      const [detail] = await enrichStepsWithCliPreferences(
        db,
        flags,
        USER,
        [{ stepId: '08c-code-review' }],
        TASK,
      );
      expect(detail).toMatchObject({ effectiveCliProviderIds: [TASK_CLI] });
      const listing = await resolveCurrentStepCliProviderIds(db, flags, USER, [
        {
          id: TASK,
          currentStepId: '08c-code-review',
          cliProviderId: TASK_CLI,
          ignoreSavedStepClis: false,
        },
      ]);
      expect(listing.get(TASK)).toEqual([TASK_CLI]);
    },
  );
});
