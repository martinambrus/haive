import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';

/** Replay REAL provider output through the shipped parser.
 *
 *  The other stream tests are thorough but every event in them is hand-authored, so they
 *  pin what we believe a provider emits. These fixtures are recordings: a provider that
 *  changes where it reports usage, or stops emitting a result event the way it used to,
 *  breaks here and nowhere else — without CI needing credentials.
 *
 *  Capture one with `test/capture-stream-fixture.ts --provider <name>`, which writes the
 *  scrubbed stream and, beside it, what the parser read from it at capture time.
 */
const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'streams');

interface ExpectedReading {
  provider: string;
  capturedAt: string;
  isStreamJson: boolean;
  result: string | null;
  noResultReason: string | null;
  malformedLines: number;
  tokenUsage: unknown;
  streamModelIdentity: unknown;
}

function fixtureNames(): string[] {
  if (!existsSync(FIXTURE_DIR)) return [];
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .sort();
}

const names = fixtureNames();

describe('recorded provider streams', () => {
  // Named rather than silent: a suite that quietly covers nothing is the failure mode
  // this whole area exists to prevent. `it` with no fixtures reports as a real test.
  it('has at least one recording to replay', () => {
    expect(
      names,
      'no fixtures in test/fixtures/streams — capture one with test/capture-stream-fixture.ts',
    ).not.toHaveLength(0);
  });

  for (const name of names) {
    describe(name, () => {
      const stem = path.join(FIXTURE_DIR, name);
      const raw = readFileSync(`${stem}.jsonl`, 'utf8');
      const expected = JSON.parse(readFileSync(`${stem}.expected.json`, 'utf8')) as ExpectedReading;

      /** Fed in one chunk and again split mid-line: the collector buffers partial NDJSON,
       *  and a real spawn delivers arbitrary chunk boundaries. */
      const read = (chunks: string[]) => {
        const collector = createStreamJsonCollector();
        for (const c of chunks) collector.onChunk(c);
        return {
          isStreamJson: collector.isStreamJson(),
          result: collector.getResult(),
          noResultReason: collector.getNoResultReason(),
          malformedLines: collector.getMalformedLineCount(),
          tokenUsage: collector.getTokenUsage(),
          streamModelIdentity: collector.getModelIdentity(),
        };
      };

      const asRecorded = {
        isStreamJson: expected.isStreamJson,
        result: expected.result,
        noResultReason: expected.noResultReason,
        malformedLines: expected.malformedLines,
        tokenUsage: expected.tokenUsage,
        streamModelIdentity: expected.streamModelIdentity,
      };

      it('parses to what it parsed to when it was recorded', () => {
        expect(read([raw])).toEqual(asRecorded);
      });

      it('parses the same when the stream arrives in split chunks', () => {
        // A real spawn splits wherever the pipe happens to flush, including mid-line.
        const mid = Math.floor(raw.length / 2);
        expect(read([raw.slice(0, mid), raw.slice(mid)])).toEqual(asRecorded);
      });

      it('carries no absolute host path or uuid past the scrubber', () => {
        // The fixture is committed; the scrub is a floor, and this is the check that it held.
        expect(raw).not.toMatch(/\/(?:home|Users)\/[a-z]/i);
        expect(raw).not.toMatch(
          /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
        );
      });
    });
  }
});
