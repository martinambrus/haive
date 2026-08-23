import { describe, expect, it } from 'vitest';
import {
  describeRetry,
  describeRetryReason,
  describeStall,
  isStalled,
  STALL_THRESHOLD_MS,
  type CliRetryInfo,
} from './stream-health';

const retry = (over: Partial<CliRetryInfo> = {}): CliRetryInfo => ({
  attempt: 1,
  maxRetries: 10,
  errorStatus: null,
  error: 'unknown',
  ...over,
});

describe('describeRetryReason', () => {
  it('reads a missing status as a transport failure, not a server answer', () => {
    // The measured shape of a network drop: no HTTP response arrived, so the binary
    // reports error "unknown" with a null status.
    expect(describeRetryReason(retry())).toBe('Connection problem');
  });

  it('names the two statuses that dominate real runs', () => {
    expect(describeRetryReason(retry({ errorStatus: 429, error: 'rate_limit' }))).toBe(
      'Rate limited',
    );
    expect(describeRetryReason(retry({ errorStatus: 529, error: 'overloaded' }))).toBe(
      'Provider overloaded',
    );
  });

  it('keeps the status visible for any other 5xx', () => {
    expect(describeRetryReason(retry({ errorStatus: 502, error: 'server_error' }))).toBe(
      'Server error (502)',
    );
  });

  it('falls back to the CLI’s own word for a status we have no wording for', () => {
    expect(describeRetryReason(retry({ errorStatus: 402, error: 'quota_exceeded' }))).toBe(
      'Quota exceeded (402)',
    );
    expect(describeRetryReason(retry({ errorStatus: 418, error: null }))).toBe('HTTP 418');
  });

  it('prefers a named error over the generic wording when there is no status', () => {
    expect(describeRetryReason(retry({ errorStatus: null, error: 'timeout' }))).toBe('Timeout');
  });
});

describe('describeRetry', () => {
  it('shows the attempt against its cap', () => {
    const copy = describeRetry(retry({ attempt: 3, maxRetries: 10, errorStatus: 429 }));
    expect(copy.label).toBe('3/10');
    expect(copy.detail).toContain('Rate limited');
    expect(copy.detail).toContain('attempt 3/10');
  });

  it('drops the cap when the event did not carry one', () => {
    expect(describeRetry(retry({ attempt: 2, maxRetries: null })).label).toBe('2');
  });
});

describe('isStalled', () => {
  const now = 1_800_000_000_000;

  it('says nothing before the first frame has been stamped', () => {
    expect(isStalled(null, now)).toBe(false);
  });

  it('stays quiet while frames are still arriving', () => {
    expect(isStalled(now - (STALL_THRESHOLD_MS - 1), now)).toBe(false);
  });

  it('speaks once the stream has been silent past the threshold', () => {
    expect(isStalled(now - STALL_THRESHOLD_MS, now)).toBe(true);
  });
});

describe('describeStall', () => {
  const now = 1_800_000_000_000;

  it('reports the silence as an observation, naming both causes', () => {
    const copy = describeStall(now - 7 * 60_000, now);
    expect(copy.label).toBe('7m');
    expect(copy.detail).toContain('No output for 7 min');
    expect(copy.detail).toContain('long tool call');
  });

  it('never rounds down to a bare 0m', () => {
    expect(describeStall(now - 90_000, now).label).toBe('1m');
  });
});
