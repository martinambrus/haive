import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import {
  CODEX_APP_SERVER_UNAVAILABLE_EVENT,
  codexAppServerFallbackWarning,
  codexAppServerVerdict,
  currentCodexAppServerVerdict,
  isCodexAppServerSupported,
  recordCodexAppServerVerdict,
  type CodexAppServerVerdicts,
} from '../src/cli-adapters/codex-app-server-verdict.js';

const verdicts = (providerCliVersion: string | null, status: 'supported' | 'unsupported') =>
  ({
    'prov-1': {
      status,
      providerCliVersion,
      binaryVersion: '0.154.0',
      stage: status === 'supported' ? null : 'steer',
      detail: null,
      source: 'probe',
      at: '2026-09-13T00:00:00.000Z',
    },
  }) satisfies CodexAppServerVerdicts;

describe('codex app-server verdicts', () => {
  it('is current while the provider still runs the version it was probed on', () => {
    const provider = { id: 'prov-1', cliVersion: ' 0.154.0 ' };
    expect(currentCodexAppServerVerdict(verdicts('0.154.0', 'supported'), provider)).not.toBeNull();
    expect(isCodexAppServerSupported(verdicts('0.154.0', 'supported'), provider)).toBe(true);
  });

  it('goes stale when the provider moves to another version, so the new binary is probed', () => {
    const provider = { id: 'prov-1', cliVersion: '0.155.0' };
    expect(currentCodexAppServerVerdict(verdicts('0.154.0', 'supported'), provider)).toBeNull();
    expect(isCodexAppServerSupported(verdicts('0.154.0', 'supported'), provider)).toBe(false);
  });

  it('matches an unpinned provider to an unpinned verdict', () => {
    const provider = { id: 'prov-1', cliVersion: null };
    expect(isCodexAppServerSupported(verdicts(null, 'supported'), provider)).toBe(true);
    expect(
      isCodexAppServerSupported(verdicts(null, 'supported'), { id: 'prov-1', cliVersion: '' }),
    ).toBe(true);
  });

  it('never supports a provider with no verdict, an unsupported one, or no verdicts at all', () => {
    expect(
      isCodexAppServerSupported(verdicts('0.154.0', 'supported'), {
        id: 'other',
        cliVersion: '0.154.0',
      }),
    ).toBe(false);
    expect(
      isCodexAppServerSupported(verdicts('0.154.0', 'unsupported'), {
        id: 'prov-1',
        cliVersion: '0.154.0',
      }),
    ).toBe(false);
    expect(isCodexAppServerSupported(null, { id: 'prov-1', cliVersion: '0.154.0' })).toBe(false);
  });

  it('stamps the provider version it was taken for', () => {
    const verdict = codexAppServerVerdict(
      { cliVersion: '  0.154.0' },
      { status: 'supported', binaryVersion: '0.154.0', stage: null, detail: null, source: 'probe' },
    );
    expect(verdict.providerCliVersion).toBe('0.154.0');
    expect(Number.isNaN(Date.parse(verdict.at))).toBe(false);
  });
});

describe('codexAppServerFallbackWarning', () => {
  it('names the stage, the codex version and what to do when it recurs', () => {
    const text = codexAppServerFallbackWarning(
      { stage: 'turn_start', detail: 'Invalid request: missing field `type`' },
      '0.155.0',
    );
    expect(text).toContain('turn_start');
    expect(text).toContain('codex 0.155.0');
    expect(text).toContain('codex exec');
    expect(text).toContain('Admin');
  });

  it('omits the version when the app-server never reported one', () => {
    expect(codexAppServerFallbackWarning({ stage: 'spawn', detail: null }, null)).toMatch(
      /^codex app-server failed at spawn: no detail\. /,
    );
  });
});

/** Enough of drizzle's builder for the one update and the one insert the recorder issues. */
function fakeDb(opts: { failInsert?: boolean } = {}) {
  const calls = { updates: 0, events: [] as Record<string, any>[] };
  const db = {
    update: () => ({
      set: () => ({
        where: async () => {
          calls.updates += 1;
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, any>) => {
        if (opts.failInsert) throw new Error('insert refused');
        calls.events.push({ table, ...values });
      },
    }),
  } as unknown as Database;
  return { db, calls };
}

describe('recordCodexAppServerVerdict', () => {
  const unsupported = codexAppServerVerdict(
    { cliVersion: '0.154.0' },
    {
      status: 'unsupported',
      binaryVersion: null,
      stage: 'spawn',
      detail: "error: unexpected argument '--json' found",
      source: 'runtime',
    },
  );

  it('keeps a task event beside an unsupported verdict, naming the codex version', async () => {
    const { db, calls } = fakeDb();
    await recordCodexAppServerVerdict(db, 'task-1', 'prov-1', unsupported);
    expect(calls.updates).toBe(1);
    expect(calls.events).toHaveLength(1);
    const event = calls.events[0]!;
    expect(event.table).toBe(schema.taskEvents);
    expect(event).toMatchObject({
      taskId: 'task-1',
      eventType: CODEX_APP_SERVER_UNAVAILABLE_EVENT,
      payload: { providerId: 'prov-1', stage: 'spawn', codexVersion: '0.154.0', source: 'runtime' },
    });
    expect(event.payload.message).toMatch(/^codex app-server failed at spawn on codex 0\.154\.0: /);
  });

  it('writes no event for a supported verdict', async () => {
    const { db, calls } = fakeDb();
    await recordCodexAppServerVerdict(
      db,
      'task-1',
      'prov-1',
      codexAppServerVerdict(
        { cliVersion: '0.154.0' },
        {
          status: 'supported',
          binaryVersion: '0.154.0',
          stage: null,
          detail: null,
          source: 'probe',
        },
      ),
    );
    expect(calls.updates).toBe(1);
    expect(calls.events).toHaveLength(0);
  });

  it('keeps the recorded verdict when the event cannot be written', async () => {
    const { db, calls } = fakeDb({ failInsert: true });
    await expect(
      recordCodexAppServerVerdict(db, 'task-1', 'prov-1', unsupported),
    ).resolves.toBeUndefined();
    expect(calls.updates).toBe(1);
  });
});
