import { describe, expect, it } from 'vitest';
import { emptyMcpSurface } from '../src/sandbox/mcp-surface.js';
import { resolveMcpExtraFiles } from '../src/queues/cli-exec/resolvers.js';
import { envDetectStep } from '../src/step-engine/steps/onboarding/01-env-detect.js';

// MEASURED 2026-09-13 on muse (api.meta.ai): `01-env-detect` runs with `disableTools`, so
// `--tools ''` strips the built-in `tool_search`, while the MCP surface it was handed
// anyway supplied tools the binary defers when ENABLE_TOOL_SEARCH is set. The endpoint
// answered `400 Deferred tools require tools.tool_search` and onboarding died at step 1.
// The step never needed a surface: its whole input is in the prompt, and at index 1 no RAG
// index exists (10-rag-populate is index 14).
describe('toolProfile: none', () => {
  it('gives a surface with nothing enabled on it', () => {
    const s = emptyMcpSurface();
    expect(s.rag.enabled).toBe(false);
    expect(s.chromeDevtools.enabled).toBe(false);
    expect(s.ddevControl.enabled).toBe(false);
    expect(s.userServers).toEqual({});
    // NOT ragOnly: that means "narrowed to rag_search alone", and this is narrower, so
    // the prompt must state the absence rather than promise a tool that is not wired.
    expect(s.ragOnly).toBe(false);
  });

  it('wires no files and needs no database to say so', async () => {
    // `null` as the db is the assertion: the none branch must return before anything
    // touches it, which is what makes it safe on every caller path.
    const res = await resolveMcpExtraFiles(
      null as never,
      'task-1',
      'claude-code',
      '/haive/workdir',
      null,
      'none',
      false,
    );
    expect(res).toEqual({ files: [], extraArgs: [] });
  });

  it('is declared by the step that disables built-in tools', () => {
    expect(envDetectStep.llm?.disableTools).toBe(true);
    expect(envDetectStep.llm?.toolProfile).toBe('none');
  });
});
