import { describe, expect, it } from 'vitest';
import {
  runCodexAppServerProbe,
  type ProbeProcessResult,
  type ProbeSpawn,
} from '../src/cli-adapters/codex-app-server-probe.js';

type Message = Record<string, any>;
type Emit = (message: Message) => void;
type Exit = (result: Partial<ProbeProcessResult>) => void;

/** A scripted app-server. `respond` sees every request and notification the probe writes and can
 *  answer, emit notifications or exit. Output is delivered asynchronously, as a real pipe does. */
function fakeAppServer(respond: (msg: Message, emit: Emit, exit: Exit) => void) {
  const sent: Message[] = [];
  const spawn: ProbeSpawn = (io) =>
    new Promise<ProbeProcessResult>((resolve) => {
      let done = false;
      const exit: Exit = (result) => {
        if (done) return;
        done = true;
        setImmediate(() => resolve({ exitCode: 0, stderr: '', timedOut: false, ...result }));
      };
      const emit: Emit = (message) => {
        setImmediate(() => {
          if (!done) io.onStdout(`${JSON.stringify(message)}\n`);
        });
      };
      io.signal.addEventListener('abort', () => exit({ exitCode: null }));
      const stdin = {
        writable: true,
        write(chunk: string) {
          for (const line of chunk.split('\n')) {
            if (!line.trim()) continue;
            const msg = JSON.parse(line) as Message;
            sent.push(msg);
            respond(msg, emit, exit);
          }
          return true;
        },
        end() {
          stdin.writable = false;
          exit({ exitCode: 0 });
        },
      };
      io.onStdinWritable(stdin as never);
    });
  return { spawn, sent };
}

/** The sequence 0.154.0 answered with in the zero-token probe runs. */
function healthyCodex(
  overrides: Partial<Record<string, (msg: Message, emit: Emit, exit: Exit) => boolean>> = {},
) {
  return (msg: Message, emit: Emit, exit: Exit) => {
    const override = typeof msg.method === 'string' ? overrides[msg.method] : undefined;
    if (override && override(msg, emit, exit)) return;
    switch (msg.method) {
      case 'initialize':
        return emit({
          id: msg.id,
          result: { userAgent: 'haive/0.154.0', codexHome: '/home/node/.codex' },
        });
      case 'thread/start':
        return emit({
          id: msg.id,
          result: { thread: { id: 'thread-1', cliVersion: '0.154.0' }, model: 'gpt-5.6-sol' },
        });
      case 'turn/start':
        emit({ id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
        return emit({
          method: 'turn/started',
          params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
        });
      case 'turn/steer':
        return emit({ id: msg.id, result: { turnId: 'turn-1' } });
      case 'turn/interrupt':
        emit({ id: msg.id, result: {} });
        return emit({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } },
        });
      default:
        return;
    }
  };
}

