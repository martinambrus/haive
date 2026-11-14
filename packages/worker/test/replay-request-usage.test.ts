import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import {
  replayDatabase,
  replayRequestUsage,
  parseOptions,
  REPLAY_STREAM_LOG_BYTE_CAP,
} from '../scripts/replay-request-usage.js';
import { createStreamLogBuffer } from '../src/queues/cli-exec/stream-log-buffer.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/streams/${name}.json`, import.meta.url), 'utf8'));
const stream = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n');
const row = (events: unknown[], cli = 'claude-code', exitCode: number | null = 0) => ({
  cli,
  streamLog: stream(events),
  exitCode,
  mainModel: null,
});

describe('read-only request replay', () => {
  it('aggregates fixture coverage by CLI and main model without exposing row content', async () => {
    const events = fixture('request-claude');
    events[3].modelUsage = {};
    const billing = fixture('request-claude-billing');
    async function* source() {
      yield row(events);
      yield row(billing[0].events, 'grok');
      yield row(events.slice(0, -1), 'claude-code', 137);
      yield row(fixture('request-codex-exec'), 'codex');
    }
    const report = await replayRequestUsage(source());
    expect(report.total).toMatchObject({ invocations: 4, complete: 2, incomplete: 1, none: 1 });
    expect(report.byCli.find((r) => r.cli === 'claude-code')).toMatchObject({
      invocations: 2,
      complete: 1,
      incomplete: 1,
      incompleteReasons: expect.objectContaining({ 'result-count': 1 }),
    });
    expect(report.byMainModel.find((r) => r.model === 'grok-4.6')).toMatchObject({ complete: 1 });
    expect(report.counters).toMatchObject({
      emptyModelUsageAcceptedComplete: 1,
      killedFallbackRuns: 1,
    });
    expect(JSON.stringify(report)).not.toMatch(/requestId|msg_redacted|"result"|"usage"|"prompt"/);
  });

  it('counts same-name side-model excess and output-only contradictions without relaxing coverage', async () => {
    const sameName = fixture('request-claude');
    sameName[0].model = 'claude-haiku-4-5';
    for (const e of sameName) if (e.message) e.message.model = 'claude-haiku-4-5';
    sameName[3].modelUsage = {
      'claude-haiku-4-5': {
        inputTokens: 301,
        outputTokens: 5,
        cacheReadInputTokens: 70,
        cacheCreationInputTokens: 30,
      },
    };
    const outputOnly = fixture('request-claude');
    const duplicate = structuredClone(outputOnly[1]);
    duplicate.message.usage.output_tokens++;
    outputOnly.splice(2, 0, duplicate);
    const promptChange = structuredClone(outputOnly);
    promptChange[2].message.usage.input_tokens++;
    const report = await replayRequestUsage([row(sameName), row(outputOnly), row(promptChange)]);
    expect(report.total).toMatchObject({ complete: 0, incomplete: 3 });
    expect(report.counters).toMatchObject({
      sameNameSideModelCandidates: 1,
      outputOnlyContradictoryRuns: 1,
    });
  });

  it('skips pretty-printed stderr and non-event objects while replaying complete events', async () => {
    const good = row(fixture('request-claude'));
    const stderr = JSON.stringify({ diagnostic: { details: [{ message: 'retry' }] } }, null, 2);
    const report = await replayRequestUsage([
      {
        ...good,
        streamLog: `$ command\n${stderr}\n{"diagnostic":"retry"}\n${good.streamLog}\n[haive] exited 0\n`,
      },
    ]);
    expect(report.total).toMatchObject({ complete: 1, incomplete: 0, skippedNonEventLines: 3 });
    expect(report.byCli).toMatchObject([{ cli: 'claude-code', skippedNonEventLines: 3 }]);
    expect(report.total.incompleteReasons).not.toHaveProperty('malformed-stream');
  });

  it('counts explicitly event-prefixed broken lines as malformed without feeding transcript noise', async () => {
    const good = row(fixture('request-claude'));
    const report = await replayRequestUsage([
      { ...good, streamLog: `${good.streamLog}\n{"type":` },
    ]);
    expect(report.total).toMatchObject({ complete: 0, incomplete: 1, malformedEventLines: 1 });
    expect(report.total.incompleteReasons).toEqual({ 'malformed-event-line': 1 });
  });

  it('reports elided logs as unknown-truncated, including channels with no request list', async () => {
    const good = row(fixture('request-claude'));
    const buffer = createStreamLogBuffer({ headChars: 4, tailChars: 4 });
    buffer.push('x'.repeat(12));
    const report = await replayRequestUsage([
      { ...good, streamLog: `${buffer.toString()}\n${good.streamLog}` },
      { ...row([], 'gemini'), streamLog: buffer.toString() },
    ]);
    expect(report.total).toMatchObject({
      invocations: 2,
      complete: 0,
      incomplete: 0,
      none: 0,
      truncatedLogs: 2,
      'unknown-truncated': 2,
    });
    expect(report.byCli).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cli: 'claude-code', truncatedLogs: 1, 'unknown-truncated': 1 }),
        expect.objectContaining({ cli: 'gemini', truncatedLogs: 1, 'unknown-truncated': 1 }),
      ]),
    );
    expect(report.counters).toMatchObject({
      emptyModelUsageAcceptedComplete: 0,
      noResultFallbackRuns: 0,
    });
  });

  it('detects markerless logs at the byte cap with an injectable small limit', async () => {
    expect(REPLAY_STREAM_LOG_BYTE_CAP).toBe(4 * 1024 * 1024);
    const good = row(fixture('request-claude'));
    const report = await replayRequestUsage([good, { ...good, streamLog: `${good.streamLog}é` }], {
      streamLogByteCap: Buffer.byteLength(good.streamLog) + 2,
    });
    expect(report.total).toMatchObject({
      complete: 1,
      incomplete: 0,
      truncatedLogs: 1,
      'unknown-truncated': 1,
    });
  });

  it('validates options before opening a database', () => {
    expect(parseOptions([])).toEqual({ since: null, limit: null, cli: null });
    expect(
      parseOptions(['--since', '2026-11-01T00:00:00Z', '--limit', '2', '--cli', 'grok']),
    ).toEqual({
      since: '2026-11-01T00:00:00.000Z',
      limit: 2,
      cli: 'grok',
    });
    for (const args of [
      ['--limit', '0'],
      ['--limit', '1.2'],
      ['--since', 'yesterday'],
      ['--apply'],
      ['--cli', 'unknown'],
      ['--limit', '2', '--limit', '3'],
    ])
      expect(() => parseOptions(args)).toThrow();
  });

  it('replays Codex app-server evidence with the real session parser', async () => {
    const events = fixture('request-codex-app-server');
    const report = await replayRequestUsage([row(events, 'codex')]);
    expect(report.total).toMatchObject({ complete: 1, none: 0 });
    expect(report.byMainModel).toMatchObject([{ model: 'model-a', complete: 1 }]);
  });

  it('filters pretty-printed stderr before the Codex app-server parser too', async () => {
    const good = row(fixture('request-codex-app-server'), 'codex');
    const report = await replayRequestUsage([
      { ...good, streamLog: `{\n  "diagnostic": true\n}\n${good.streamLog}` },
    ]);
    expect(report.total).toMatchObject({ complete: 1, incomplete: 0, skippedNonEventLines: 1 });
  });

  it('keeps typed stream events with an id on their original channel', async () => {
    const claude = fixture('request-claude');
    claude[1].id = 'event-1';
    const codex = fixture('request-codex-exec');
    codex[0].id = 'event-2';
    const report = await replayRequestUsage([row(claude), row(codex, 'codex')]);
    expect(report.total).toMatchObject({ complete: 1, none: 1, incomplete: 0 });
  });

  it('counts aggregate-only Gemini and antigravity fixtures as having no request channel', async () => {
    const report = await replayRequestUsage([
      { ...row([], 'gemini'), streamLog: JSON.stringify(fixture('request-gemini')) },
      row(fixture('request-antigravity'), 'antigravity'),
    ]);
    expect(report.total).toMatchObject({ none: 2, incomplete: 0, complete: 0 });
  });

  it('counts a null exit as killed only after finalization', async () => {
    const events = fixture('request-claude').slice(0, -1);
    const report = await replayRequestUsage([
      { ...row(events, 'claude-code', null), ended: false },
      { ...row(events, 'claude-code', null), ended: true },
    ]);
    expect(report.counters).toMatchObject({ noResultFallbackRuns: 2, killedFallbackRuns: 1 });
  });

  it('counts a killed Ollama fallback from the retained recording without inferring output from thinking estimates', async () => {
    const events = readFileSync(new URL('./fixtures/streams/ollama.jsonl', import.meta.url), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const report = await replayRequestUsage([
      row(
        events.filter((e) => e.type !== 'result'),
        'ollama',
        137,
      ),
    ]);
    expect(report.counters).toMatchObject({
      killedFallbackRuns: 1,
      noResultFallbackRuns: 1,
      fallbackOutputZeroRuns: 1,
    });
    expect(report.total).toMatchObject({ complete: 0, incomplete: 1 });
  });

  it('opens a server-enforced read-only transaction and selects only replay columns through a cursor', async () => {
    const cursor = vi.fn(async function* () {
      yield [row(fixture('request-claude'))];
    });
    const select = vi.fn((_parts: TemplateStringsArray, ..._params: unknown[]) => ({ cursor }));
    const begin = vi.fn(async (_mode, fn) => fn(select));
    const db = { $client: { begin } } as unknown as Database;
    const options = parseOptions(['--cli', 'grok', '--limit', '2']);
    const report = await replayDatabase(db, options);
    expect(begin).toHaveBeenCalledWith(
      'isolation level repeatable read read only',
      expect.any(Function),
    );
    const [parts, ...params] = select.mock.calls[0]!;
    const query = (parts as unknown as string[]).join('?');
    expect(query).toMatch(/^\s*SELECT/);
    expect(query).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|prompt|raw_output)\b/i);
    expect(query).toContain('i.stream_log IS NOT NULL');
    expect(query).toContain('i.created_at >=');
    expect(query).toContain('ORDER BY i.created_at DESC, i.id DESC LIMIT');
    expect(params).toEqual([null, null, 'grok', 'grok', 2]);
    expect(cursor).toHaveBeenCalledWith(50);
    expect(report).toMatchObject({ options, total: { invocations: 1 } });
  });
  it('defaults to all database rows while consuming bounded cursor batches', async () => {
    const cursor = vi.fn(async function* () {
      yield [row(fixture('request-claude'))];
      yield [row(fixture('request-claude'))];
    });
    const select = vi.fn((_parts: TemplateStringsArray, ..._params: unknown[]) => ({ cursor }));
    const begin = vi.fn(async (_mode, fn) => fn(select));
    const db = { $client: { begin } } as unknown as Database;
    const report = await replayDatabase(db, parseOptions([]));
    expect(select.mock.calls[0]!.slice(1)).toEqual([null, null, null, null, null]);
    expect(cursor).toHaveBeenCalledWith(50);
    expect(report.total).toMatchObject({ invocations: 2, complete: 2 });
  });
});
