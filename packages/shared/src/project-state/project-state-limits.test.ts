import { describe, expect, it } from 'vitest';
import { MAX_AGENT_RULES_BYTES, PROJECT_STATE_LIMITS, recordReadable } from './limits.js';

const MIB = 1024 * 1024;
const LIMITS = { maxEntries: 8, maxFileBytes: 16, maxTotalBytes: 32 };
const readable: typeof recordReadable = (files) => recordReadable(files, LIMITS);
const files = (entries: Record<string, string>) => new Map(Object.entries(entries));
const numbered = (n: number, dir = 'artifacts') =>
  new Map(Array.from({ length: n }, (_, i) => [`${dir}/f${i}.json`, '{}\n'] as const));

describe('recordReadable', () => {
  it('holds the caps a reader of the state directory enforces', () => {
    expect(PROJECT_STATE_LIMITS).toEqual({
      maxEntries: 4096,
      maxFileBytes: MIB,
      maxTotalBytes: 16 * MIB,
    });
  });

  it('caps the rules override at 64 KiB, as a limit of its own beside the reader caps', () => {
    expect(MAX_AGENT_RULES_BYTES).toBe(64 * 1024);
    expect(MAX_AGENT_RULES_BYTES).toBeLessThan(PROJECT_STATE_LIMITS.maxFileBytes);
  });

  it('counts a directory as an entry, once, however many files it holds', () => {
    expect(readable(numbered(LIMITS.maxEntries - 1))).toEqual({
      readable: true,
    });
    expect(readable(numbered(LIMITS.maxEntries))).toMatchObject({
      readable: false,
      reason: expect.stringMatching(/more than 8 entries/) as string,
    });
  });

  it('counts every directory on a path', () => {
    const deep = files({ 'a/b/c/d/e.json': '{}\n' });
    const filler = numbered(LIMITS.maxEntries - 6, 'x');
    expect(readable(new Map([...deep, ...filler]))).toEqual({ readable: true });
    expect(readable(new Map([...deep, ...numbered(LIMITS.maxEntries - 5, 'x')]))).toMatchObject({
      readable: false,
    });
  });

  it('takes a file at the cap and refuses one byte more, counting bytes rather than characters', () => {
    expect(readable(files({ 'a.json': 'x'.repeat(LIMITS.maxFileBytes) }))).toEqual({
      readable: true,
    });
    expect(readable(files({ 'a.json': 'x'.repeat(LIMITS.maxFileBytes + 1) }))).toMatchObject({
      readable: false,
      reason: expect.stringMatching(/a\.json is larger than 0\.0000152587890625 MiB/) as string,
    });
    expect(readable(files({ 'a.json': 'é'.repeat(LIMITS.maxFileBytes / 2 + 1) }))).toMatchObject({
      readable: false,
    });
  });

  it('takes files totalling exactly the cap and refuses one byte more', () => {
    const atCap = Array.from(
      { length: 2 },
      (_, i) => [`f${i}.json`, 'x'.repeat(LIMITS.maxFileBytes)] as const,
    );
    expect(readable(new Map(atCap))).toEqual({ readable: true });
    expect(readable(new Map([...atCap, ['one-more.json', 'x'] as const]))).toMatchObject({
      readable: false,
      reason: expect.stringMatching(/more than 0\.000030517578125 MiB/) as string,
    });
  });
});
