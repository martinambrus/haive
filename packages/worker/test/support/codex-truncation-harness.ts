import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../../src/cli-adapters/codex.js';
import type { CliProviderRecord } from '../../src/cli-adapters/types.js';

/** codex 0.161.0 exec --json against a fake Responses endpoint answering response.incomplete
 *  with incomplete_details.reason "max_output_tokens": the identical request goes out six times
 *  (1 + "Reconnecting... 5/5"), each leaving the partial agent_message, then turn.failed. */
export const execFixture = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../fixtures/truncation/codex-exec-incomplete.jsonl',
  ),
  'utf8',
);
export const PARTIAL = '1, 2, 3, 4';
export const STDERR_NOISE =
  'WARNING: proceeding, even though we could not create PATH aliases\nReading additional input from stdin...\n';

export const provider = {
  id: 'prov-codex',
  name: 'codex',
  wrapperPath: null,
  executablePath: null,
  cliArgs: [],
  envVars: {},
  effortLevel: 'high',
  model: 'gpt-5.6-sol',
  cliVersion: '0.161.0',
} as unknown as CliProviderRecord;

export const execSpec = () => new CodexAdapter().buildCliInvocation(provider, 'do the work', {});
export const appServerSpec = () =>
  new CodexAdapter().buildCliInvocation(provider, 'do the work', { steeringMode: true });

export const sandboxResult = (exitCode: number | null, stdout: string, stderr = '') => ({
  exitCode,
  stdout,
  stderr,
  durationMs: 1,
  timedOut: false,
  resolvedCommand: 'codex',
  wrapperId: null,
});

type Message = Record<string, any>;
type RunSpec = {
  onStdoutChunk?: (chunk: string) => void;
  onStdinWritable?: (writable: NodeJS.WritableStream) => void;
};

export function execRun(stdout: string, exitCode: number) {
  return (spec: RunSpec) => {
    spec.onStdoutChunk?.(stdout);
    return Promise.resolve(sandboxResult(exitCode, stdout, STDERR_NOISE));
  };
}

/** The measured app-server handshake, then a turn that ends `failed` with `message`. */
export function failedAppServerTurn(message: string, partial: string | null) {
  return (spec: RunSpec) =>
    new Promise((resolve) => {
      let stdout = '';
      const emit = (m: Message) =>
        setImmediate(() => {
          const line = `${JSON.stringify(m)}\n`;
          stdout += line;
          spec.onStdoutChunk?.(line);
        });
      const respond = (msg: Message) => {
        if (msg.method === 'initialize')
          emit({ id: msg.id, result: { userAgent: 'haive/0.161.0' } });
        if (msg.method === 'thread/start') {
          emit({
            id: msg.id,
            result: { thread: { id: 'thread-1', cliVersion: '0.161.0' }, model: 'gpt-5.6-sol' },
          });
        }
        if (msg.method === 'turn/start') {
          emit({ id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
          emit({
            method: 'turn/started',
            params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
          });
          if (partial !== null) {
            emit({
              method: 'item/completed',
              params: { turnId: 'turn-1', item: { type: 'agentMessage', id: 'a', text: partial } },
            });
          }
          emit({
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: { id: 'turn-1', status: 'failed', error: { message } },
            },
          });
          setImmediate(() => setImmediate(() => resolve(sandboxResult(0, stdout))));
        }
      };
      spec.onStdinWritable?.({
        writable: true,
        write(chunk: string) {
          for (const line of chunk.split('\n')) if (line.trim()) respond(JSON.parse(line));
          return true;
        },
        end() {},
      } as never);
    });
}
