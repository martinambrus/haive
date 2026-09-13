import { beforeEach, describe, expect, it, vi } from 'vitest';

// The sandbox is the one boundary faked here: everything between the adapter's spec and the
// ExecutionOutcome — the JSON-RPC session, the fallback decision, the outcome shapes — is real.
const runInSandbox = vi.hoisted(() => vi.fn());
vi.mock('../src/sandbox/sandbox-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/sandbox-runner.js')>()),
  runInSandbox,
}));

import { executeCliSpec } from '../src/queues/cli-exec/exec-core.js';
import { defaultDeps } from '../src/queues/cli-exec/_shared.js';
import { CodexAdapter } from '../src/cli-adapters/codex.js';
import { isTransientCliFailure } from '../src/queues/cli-exec/failure-class.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

type Message = Record<string, any>;
type RunSpec = {
  command: string;
  args: string[];
  stdinPrompt?: string;
  onStdoutChunk?: (chunk: string) => void;
  onStdinWritable?: (writable: NodeJS.WritableStream) => void;
};

const provider = {
  id: 'prov-codex',
  name: 'codex',
  wrapperPath: null,
  executablePath: null,
  cliArgs: [],
  envVars: {},
  effortLevel: 'high',
  model: 'gpt-5.6-sol',
  cliVersion: '0.154.0',
} as unknown as CliProviderRecord;

const appServerSpec = () =>
  new CodexAdapter().buildCliInvocation(provider, 'do the work', { steeringMode: true });

const sandboxResult = (exitCode: number | null, stdout: string, stderr = '') => ({
  exitCode,
  stdout,
  stderr,
  durationMs: 1,
  timedOut: false,
  resolvedCommand: 'codex',
  wrapperId: null,
});

/** A scripted app-server. Output is delivered asynchronously, as a real pipe does. */
function appServer(
  respond: (
    msg: Message,
    emit: (m: Message) => void,
    exit: (code: number | null, stderr?: string) => void,
  ) => void,
) {
  return (spec: RunSpec) =>
    new Promise((resolve) => {
      let stdout = '';
      let done = false;
      const emit = (m: Message) =>
        setImmediate(() => {
          const line = `${JSON.stringify(m)}\n`;
          stdout += line;
          spec.onStdoutChunk?.(line);
        });
      const exit = (code: number | null, stderr = '') =>
        setImmediate(() => {
          if (done) return;
          done = true;
          resolve(sandboxResult(code, stdout, stderr));
        });
      const stdin = {
        writable: true,
        write(chunk: string) {
          for (const line of chunk.split('\n'))
            if (line.trim()) respond(JSON.parse(line), emit, exit);
          return true;
        },
        end() {
          stdin.writable = false;
          exit(0);
        },
      };
      spec.onStdinWritable?.(stdin as never);
    });
}

