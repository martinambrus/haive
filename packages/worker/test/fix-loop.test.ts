import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { advanceStep, type AdvanceStepParams } from '../src/step-engine/step-runner.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import { phase2ImplementStep } from '../src/step-engine/steps/workflow/07-phase-2-implement.js';
import {
  cleanDiagnosis,
  buildFixLoopEscalationSchema,
  FIX_LOOP_ACTION_FIELD,
} from '../src/step-engine/steps/workflow/_fix-loop.js';

// Slice 2 engine: a step that finds a blocking defect (via fixLoop.evaluate) or throws
// with fixLoopOnError set returns `loop_back` from advanceStep instead of done/failed.
// handleResult (task-queue) turns loop_back into a round bump + re-entry at implement;
// that routing is exercised end-to-end by the Slice 6 smoke, not this unit test.

interface MockState {
  taskStepRow: Record<string, unknown>;
  inserts: { table: string; row: Record<string, unknown> }[];
  updates: Record<string, unknown>[];
  /** When true, task_events queries return a row — models a fix_loop.accepted event
   *  so isFixLoopSuppressed() reports the loop as stood down. */
  suppressed?: boolean;
}

function tableNameOf(table: unknown): string {
  if (table && typeof table === 'object') {
    const obj = table as Record<string, unknown>;
    const sym = Object.getOwnPropertySymbols(obj).find((s) => s.description === 'drizzle:Name');
    if (sym) {
      const name = obj[sym as unknown as string];
      if (typeof name === 'string') return name;
    }
  }
  return '';
}

function makeMockDb(state: MockState): Database {
  let nextId = 1;
  return {
    select: () => ({
      from: (table: unknown) => {
        const name = tableNameOf(table);
        const rows =
          name === 'task_steps' && state.taskStepRow.id
            ? [state.taskStepRow]
            : name === 'task_events' && state.suppressed
              ? [{ id: 'evt-accepted' }]
              : [];
        return {
          where: () => ({
            limit: async () => rows,
            orderBy: () => ({ limit: async () => rows }),
          }),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          const name = tableNameOf(table);
          const row = { id: `mock-${nextId++}`, createdAt: new Date(), ...v };
          state.inserts.push({ table: name, row });
          if (name === 'task_steps') state.taskStepRow = { ...state.taskStepRow, ...row };
          return [row];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (v: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            const name = tableNameOf(table);
            state.updates.push({ table: name, ...v });
            if (name === 'task_steps') {
              state.taskStepRow = { ...state.taskStepRow, ...v };
              return [state.taskStepRow];
            }
            return [];
          },
        }),
      }),
    }),
    query: {
      tasks: { findFirst: async () => undefined },
      userStepCliPreferences: { findFirst: async () => undefined },
    },
  } as unknown as Database;
}

function meta(id: string) {
  return {
    id,
    workflowType: 'workflow' as const,
    index: 99,
    title: 't',
    description: 'd',
    requiresCli: false,
  };
}

function fixLoopStep(blocking: boolean): StepDefinition {
  return {
    metadata: meta('test-fixloop'),
    async detect() {
      return { ok: true };
    },
    form() {
      return null;
    },
    fixLoop: {
      evaluate: () => (blocking ? { blocking: true, diagnosis: 'boom: bad config' } : null),
    },
    async apply() {
      return { verdict: blocking ? 'ISSUES_FOUND' : 'VALID' };
    },
  };
}

function throwingStep(): StepDefinition {
  return {
    metadata: meta('test-fixloop-err'),
    async detect() {
      return { ok: true };
    },
    form() {
      return null;
    },
    fixLoopOnError: true,
    async apply() {
      throw new Error('ddev restart failed: bad webserver');
    },
  };
}

function params(db: Database, step: StepDefinition, round: number): AdvanceStepParams {
  return {
    db,
    taskId: 'task-1',
    userId: 'user-1',
    repoPath: '/tmp/r',
    workspacePath: '/tmp/r',
    cliProviderId: null,
    stepDef: step,
    round,
  };
}

