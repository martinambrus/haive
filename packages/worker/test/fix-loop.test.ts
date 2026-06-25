import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { advanceStep, type AdvanceStepParams } from '../src/step-engine/step-runner.js';
import type { StepContext, StepDefinition } from '../src/step-engine/step-definition.js';
import { phase2ImplementStep } from '../src/step-engine/steps/workflow/07-phase-2-implement.js';
import { phase4ValidateStep } from '../src/step-engine/steps/workflow/07b-phase-4-validate.js';
import {
  cleanDiagnosis,
  buildFixLoopEscalationSchema,
  buildOscillationEscalationSchema,
  fixLoopFingerprint,
  detectFixLoopOscillation,
  loadHonoredConstraints,
  loadPriorFixContext,
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

function restartLoopStep(reject: boolean): StepDefinition {
  return {
    metadata: meta('test-restartloop'),
    async detect() {
      return { ok: true };
    },
    form() {
      return null;
    },
    restartLoop: {
      evaluate: (out) =>
        (out as { decision?: string }).decision === 'reject'
          ? { diagnosis: 'developer found: button does nothing' }
          : null,
    },
    async apply() {
      return { decision: reject ? 'reject' : 'approve' };
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

  it('returns an UNCAPPED loop_back when a restartLoop step requests a restart', async () => {
    // A human gate-2 reject: loop_back like fixLoop, but flagged uncapped so handleResult
    // skips the round cap. The source row still finalizes done (it recorded the decision).
    const state: MockState = { taskStepRow: {}, inserts: [], updates: [] };
    const result = await advanceStep(params(makeMockDb(state), restartLoopStep(true), 4));
    expect(result.status).toBe('loop_back');
    if (result.status === 'loop_back') {
      expect(result.uncapped).toBe(true);
      expect(result.diagnosis).toContain('button does nothing');
      expect(result.sourceStepId).toBe('test-restartloop');
      expect(result.row.round).toBe(4);
    }
    expect(state.taskStepRow.status).toBe('done');
  });

  it('finishes done when a restartLoop step approves', async () => {
    const state: MockState = { taskStepRow: {}, inserts: [], updates: [] };
    const result = await advanceStep(params(makeMockDb(state), restartLoopStep(false), 0));
    expect(result.status).toBe('done');
  });

  it('restartLoop is NOT stood down by a prior accept (human-driven, suppression-immune)', async () => {
    // Unlike fixLoop, a developer reject still restarts even after a fix_loop.accepted event
    // — the human is the bound, not the auto-fix budget.
    const state: MockState = { taskStepRow: {}, inserts: [], updates: [], suppressed: true };
    const result = await advanceStep(params(makeMockDb(state), restartLoopStep(true), 5));
    expect(result.status).toBe('loop_back');
    if (result.status === 'loop_back') expect(result.uncapped).toBe(true);
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

// --- Slice A: oscillation guard ------------------------------------------------

/** A db whose fix_loop.requested scan (select.from.where.orderBy, awaited directly)
 *  resolves to a scripted event list. detectFixLoopOscillation only reads `payload`. */
function eventsDb(events: { payload: Record<string, unknown> }[]): Database {
  return {
    select: () => ({
      from: () => ({ where: () => ({ orderBy: async () => events }) }),
    }),
  } as unknown as Database;
}

const D07C = 'ddev start failed: already contains a project named rs-ollama2';
const D07B = 'Developer Experience: rename rs-ollama2 to redaction-system';
function ev(sourceStepId: string, round: number, diagnosis: string) {
  return {
    payload: {
      sourceStepId,
      diagnosis,
      round,
      fingerprint: fixLoopFingerprint(sourceStepId, diagnosis),
    },
  };
}

describe('fixLoopFingerprint', () => {
  it('is stable across volatile tokens (line numbers, uuids, paths)', () => {
    const a = fixLoopFingerprint(
      '07c-ddev-reconcile',
      'ddev start failed at /repos/abc-123/.ddev/config.yaml:5: already contains a project named rs-ollama2 (snapshot haive-import-11112222-3333-4444-5555-666677778888)',
    );
    const b = fixLoopFingerprint(
      '07c-ddev-reconcile',
      'ddev start failed at /repos/zzz-999/.ddev/config.yaml:42: already contains a project named rs-ollama2 (snapshot haive-import-99998888-7777-6666-5555-444433332222)',
    );
    expect(a).toBe(b);
  });

  it('differs by source step even for identical text (no cross-step collision)', () => {
    expect(fixLoopFingerprint('07b-phase-4-validate', 'rename rs-ollama2')).not.toBe(
      fixLoopFingerprint('07c-ddev-reconcile', 'rename rs-ollama2'),
    );
  });

  it('normalizes ANSI before hashing (same as the cleaned form)', () => {
    expect(fixLoopFingerprint('07c-ddev-reconcile', '\x1B[31mddev start failed: boom\x1B[0m')).toBe(
      fixLoopFingerprint('07c-ddev-reconcile', 'ddev start failed: boom'),
    );
  });
});

describe('detectFixLoopOscillation', () => {
  it('trips when a source re-raises the same complaint with alternation in between', async () => {
    const db = eventsDb([ev('07c-ddev-reconcile', 2, D07C), ev('07b-phase-4-validate', 3, D07B)]);
    const r = await detectFixLoopOscillation(db, 't', '07c-ddev-reconcile', D07C, 4);
    expect(r.tripped).toBe(true);
    expect(r.conflictingStepId).toBe('07b-phase-4-validate');
    expect(r.conflictingDiagnoses).toEqual([D07C, D07B]);
  });

  it('does NOT trip when the same source repeats but nothing alternated in', async () => {
    const db = eventsDb([ev('07c-ddev-reconcile', 2, D07C)]);
    const r = await detectFixLoopOscillation(db, 't', '07c-ddev-reconcile', D07C, 4);
    expect(r.tripped).toBe(false);
  });

  it('does NOT trip when each round raises a different (converging) complaint', async () => {
    const db = eventsDb([
      ev('07c-ddev-reconcile', 2, 'ddev start failed: missing extension foo'),
      ev('07b-phase-4-validate', 3, D07B),
    ]);
    const r = await detectFixLoopOscillation(db, 't', '07c-ddev-reconcile', D07C, 4);
    expect(r.tripped).toBe(false);
  });

  it('does NOT trip before round 3', async () => {
    const db = eventsDb([ev('07c-ddev-reconcile', 0, D07C)]);
    const r = await detectFixLoopOscillation(db, 't', '07c-ddev-reconcile', D07C, 2);
    expect(r.tripped).toBe(false);
  });

  it('recomputes the fingerprint for legacy events written before the field', async () => {
    const db = eventsDb([
      { payload: { sourceStepId: '07c-ddev-reconcile', diagnosis: D07C, round: 2 } },
      { payload: { sourceStepId: '07b-phase-4-validate', diagnosis: D07B, round: 3 } },
    ]);
    const r = await detectFixLoopOscillation(db, 't', '07c-ddev-reconcile', D07C, 4);
    expect(r.tripped).toBe(true);
  });
});

describe('oscillation escalation gate', () => {
  it('reuses the gate action field and surfaces both conflicting diagnoses', () => {
    const s = buildOscillationEscalationSchema(
      '07c-ddev-reconcile',
      '07b-phase-4-validate',
      'pin the ddev project name',
      'rename the ddev project name',
    );
    const radio = s.fields.find((f) => f.id === FIX_LOOP_ACTION_FIELD);
    expect(radio?.type).toBe('radio');
    expect((radio as { options?: { value: string }[] }).options?.map((o) => o.value)).toEqual([
      'continue',
      'accept',
      'abort',
    ]);
    const info = JSON.stringify(s.infoSections);
    expect(info).toContain('pin the ddev project name');
    expect(info).toContain('rename the ddev project name');
    expect(s.title).toContain('07c-ddev-reconcile');
    expect(s.title).toContain('07b-phase-4-validate');
  });
});

// --- Slice B: loop-aware validator (honored constraints) -----------------------

function ctxWith(events: { payload: Record<string, unknown> }[], round: number): StepContext {
  return { db: eventsDb(events), taskId: 't', round } as unknown as StepContext;
}

describe('loadHonoredConstraints', () => {
  it('returns empty on the original pass (round 0)', async () => {
    expect(await loadHonoredConstraints(ctxWith([ev('07c-ddev-reconcile', 0, D07C)], 0))).toBe('');
  });

  it('includes objective sources (07c) and excludes 07b own findings', async () => {
    const block = await loadHonoredConstraints(
      ctxWith([ev('07c-ddev-reconcile', 1, D07C), ev('07b-phase-4-validate', 2, D07B)], 2),
    );
    expect(block).toContain('HONORED CONSTRAINTS');
    expect(block).toContain('07c-ddev-reconcile');
    expect(block).toContain('already contains a project named rs-ollama2');
    expect(block).toContain('harness-owned');
    expect(block).not.toContain('07b-phase-4-validate');
  });

  it('excludes constraints recorded for a later round', async () => {
    expect(await loadHonoredConstraints(ctxWith([ev('07c-ddev-reconcile', 5, D07C)], 2))).toBe('');
  });

  it('dedups to the latest diagnosis per source (rows are newest-first)', async () => {
    const block = await loadHonoredConstraints(
      ctxWith(
        [
          ev('07c-ddev-reconcile', 2, 'ddev start failed: NEW reason'),
          ev('07c-ddev-reconcile', 1, 'ddev start failed: OLD reason'),
        ],
        2,
      ),
    );
    expect(block).toContain('NEW reason');
    expect(block).not.toContain('OLD reason');
  });
});

// --- Layer 2: cross-round fix ledger ------------------------------------------

describe('loadPriorFixContext', () => {
  // Table-aware mock: loadPriorFixContext queries BOTH task_steps (prior implement
  // outputs) and task_events (prior diagnoses), so route rows by drizzle table name.
  function priorCtx(opts: {
    round: number;
    implRows?: { round: number; output: unknown }[];
    events?: { payload: Record<string, unknown> }[];
  }): StepContext {
    const db = {
      select: () => ({
        from: (table: unknown) => {
          const name = tableNameOf(table);
          const rows =
            name === 'task_steps'
              ? (opts.implRows ?? [])
              : name === 'task_events'
                ? (opts.events ?? [])
                : [];
          return { where: () => ({ orderBy: async () => rows }) };
        },
      }),
    } as unknown as Database;
    return { db, taskId: 't', round: opts.round } as unknown as StepContext;
  }

  it('returns empty on the original pass (round 0)', async () => {
    expect(
      await loadPriorFixContext(
        priorCtx({ round: 0, implRows: [{ round: 0, output: { summary: 'x' } }] }),
      ),
    ).toBe('');
  });

  it('aggregates prior implement summaries, environmentFindings, and prior diagnoses', async () => {
    const block = await loadPriorFixContext(
      priorCtx({
        round: 2,
        implRows: [
          {
            round: 1,
            output: {
              summary: 'added init.php guard',
              environmentFindings: 'ddev not on PATH in sandbox',
            },
          },
        ],
        events: [ev('07b-phase-4-validate', 1, 'missing error handling in foo')],
      }),
    );
    expect(block).toContain('WHAT EARLIER FIX ROUNDS');
    expect(block).toContain('round 1: added init.php guard');
    expect(block).toContain('ddev not on PATH in sandbox');
    expect(block).toContain('missing error handling in foo');
  });

  it('dedups prior diagnoses by fingerprint (same complaint shows once)', async () => {
    const block = await loadPriorFixContext(
      priorCtx({
        round: 3,
        events: [
          ev('07b-phase-4-validate', 2, 'missing error handling in foo'),
          ev('07b-phase-4-validate', 1, 'missing error handling in foo'),
        ],
      }),
    );
    const occurrences = block.split('missing error handling in foo').length - 1;
    expect(occurrences).toBe(1);
  });

  it('excludes the current round and later diagnoses (earlier rounds only)', async () => {
    const block = await loadPriorFixContext(
      priorCtx({
        round: 2,
        events: [
          ev('07b-phase-4-validate', 2, 'current-round defect'),
          ev('08-phase-5-verify', 3, 'later defect'),
        ],
      }),
    );
    expect(block).toBe('');
  });

  it('caps an overlong block', async () => {
    const block = await loadPriorFixContext(
      priorCtx({ round: 2, implRows: [{ round: 1, output: { summary: 'x'.repeat(8000) } }] }),
    );
    expect(block.length).toBeLessThanOrEqual(4000);
  });
});

describe('07b validator prompt — honored constraints', () => {
  const buildPrompt = phase4ValidateStep.llm!.buildPrompt;
  const base = {
    worktreePath: '/wt',
    sandboxWorktreePath: '/ws',
    spec: 'SPEC',
    implementationFiles: ['a.php'],
    debtBlock: '',
  };

  it('injects the honored-constraints block when present', () => {
    const prompt = buildPrompt({
      detected: {
        ...base,
        honoredBlock: 'HONORED CONSTRAINTS — do not revert\n- 07c-ddev-reconcile: pin the name',
      },
      formValues: {},
    });
    expect(prompt).toContain('HONORED CONSTRAINTS');
    expect(prompt).toContain('07c-ddev-reconcile: pin the name');
  });

  it('omits the block when there are no honored constraints', () => {
    const prompt = buildPrompt({ detected: { ...base, honoredBlock: '' }, formValues: {} });
    expect(prompt).not.toContain('HONORED CONSTRAINTS');
  });
});
