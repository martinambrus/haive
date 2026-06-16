import { describe, it, expect } from 'vitest';
import { buildBrowserModeOptions } from './_browser-modes.js';

const values = (opts: { value: string }[]) => opts.map((o) => o.value);

describe('buildBrowserModeOptions', () => {
  it('offers mcp + interactive whenever a runner is present (ddev OR app-runner)', () => {
    expect(values(buildBrowserModeOptions({ ddevMode: true, appRunnerMode: false }))).toEqual([
      'headless',
      'mcp',
      'interactive',
      'skip',
    ]);
    expect(values(buildBrowserModeOptions({ ddevMode: false, appRunnerMode: true }))).toEqual([
      'headless',
      'mcp',
      'interactive',
      'skip',
    ]);
  });

  it('offers only headless + skip with no runner', () => {
    expect(values(buildBrowserModeOptions({ ddevMode: false, appRunnerMode: false }))).toEqual([
      'headless',
      'skip',
    ]);
  });
});
