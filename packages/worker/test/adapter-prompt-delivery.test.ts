import { describe, expect, it } from 'vitest';
import { cliAdapterRegistry } from '../src/cli-adapters/registry.js';
import { PROMPT_ARGV_LIMIT_BYTES } from '../src/cli-adapters/prompt-delivery.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

const SMALL = 'expand this node';
const HUGE = 'x'.repeat(PROMPT_ARGV_LIMIT_BYTES + 1);

const provider = (name: string): CliProviderRecord =>
  ({
    id: 'p1',
    name,
    label: name,
    enabled: true,
    authMode: 'subscription',
    envVars: {},
    cliArgs: [],
    executablePath: '',
    // ollama refuses to build a command without one, by design.
    model: name === 'ollama' ? 'gpt-oss:20b' : null,
    effortLevel: null,
  }) as unknown as CliProviderRecord;

const build = (name: string, prompt: string) =>
  cliAdapterRegistry.get(name as never).buildCliInvocation(provider(name), prompt, {
    cwd: '/haive/workdir',
  } as never);

/** Reads a prompt from stdin, per its own --help in the shipped sandbox image. */
const STDIN_CAPABLE = [
  'codex',
  'amp',
  'claude-code',
  'zai',
  'ollama',
  'muse',
  'openrouter',
  'gemini',
];
/** Takes the prompt from a PATH instead — verified against the real binary. */
const FILE_CAPABLE = ['grok'];
/** Takes the prompt as an NDJSON line on stdin at EVERY size, so it is never
 *  exposed to the argv limit in the first place — `--input-format stream-json`
 *  has no argv form to fall back to. */
const STDIN_ALWAYS = ['antigravity'];

describe('every adapter, ordinary prompt', () => {
  for (const name of [...STDIN_CAPABLE, ...FILE_CAPABLE]) {
    it(`${name} still passes it as an argument`, () => {
      // The guard on every existing run: below the threshold nothing changed.
      const spec = build(name, SMALL);
      expect(spec.args).toContain(SMALL);
      expect(spec.stdinPrompt).toBeUndefined();
    });
  }
});

describe('stdin-only adapters, ordinary prompt', () => {
  for (const name of STDIN_ALWAYS) {
    it(`${name} sends even a small prompt over stdin`, () => {
      const spec = build(name, SMALL);
      expect(spec.stdinPrompt).toContain(SMALL);
      expect(spec.args).not.toContain(SMALL);
    });
  }
});

describe('every adapter, oversized prompt', () => {
  for (const name of STDIN_ALWAYS) {
    it(`${name} keeps it out of argv at any size`, () => {
      const spec = build(name, HUGE);
      expect(spec.stdinPrompt).toContain(HUGE);
      expect(spec.args.some((a) => a.length > PROMPT_ARGV_LIMIT_BYTES)).toBe(false);
    });
  }

  for (const name of STDIN_CAPABLE) {
    it(`${name} sends it over stdin instead of argv`, () => {
      const spec = build(name, HUGE);
      expect(spec.stdinPrompt).toBe(HUGE);
      // The whole point: nothing that large may reach the argument list.
      expect(spec.args.some((a) => a.length > PROMPT_ARGV_LIMIT_BYTES)).toBe(false);
    });
  }

  for (const name of FILE_CAPABLE) {
    it(`${name} writes it to a file and points at the path`, () => {
      // grok's REPL needs a TTY so stdin is not a route (bare `grok` with piped
      // input dies with ENXIO), but `--prompt-file` has no size limit at all.
      const spec = build(name, HUGE);
      expect(spec.promptFile?.content).toBe(HUGE);
      expect(spec.args).toContain('--prompt-file');
      expect(spec.args).toContain(spec.promptFile!.containerPath);
      // `-p` is dropped: the two are alternative ways to say the same thing.
      expect(spec.args).not.toContain('-p');
      expect(spec.args.some((a) => a.length > PROMPT_ARGV_LIMIT_BYTES)).toBe(false);
    });
  }
});

describe('gemini prompt delivery', () => {
  const AT_CAP = 'x'.repeat(PROMPT_ARGV_LIMIT_BYTES);

  it('keeps a prompt exactly at the cap in argv, byte-identical to before', () => {
    const spec = build('gemini', AT_CAP);
    expect(spec.args).toEqual(['-p', AT_CAP, '--output-format', 'json', '--yolo']);
    expect(spec.stdinPrompt).toBeUndefined();
  });

  it('sends a prompt one byte over the cap on stdin with no prompt in argv', () => {
    const spec = build('gemini', HUGE);
    expect(spec.stdinPrompt).toBe(HUGE);
    expect(spec.args).toEqual(['--output-format', 'json', '--yolo']);
  });

  it('sizes the cap in bytes, so a multi-byte prompt under the character count still goes to stdin', () => {
    const wide = '\u2014'.repeat(PROMPT_ARGV_LIMIT_BYTES / 3 + 1);
    expect(wide.length).toBeLessThan(PROMPT_ARGV_LIMIT_BYTES);
    const spec = build('gemini', wide);
    expect(spec.stdinPrompt).toBe(wide);
    expect(spec.args).not.toContain('-p');
  });
});
