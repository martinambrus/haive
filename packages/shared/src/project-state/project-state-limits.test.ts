import { describe, expect, it } from 'vitest';
import { MAX_AGENT_RULES_BYTES, PROJECT_STATE_LIMITS, recordReadable } from './limits.js';

const MIB = 1024 * 1024;
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
    expect(recordReadable(numbered(PROJECT_STATE_LIMITS.maxEntries - 1))).toEqual({
      readable: true,
    });
    expect(recordReadable(numbered(PROJECT_STATE_LIMITS.maxEntries))).toMatchObject({
      readable: false,
      reason: expect.stringMatching(/more than 4096 entries/) as string,
    });
  });

  it('counts every directory on a path', () => {
    const deep = files({ 'a/b/c/d/e.json': '{}\n' });
    const filler = numbered(PROJECT_STATE_LIMITS.maxEntries - 6, 'x');
    expect(recordReadable(new Map([...deep, ...filler]))).toEqual({ readable: true });
    expect(
      recordReadable(new Map([...deep, ...numbered(PROJECT_STATE_LIMITS.maxEntries - 5, 'x')])),
    ).toMatchObject({
      readable: false,
    });
  });

  it('takes a file of exactly 1 MiB and refuses one byte more, counting bytes rather than characters', () => {
    expect(recordReadable(files({ 'a.json': 'x'.repeat(MIB) }))).toEqual({ readable: true });
    expect(recordReadable(files({ 'a.json': 'x'.repeat(MIB + 1) }))).toMatchObject({
      readable: false,
      reason: expect.stringMatching(/a\.json is larger than 1 MiB/) as string,
    });
    expect(recordReadable(files({ 'a.json': 'é'.repeat(MIB / 2 + 1) }))).toMatchObject({
      readable: false,
    });
  });

  it('takes files totalling exactly 16 MiB and refuses one byte more', () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => [`f${i}.json`, 'x'.repeat(MIB)] as const);
    expect(recordReadable(new Map(sixteen))).toEqual({ readable: true });
    expect(recordReadable(new Map([...sixteen, ['one-more.json', 'x'] as const]))).toMatchObject({
      readable: false,
      reason: expect.stringMatching(/more than 16 MiB/) as string,
    });
  });
});
