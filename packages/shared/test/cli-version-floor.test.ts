import { describe, expect, it } from 'vitest';
import { isRunnableCliVersion } from '../src/cli-providers/install-metadata.js';

// Each floor is the first build that can run Haive's command line at all — MEASURED per build
// with Haive's argv (install-metadata.ts says what each older build dies on).
describe('isRunnableCliVersion', () => {
  it('refuses grok builds before 0.2.116, which lack streaming-messages-json', () => {
    expect(isRunnableCliVersion('grok', '0.1.202')).toBe(false);
    expect(isRunnableCliVersion('grok', '0.2.115')).toBe(false);
    expect(isRunnableCliVersion('grok', '0.2.116')).toBe(true);
    expect(isRunnableCliVersion('grok', '1.0.38')).toBe(true);
  });

  it('refuses gemini builds before 0.6.0, which lack --output-format', () => {
    expect(isRunnableCliVersion('gemini', '0.0.1')).toBe(false);
    expect(isRunnableCliVersion('gemini', '0.5.5')).toBe(false);
    expect(isRunnableCliVersion('gemini', '0.6.0')).toBe(true);
    expect(isRunnableCliVersion('gemini', '0.60.0')).toBe(true);
  });

  it('compares each part as a number, not as text', () => {
    expect(isRunnableCliVersion('grok', '0.10.0')).toBe(true);
    expect(isRunnableCliVersion('gemini', '0.10.0')).toBe(true);
  });

  it('never blocks a CLI without a floor, nor a version it cannot parse', () => {
    expect(isRunnableCliVersion('claude-code', '2.1.41')).toBe(true);
    expect(isRunnableCliVersion('amp', '0.0.1789300838-gde32db')).toBe(true);
    expect(isRunnableCliVersion('grok', 'latest')).toBe(true);
  });
});
