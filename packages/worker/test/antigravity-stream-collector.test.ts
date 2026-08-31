import { describe, expect, it } from 'vitest';
import {
  createAntigravityStreamCollector,
  extractAntigravityStreamOutput,
} from '../src/cli-executor/antigravity-stream.js';
import { cliAdapterRegistry } from '../src/cli-adapters/registry.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

/* Captured VERBATIM from the shipped binary (agy --input-format stream-json
 * --output-format stream-json, authenticated, exit 0), tools list trimmed. Using
 * the real bytes is the point: a hand-written shape would only prove the parser
 * agrees with my memory of the format. */
const CID = '4eeb7dfd-37ca-4adc-98ca-253d648f6a72';
const REAL_RUN = [
  `{"event":"init","conversation_id":"${CID}","init":{"cwd":"/tmp/wd","tools":["run_command","view_file"],"permission_mode":"always-proceed"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":0,"state":"DONE","step_type":"user_input"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":4.365389906,"usage":{"input_tokens":13823,"output_tokens":91,"thinking_tokens":90,"cache_read_tokens":0,"total_tokens":13914}}}`,
  `{"event":"result","result":{"conversation_id":"${CID}","status":"SUCCESS","response":"OK\\n","duration_seconds":4.413400738,"num_turns":1,"usage":{"input_tokens":13823,"output_tokens":91,"thinking_tokens":90,"cache_read_tokens":0,"total_tokens":13914}}}`,
].join('\n');

/* Also verbatim: what agy emits when it cannot run at all. It reports this as a
 * FIELD and exits 1, which is what makes the switch worth making — the same
 * class of failure used to be recoverable only by parsing its log file. */
const AUTH_FAILURE =
  '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}';

/* --print-timeout firing mid-run: a real answer was in progress, so usage is
 * non-zero while response is empty. */
const PRINT_TIMEOUT =
  '{"event":"result","result":{"conversation_id":"ea84ab83","status":"ERROR","response":"","error":"timeout waiting for response","duration_seconds":1.899635344,"num_turns":1,"usage":{"input_tokens":13843,"output_tokens":778,"thinking_tokens":706,"cache_read_tokens":0,"total_tokens":14621}}}';

describe('antigravity stream-json collector', () => {
  it('reads the answer and usage out of a real successful run', () => {
    const c = createAntigravityStreamCollector();
    c.onChunk(REAL_RUN + '\n');
    expect(c.isJsonl()).toBe(true);
    expect(c.getResult()).toBe('OK\n');
    expect(c.getNoResultReason()).toBeNull();
    expect(c.getTokenUsage()).toEqual({ inputTokens: 13823, outputTokens: 91, totalTokens: 13914 });
  });

  it('streams text_delta as prose in order', () => {
    const seen: string[] = [];
    const c = createAntigravityStreamCollector((t) => seen.push(t));
    c.onChunk(REAL_RUN + '\n');
    // Concatenation must equal the final response exactly: a delta emitted twice
    // would double the answer in the live view while the stored result stayed right.
    expect(seen.join('')).toBe('OK\n');
  });

  it('survives a chunk boundary mid-line', () => {
    const c = createAntigravityStreamCollector();
    const whole = REAL_RUN + '\n';
    const cut = Math.floor(whole.length / 2);
    c.onChunk(whole.slice(0, cut));
    c.onChunk(whole.slice(cut));
    expect(c.getResult()).toBe('OK\n');
    expect(c.getMalformedLineCount()).toBe(0);
  });

  it('reports the CLI’s own error when a run produced no answer', () => {
    const c = createAntigravityStreamCollector();
    c.onChunk(AUTH_FAILURE + '\n');
    expect(c.getResult()).toBeNull();
    expect(c.getNoResultReason()).toBe('authentication failed or timed out');
  });

  it('keeps the usage a timed-out run had already spent', () => {
    // The tokens were billed whether or not an answer came back, so dropping
    // them would under-report spend on exactly the runs that cost most.
    const c = createAntigravityStreamCollector();
    c.onChunk(PRINT_TIMEOUT + '\n');
    expect(c.getNoResultReason()).toBe('timeout waiting for response');
    expect(c.getTokenUsage()).toEqual({
      inputTokens: 13843,
      outputTokens: 778,
      totalTokens: 14621,
    });
  });

  it('does not add thinking tokens on top of output', () => {
    // input + output = total in every observed run; thinking is a SUBSET of
    // output (90 of 91), so summing it would inflate every antigravity bill.
    const c = createAntigravityStreamCollector();
    c.onChunk(REAL_RUN + '\n');
    const u = c.getTokenUsage()!;
    expect(u.inputTokens + u.outputTokens).toBe(u.totalTokens);
  });

  it('counts malformed lines instead of throwing', () => {
    const c = createAntigravityStreamCollector();
    c.onChunk('not json\n' + REAL_RUN + '\n');
    expect(c.getMalformedLineCount()).toBe(1);
    expect(c.getResult()).toBe('OK\n');
  });

  it('reports plain text as not-jsonl so the legacy path still runs', () => {
    // An older binary that ignored the flags must fall through to plain output
    // rather than being reported as an empty structured run.
    const c = createAntigravityStreamCollector();
    c.onChunk('just some prose\n');
    expect(c.isJsonl()).toBe(false);
    expect(c.getResult()).toBeNull();
  });

  it('one-shot extraction agrees with the streaming collector', () => {
    const x = extractAntigravityStreamOutput(REAL_RUN);
    expect(x.text).toBe('OK\n');
    expect(x.eventCount).toBeGreaterThan(0);
    expect(x.tokenUsage?.totalTokens).toBe(13914);
  });
});

const provider = () =>
  ({
    id: 'p1',
    name: 'antigravity',
    label: 'antigravity',
    enabled: true,
    authMode: 'subscription',
    envVars: {},
    cliArgs: [],
    executablePath: '',
    model: null,
    effortLevel: null,
  }) as unknown as CliProviderRecord;

describe('antigravity adapter invocation', () => {
  const spec = cliAdapterRegistry
    .get('antigravity')
    .buildCliInvocation(provider(), 'expand this node', { cwd: '/haive/workdir' } as never);

  it('asks for stream-json on both directions', () => {
    // --input-format stream-json is documented as REQUIRING the matching output
    // format; sending one without the other is a flag error, not a degraded run.
    expect(spec.args).toContain('--input-format');
    expect(spec.args).toContain('--output-format');
    expect(spec.args.filter((a) => a === 'stream-json')).toHaveLength(2);
    expect(spec.outputFormat).toBe('antigravity-stream-json');
  });

  it('passes no -p, which is a string flag and would eat the next argument', () => {
    // MEASURED: a bare `-p` fails parsing with "flag needs an argument: -p".
    expect(spec.args).not.toContain('-p');
    expect(spec.args).not.toContain('--print');
    expect(spec.args).not.toContain('--prompt');
  });

  it('delivers the prompt as one NDJSON user message', () => {
    expect(spec.stdinPrompt).toBe(
      JSON.stringify({
        event: 'user',
        message: { role: 'user', content: 'expand this node' },
      }) + '\n',
    );
  });

  it('raises the CLI’s own 5-minute print cap out of the way', () => {
    // Left at its default, agy aborts any run past 5m with "timeout waiting for
    // response" — inside Haive's own multi-hour budget, so runs would truncate.
    const i = spec.args.indexOf('--print-timeout');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(spec.args[i + 1]).toBe('24h');
  });

  it('still captures the agy log for the exit-0 quota path', () => {
    expect(spec.args).toContain('--log-file');
    expect(spec.captureFile).toBeTruthy();
  });
});
