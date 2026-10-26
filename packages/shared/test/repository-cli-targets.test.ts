import { describe, expect, it } from 'vitest';
import * as state from '../src/project-state/index.js';

const derive = (names: string[], languages: string[] = []) => {
  const fn = (
    state as unknown as {
      deriveRenderTargets?: (
        n: string[],
        l: string[],
      ) => state.RenderTargets & { skillDirs: string[] };
    }
  ).deriveRenderTargets;
  expect(fn, 'repository target derivation is public').toBeTypeOf('function');
  return fn!(names, languages);
};
describe('repository CLI targets', () => {
  it('renders both installs targets without local provider rows and deduplicates shared directories', () => {
    const rendered = derive(['claude-code', 'codex', 'zai', 'claude-code'], ['php']);
    expect(rendered.agentTargets.map((t) => t.dir)).toEqual(['.claude/agents', '.codex/agents']);
    expect(rendered.skillDirs).toEqual(['.claude/skills', '.agents/skills']);
    expect(rendered.enabledCliProviders.map((p) => p.name)).toEqual([
      'claude-code',
      'codex',
      'zai',
    ]);
    expect(rendered.agentTargets[0]?.supportsLsp).toBe(true);
  });
  it('an explicit empty set has no fallback, and unknown portable members never invent paths', () => {
    expect(derive([]).agentTargets).toEqual([]);
    expect(derive(['future-cli']).skillDirs).toEqual([]);
    expect(derive(['future-cli', 'codex']).agentTargets).toEqual([
      { dir: '.codex/agents', format: 'toml', supportsLsp: false },
    ]);
  });
});