describe('fix-loop engine', () => {
  it('returns loop_back when a fixLoop step finds a blocking defect', async () => {
    const state: MockState = { taskStepRow: {}, inserts: [], updates: [] };
    const result = await advanceStep(params(makeMockDb(state), fixLoopStep(true), 1));
    expect(result.status).toBe('loop_back');
    if (result.status === 'loop_back') {
      expect(result.diagnosis).toContain('bad config');
      expect(result.sourceStepId).toBe('test-fixloop');
      expect(result.row.round).toBe(1);
    }
    // The source step is still finalized as done (it ran, produced findings).
    expect(state.taskStepRow.status).toBe('done');
  });

  it('finishes done when a fixLoop step passes', async () => {
    const state: MockState = { taskStepRow: {}, inserts: [], updates: [] };
    const result = await advanceStep(params(makeMockDb(state), fixLoopStep(false), 0));
    expect(result.status).toBe('done');
  });

  it('routes a thrown failure to loop_back when fixLoopOnError is set', async () => {
    const state: MockState = { taskStepRow: {}, inserts: [], updates: [] };
    const result = await advanceStep(params(makeMockDb(state), throwingStep(), 2));
    expect(result.status).toBe('loop_back');
    if (result.status === 'loop_back') {
      expect(result.diagnosis).toContain('bad webserver');
      expect(result.sourceStepId).toBe('test-fixloop-err');
      expect(result.row.round).toBe(2);
    }
  });

  it('does NOT loop_back once the user accepted remaining issues (suppressed)', async () => {
    // A fix_loop.accepted event is present → the escalation-gate "accept" stood the loop
    // down, so a blocking downstream step now finalizes (done) instead of routing back.
    const state: MockState = { taskStepRow: {}, inserts: [], updates: [], suppressed: true };
    const result = await advanceStep(params(makeMockDb(state), fixLoopStep(true), 3));
    expect(result.status).toBe('done');
  });
});

describe('fix-mode implement prompt (slice 3)', () => {
  const buildPrompt = phase2ImplementStep.llm!.buildPrompt;

  it('leads with the diagnosis, then appends the full spec', () => {
    const prompt = buildPrompt({
      detected: {
        specSummary: 's',
        spec: 'THE-FULL-SPEC-BODY',
        sandboxWorkspacePath: '/ws',
        gateFeedback: '',
        fixContext: 'webserver_type: apache is invalid; DDEV wants apache-fpm',
        round: 1,
      },
      formValues: {},
    });
    expect(prompt).toContain('FIX PASS');
    const defectIdx = prompt.indexOf('webserver_type: apache is invalid');
    const specIdx = prompt.indexOf('THE-FULL-SPEC-BODY');
    expect(defectIdx).toBeGreaterThan(-1);
    expect(specIdx).toBeGreaterThan(-1);
    expect(defectIdx).toBeLessThan(specIdx);
  });

  it('original pass (round 0, no fixContext) is not a fix pass', () => {
    const prompt = buildPrompt({
      detected: {
        specSummary: 's',
        spec: 'SPEC',
        sandboxWorkspacePath: '/ws',
        gateFeedback: '',
        fixContext: null,
        round: 0,
      },
      formValues: {},
    });
    expect(prompt).not.toContain('FIX PASS');
  });
});

describe('cleanDiagnosis (slice 4 follow-up)', () => {
  it('strips ANSI control codes but PRESERVES all content (incl. the error)', () => {
    const raw = [
      'ddev start failed: Network ddev_default created',
      '',
      '\x1B[106;30m TIP OF THE DAY                          \x1B[0m',
      '\x1B[2K\x1B[31mFailed to start project(s): the rs-claude-less-tokens project has an unsupported webserver type: apache, DDEV (amd64) only supports the following webserver types: [apache-fpm generic nginx-fpm]\x1B[0m',
    ].join('\n');
    const out = cleanDiagnosis(raw);
    // The real error survives — never dropped by brittle content matching.
    expect(out).toContain('unsupported webserver type: apache');
    expect(out).toContain('ddev start failed: Network ddev_default created');
    // ANSI escape sequences (a stable format) are gone.
    expect(out).not.toContain('\x1B[');
    // Banner/promo text is intentionally LEFT IN — we don't pattern-match content
    // that changes shape over time; the agent is told to find the error within it.
    expect(out).toContain('TIP OF THE DAY');
  });
});

describe('fix-loop escalation gate (slice 5c)', () => {
  it('builds a Continue / Accept / Abort gate with the diagnosis', () => {
    const schema = buildFixLoopEscalationSchema('08c-code-review', 'security: SQLi in login', 5);
    expect(schema.title).toContain('5');
    // The decision radio carries the marker field id that flags a gate submission.
    const radio = schema.fields.find((f) => f.id === FIX_LOOP_ACTION_FIELD);
    expect(radio?.type).toBe('radio');
    const values = (radio as { options?: { value: string }[] }).options?.map((o) => o.value);
    expect(values).toEqual(['continue', 'accept', 'abort']);
    // The diagnosis is surfaced read-only.
    expect(JSON.stringify(schema.infoSections)).toContain('SQLi in login');
  });
});
