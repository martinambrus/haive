import { describe, expect, it } from 'vitest';
import { formatBytes } from './format-bytes';

describe('formatBytes', () => {
  it('reports raw bytes without a decimal', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('carries one decimal from KB upward', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    // The retention card's real numbers: 268 MB of transcripts, 177 MB of prompts.
    expect(formatBytes(268_322_538)).toBe('255.9 MB');
    expect(formatBytes(176_627_474)).toBe('168.4 MB');
  });

  it('stops climbing at TB rather than inventing a unit', () => {
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
    expect(formatBytes(1024 ** 5)).toBe('1024.0 TB');
  });

  it('renders a missing or impossible size as zero rather than NaN', () => {
    // The usage endpoint coalesces to 0, but a failed fetch leaves the caller with
    // undefined and a "NaN undefined" chip is worse than no chip.
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});
