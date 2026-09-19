import { describe, expect, it } from 'vitest';
import { assertCliVersionRunnable } from '../src/routes/cli-providers.js';
import { HttpError } from '../src/context.js';

describe('assertCliVersionRunnable', () => {
  it('refuses a pin that cannot run, with a 400, a stable code and the floor to pick', () => {
    let thrown: unknown;
    try {
      assertCliVersionRunnable('grok', '0.2.115');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(400);
    expect((thrown as HttpError).code).toBe('cli_version_unsupported');
    expect((thrown as HttpError).message).toContain('0.2.116 or newer');
  });

  it('refuses gemini below its floor', () => {
    expect(() => assertCliVersionRunnable('gemini', '0.5.5')).toThrow(HttpError);
  });

  it('allows the floor itself, anything newer, and every CLI without a floor', () => {
    expect(() => assertCliVersionRunnable('grok', '0.2.116')).not.toThrow();
    expect(() => assertCliVersionRunnable('gemini', '0.60.0')).not.toThrow();
    expect(() => assertCliVersionRunnable('claude-code', '2.1.41')).not.toThrow();
  });
});
