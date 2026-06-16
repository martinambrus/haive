import { describe, it, expect } from 'vitest';
import { buildBrowserModeOptions } from './_browser-modes.js';

const values = (opts: { value: string }[]) => opts.map((o) => o.value);

describe('buildBrowserModeOptions', () => {
  it('offers mcp + interactive whenever a runner is present (ddev OR app-runner)', () => {
    expect(values(buildBrowserModeOptions({ ddevMode: true, appRunnerMode: false }))).toEqual([
      'mcp',
      'interactive',
      'skip',
    ]);
    expect(values(buildBrowserModeOptions({ ddevMode: false, appRunnerMode: true }))).toEqual([
      'mcp',
      'interactive',
      'skip',
    ]);
  });

  it('offers only skip with no runner (nothing to test against)', () => {
    expect(values(buildBrowserModeOptions({ ddevMode: false, appRunnerMode: false }))).toEqual([
      'skip',
    ]);
  });
});
