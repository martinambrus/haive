import { describe, expect, it } from 'vitest';
import {
  MODULE_RUNTIME_REASON_MAX,
  diffModuleIntent,
  type ModuleIntentRow,
} from '../src/modularity/index.js';

const LOADED = new Date('2026-10-01T00:00:00.000Z');

const intent = (id: string): ModuleIntentRow => ({
  moduleId: id,
  name: `Name ${id}`,
  source: 'local',
  installedVersion: '1.0.0',
  entitlementId: null,
  lastLoadedAt: LOADED,
  missingAt: null,
  deactivatedAt: null,
  tornDownAt: null,
});

const VALID = { state: 'failed', schema: 'ready', jobs: 'stopped', attempts: 3, reason: 'boom' };
const AT = '2026-10-13T10:00:00.000Z';

const diff = (runtime?: unknown, hasRuntime = true) =>
  diffModuleIntent([intent('m'), intent('other')], [], {
    at: AT,
    modules: [
      { id: 'm', version: '1.0.0', ...(hasRuntime ? { runtime } : {}) },
      { id: 'other', version: '2.0.0', runtime: VALID },
    ],
  });

const rowOf = (result: ReturnType<typeof diffModuleIntent>, id: string) =>
  result.rows.find((r) => r.id === id) as unknown as Record<string, unknown>;

describe('the runtime in a worker report', () => {
  it('S1 passes a valid runtime through to the row', () => {
    expect(rowOf(diff(VALID), 'm').runtime).toEqual(VALID);
  });

  it('S2 leaves row.runtime undefined when the report has none', () => {
    const row = rowOf(diff(undefined, false), 'm');
    expect(row.runtime).toBeUndefined();
    expect(row.runtime).not.toBeNull();
    // the sibling that does carry one shows it, so the field is read at all
    expect(rowOf(diff(undefined, false), 'other').runtime).toEqual(VALID);
  });

  it.each([
    ['state bogus', { ...VALID, state: 'bogus' }],
    ['attempts -1', { ...VALID, attempts: -1 }],
    ['attempts 1.5', { ...VALID, attempts: 1.5 }],
    ['attempts string', { ...VALID, attempts: '2' }],
    ['reason number', { ...VALID, reason: 5 }],
    ['schema x', { ...VALID, schema: 'x' }],
    ['jobs null', { ...VALID, jobs: null }],
    ['an array', [VALID]],
    ['a string', 'ready'],
  ])('S3 drops a malformed runtime (%s) without invalidating the report', (_label, runtime) => {
    const result = diff(runtime);
    expect(result.workerAt).toBe(AT);
    const row = rowOf(result, 'm');
    expect(row.runtime).toBeUndefined();
    expect(row.workerVersion).toBe('1.0.0');
    expect(rowOf(result, 'other').workerVersion).toBe('2.0.0');
    expect(rowOf(result, 'other').runtime).toEqual(VALID);
  });

  it('S4 keeps a long reason, cut to MODULE_RUNTIME_REASON_MAX', () => {
    expect(MODULE_RUNTIME_REASON_MAX).toBe(500);
    const runtime = rowOf(diff({ ...VALID, reason: 'y'.repeat(5000) }), 'm').runtime as {
      reason: string;
    };
    expect(runtime).toBeDefined();
    expect(runtime.reason.length).toBe(MODULE_RUNTIME_REASON_MAX);
  });

  it('S5 accepts a null reason and zero attempts', () => {
    const ok = { state: 'ready', schema: 'none', jobs: 'running', attempts: 0, reason: null };
    expect(rowOf(diff(ok), 'm').runtime).toEqual(ok);
  });
});