/** A codex exec run that answers `text` in `codex exec --json` events. */
function execRun(text: string) {
  return (spec: RunSpec) => {
    const events = [
      { type: 'thread.started', thread_id: 't' },
      { type: 'item.completed', item: { type: 'agent_message', text } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
    ];
    const stdout = events.map((e) => `${JSON.stringify(e)}\n`).join('');
    spec.onStdoutChunk?.(stdout);
    return Promise.resolve(sandboxResult(0, stdout));
  };
}

/** The measured 0.154.0 handshake, then `afterTurn` decides how the accepted turn ends. */
function handshake(
  afterTurn: (emit: (m: Message) => void, exit: (code: number | null) => void) => void,
) {
  return appServer((msg, emit, exit) => {
    if (msg.method === 'initialize') emit({ id: msg.id, result: { userAgent: 'haive/0.154.0' } });
    if (msg.method === 'thread/start') {
      emit({
        id: msg.id,
        result: { thread: { id: 'thread-1', cliVersion: '0.154.0' }, model: 'gpt-5.6-sol' },
      });
    }
    if (msg.method === 'turn/start') {
      emit({ id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
      emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
      afterTurn(emit, exit);
    }
  });
}

const usage = {
  method: 'thread/tokenUsage/updated',
  params: {
    threadId: 'thread-1',
    turnId: 'turn-1',
    tokenUsage: { total: { inputTokens: 900, cachedInputTokens: 600, outputTokens: 40 } },
  },
};
const completed = (status: string, error: unknown = null) => ({
  method: 'turn/completed',
  params: { threadId: 'thread-1', turn: { id: 'turn-1', status, error } },
});

beforeEach(() => {
  runInSandbox.mockReset();
});

describe('executeCliSpec on codex app-server', () => {
  it('returns the answer, usage and requested model of a turn that completed', async () => {
    runInSandbox.mockImplementationOnce(
      handshake((emit, exit) => {
        emit({
          method: 'item/completed',
          params: { turnId: 'turn-1', item: { type: 'agentMessage', id: 'a', text: 'DONE' } },
        });
        emit(usage);
        emit(completed('completed'));
        exit(0);
      }),
    );
    const outcome = await executeCliSpec(appServerSpec(), defaultDeps, 60_000);
    expect(runInSandbox).toHaveBeenCalledTimes(1);
    expect(outcome.rawOutput).toBe('DONE');
    expect(outcome.errorMessage).toBeNull();
    expect(outcome.tokenUsage).toEqual({
      inputTokens: 900,
      outputTokens: 40,
      totalTokens: 940,
      cacheReadTokens: 600,
    });
    expect(outcome.modelIdentity?.requested).toBe('gpt-5.6-sol');
    expect(outcome.codexAppServer).toEqual({ failure: null, binaryVersion: '0.154.0' });
  });

  it('re-runs the same invocation on codex exec when the app-server never accepts the turn', async () => {
    runInSandbox
      .mockImplementationOnce(
        appServer((_msg, _emit, exit) => exit(2, "error: unexpected argument '--json' found\n")),
      )
      .mockImplementationOnce(execRun('ANSWER FROM EXEC'));
    const outcome = await executeCliSpec(appServerSpec(), defaultDeps, 60_000);
    expect(runInSandbox).toHaveBeenCalledTimes(2);
    const execSpec = runInSandbox.mock.calls[1]![0] as RunSpec;
    expect(execSpec.args[0]).toBe('exec');
    expect(execSpec.args).not.toContain('do the work');
    expect(execSpec.stdinPrompt).toBe('do the work');
    expect(outcome.rawOutput).toBe('ANSWER FROM EXEC');
    expect(outcome.errorMessage).toBeNull();
    expect(outcome.codexAppServer?.failure).toEqual({
      stage: 'spawn',
      detail: "error: unexpected argument '--json' found",
    });
    expect(outcome.streamLog).toContain('codex app-server unavailable at spawn');
  });

  it('fails a run whose accepted turn never completed, as a transient the step re-runs', async () => {
    runInSandbox.mockImplementationOnce(handshake((_emit, exit) => exit(0)));
    const outcome = await executeCliSpec(appServerSpec(), defaultDeps, 60_000);
    expect(runInSandbox).toHaveBeenCalledTimes(1);
    expect(outcome.codexAppServer?.failure?.stage).toBe('stream');
    expect(outcome.errorMessage).toMatch(/^codex app-server transport failed \(stream\)/);
    expect(
      isTransientCliFailure({ exitCode: outcome.exitCode, errorMessage: outcome.errorMessage }),
    ).toBe(true);
  });

  it('records no transport failure for a run Haive killed', async () => {
    runInSandbox.mockImplementationOnce(handshake((_emit, exit) => exit(137)));
    const outcome = await executeCliSpec(appServerSpec(), defaultDeps, 60_000);
    expect(runInSandbox).toHaveBeenCalledTimes(1);
    expect(outcome.codexAppServer?.failure).toBeNull();
  });

  it('records no verdict and re-runs nothing when Docker never started the container', async () => {
    runInSandbox.mockImplementationOnce(() =>
      Promise.resolve(
        sandboxResult(125, '', 'docker: Error response from daemon: No such image\n'),
      ),
    );
    const outcome = await executeCliSpec(appServerSpec(), defaultDeps, 60_000);
    expect(runInSandbox).toHaveBeenCalledTimes(1);
    expect(outcome.codexAppServer?.failure).toBeNull();
    expect(outcome.errorMessage).toMatch(/125|No such image/);
  });

  it('reports a failed turn in exec wording, with no transport failure', async () => {
    runInSandbox.mockImplementationOnce(
      handshake((emit, exit) => {
        emit(usage);
        emit(completed('failed', { message: "You've hit your usage limit." }));
        exit(0);
      }),
    );
    const outcome = await executeCliSpec(appServerSpec(), defaultDeps, 60_000);
    expect(outcome.errorMessage).toBe("codex turn failed: You've hit your usage limit.");
    expect(outcome.codexAppServer?.failure).toBeNull();
  });
});