describe('runCodexAppServerProbe', () => {
  it('is supported when every request the steering path needs answers with a result', async () => {
    const codex = fakeAppServer(healthyCodex());
    const outcome = await runCodexAppServerProbe(codex.spawn, {
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    expect(outcome).toEqual({ kind: 'supported', binaryVersion: '0.154.0' });
    const methods = codex.sent.map((m) => m.method).filter(Boolean);
    expect(methods).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start',
      'turn/steer',
      'turn/interrupt',
    ]);
    const steer = codex.sent.find((m) => m.method === 'turn/steer');
    expect(steer?.params.expectedTurnId).toBe('turn-1');
    expect(steer?.params.clientUserMessageId).toBeTypeOf('string');
    const turn = codex.sent.find((m) => m.method === 'turn/start');
    expect(turn?.params).toMatchObject({
      model: 'gpt-5.6-sol',
      effort: 'high',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  });

  it('is unsupported at spawn when the binary has no app-server subcommand', async () => {
    const codex = fakeAppServer((_msg, _emit, exit) =>
      exit({ exitCode: 2, stderr: "error: unrecognized subcommand 'app-server'\n" }),
    );
    const outcome = await runCodexAppServerProbe(codex.spawn, { model: null, effort: null });
    expect(outcome).toMatchObject({ kind: 'unsupported', stage: 'spawn' });
    expect(outcome.kind === 'unsupported' && outcome.detail).toContain('app-server');
  });

  it('is inconclusive when Docker itself could not start the container', async () => {
    const codex = fakeAppServer((_msg, _emit, exit) =>
      exit({ exitCode: 125, stderr: 'docker: Error response from daemon: No such image\n' }),
    );
    const outcome = await runCodexAppServerProbe(codex.spawn, { model: null, effort: null });
    expect(outcome.kind).toBe('inconclusive');
  });

  it('is unsupported at steer when the method is missing', async () => {
    const codex = fakeAppServer(
      healthyCodex({
        'turn/steer': (msg, emit) => {
          emit({
            id: msg.id,
            error: { code: -32600, message: 'Invalid request: unknown variant `turn/steer`' },
          });
          return true;
        },
      }),
    );
    const outcome = await runCodexAppServerProbe(codex.spawn, { model: null, effort: null });
    expect(outcome).toMatchObject({
      kind: 'unsupported',
      stage: 'steer',
      binaryVersion: '0.154.0',
    });
  });

  it('is unsupported at initialize when the handshake is refused', async () => {
    const codex = fakeAppServer(
      healthyCodex({
        initialize: (msg, emit) => {
          emit({ id: msg.id, error: { code: -32600, message: 'Invalid request' } });
          return true;
        },
      }),
    );
    const outcome = await runCodexAppServerProbe(codex.spawn, { model: null, effort: null });
    expect(outcome).toMatchObject({ kind: 'unsupported', stage: 'initialize' });
  });

  it('is inconclusive when the turn ends before its steer is answered', async () => {
    const codex = fakeAppServer(
      healthyCodex({
        'turn/start': (msg, emit) => {
          emit({ id: msg.id, result: { turn: { id: 'turn-1' } } });
          emit({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed' } },
          });
          return true;
        },
        'turn/steer': (msg, emit) => {
          emit({ id: msg.id, error: { code: -32600, message: 'no active turn to steer' } });
          return true;
        },
      }),
    );
    const outcome = await runCodexAppServerProbe(codex.spawn, { model: null, effort: null });
    expect(outcome.kind).toBe('inconclusive');
  });

  it('is supported when the turn completes on its own after an accepted steer', async () => {
    const codex = fakeAppServer(
      healthyCodex({
        'turn/steer': (msg, emit) => {
          emit({ id: msg.id, result: { turnId: 'turn-1' } });
          emit({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed' } },
          });
          return true;
        },
      }),
    );
    const outcome = await runCodexAppServerProbe(codex.spawn, { model: null, effort: null });
    expect(outcome.kind).toBe('supported');
  });

  it('is unsupported at the stage that never answered, within its budget', async () => {
    const codex = fakeAppServer(healthyCodex({ 'thread/start': () => true }));
    const outcome = await runCodexAppServerProbe(codex.spawn, {
      model: null,
      effort: null,
      timeoutMs: 50,
    });
    expect(outcome).toMatchObject({ kind: 'unsupported', stage: 'thread_start' });
  });

  it('is unsupported when the server asks the probe a question', async () => {
    const codex = fakeAppServer(
      healthyCodex({
        'turn/start': (msg, emit) => {
          emit({ id: msg.id, result: { turn: { id: 'turn-1' } } });
          emit({ id: 'srv-1', method: 'execCommandApproval', params: {} });
          return true;
        },
      }),
    );
    const outcome = await runCodexAppServerProbe(codex.spawn, { model: null, effort: null });
    expect(outcome).toMatchObject({ kind: 'unsupported', stage: 'server_request' });
  });
});
