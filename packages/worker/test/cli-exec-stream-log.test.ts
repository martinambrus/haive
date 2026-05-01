import { describe, expect, it, vi } from 'vitest';
import { formatCliHeader, quoteArg } from '../src/queues/cli-exec-queue.js';
import { wrapStreamCallback } from '../src/queues/cli-stream-publisher.js';

// publishCliChunk hits the real Redis client via getRedis(). Stubbing the
// whole module isn't worth the ESM gymnastics for a simple tee test — we
// just point Redis at a no-op that throws (caught internally) so the
// function runs through its happy path without contacting Redis.
vi.mock('../src/redis.js', () => ({
  getRedis: () => ({
    xadd: async () => 'ok',
    expire: async () => 1,
  }),
}));

describe('quoteArg (terminal-header pretty quoting)', () => {
  it('returns bare unquoted form for plain identifiers', () => {
    expect(quoteArg('--flag')).toBe('--flag');
    expect(quoteArg('claude')).toBe('claude');
    expect(quoteArg('value-with-dashes_and_underscore')).toBe('value-with-dashes_and_underscore');
  });

  it('single-quotes args with whitespace or shell metachars', () => {
    expect(quoteArg('hello world')).toBe(`'hello world'`);
    expect(quoteArg('multi\nline')).toBe(`'multi\nline'`);
    expect(quoteArg('a;b')).toBe(`'a;b'`);
    expect(quoteArg('a|b')).toBe(`'a|b'`);
  });

  it('switches to double quotes when the body has a single-quote (apostrophe) and nothing that double-quote would expand', () => {
    expect(quoteArg("it's a test")).toBe(`"it's a test"`);
    expect(quoteArg("don't")).toBe(`"don't"`);
  });

  it('falls back to POSIX close-escape-reopen when the arg has BOTH apostrophes and shell-expansion chars', () => {
    expect(quoteArg("it's $HOME")).toBe(`'it'\\''s $HOME'`);
    expect(quoteArg("he said `hi` and 'bye'")).toBe(`'he said \`hi\` and '\\''bye'\\'''`);
  });

  it('escapes embedded literal double-quotes when using the double-quoted form', () => {
    // Has `'` to trigger double-quoting and `"` which must be escaped.
    expect(quoteArg(`it's "quoted"`)).toBe(`"it's \\"quoted\\""`);
  });
});

describe('formatCliHeader', () => {
  it('renders the workdir comment line and the cyan-prompt command line', () => {
    const header = formatCliHeader(
      { command: 'claude', args: ['-p', 'hello world'], env: {}, cwd: '/tmp' },
      '/haive/workdir',
    );
    expect(header).toContain('# workdir: /haive/workdir');
    expect(header).toContain('claude -p ');
    expect(header).toContain(`'hello world'`);
    // ANSI: dim grey for metadata + cyan `$` prompt.
    expect(header).toContain('\x1b[2m');
    expect(header).toContain('\x1b[36m$\x1b[0m');
    // Must end on a CR/LF pair so xterm cursor moves to the next line
    // before the first stdout chunk arrives.
    expect(header.endsWith('\r\n')).toBe(true);
  });

  it('does NOT truncate long prompt args (full untruncated invocation is the observability win)', () => {
    const longPrompt = 'a'.repeat(2000);
    const header = formatCliHeader(
      { command: 'claude', args: ['-p', longPrompt], env: {}, cwd: '/tmp' },
      '/wd',
    );
    expect(header).toContain(longPrompt);
  });
});

describe('wrapStreamCallback', () => {
  it('returns the original callback unchanged when invocationId is missing', () => {
    const original = (_chunk: string) => {};
    expect(wrapStreamCallback(null, 'stdout', original)).toBe(original);
    expect(wrapStreamCallback(undefined, 'stdout', original)).toBe(original);
  });

  it('forwards each chunk to the inner callback when invocationId is set', () => {
    const seen: string[] = [];
    const wrapped = wrapStreamCallback('inv-1', 'stdout', (chunk) => seen.push(chunk));
    wrapped!('first chunk');
    wrapped!('second chunk');
    expect(seen).toEqual(['first chunk', 'second chunk']);
  });

  it('survives an inner-callback exception so the Redis publish still fires', () => {
    const wrapped = wrapStreamCallback('inv-1', 'stdout', () => {
      throw new Error('inner boom');
    });
    // Must not throw — the wrapper catches inner errors and continues
    // so a buggy collector cannot kill the publish loop.
    expect(() => wrapped!('chunk')).not.toThrow();
  });

  it('returns a new function reference (not the original) when wrapping is active', () => {
    const original = (_chunk: string) => {};
    const wrapped = wrapStreamCallback('inv-1', 'stdout', original);
    expect(wrapped).not.toBe(original);
    expect(typeof wrapped).toBe('function');
  });
});
