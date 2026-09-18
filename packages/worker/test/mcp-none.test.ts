import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyMcpSurface } from '../src/sandbox/mcp-surface.js';
import { resolveMcpExtraFiles } from '../src/queues/cli-exec/resolvers.js';
import { envDetectStep } from '../src/step-engine/steps/onboarding/01-env-detect.js';
import {
  mergeCliMcpIntoTaskVolume,
  mergeGeminiMcpIntoSettings,
  writeMcpFileIntoTaskVolume,
} from '../src/sandbox/task-auth-volume.js';

vi.mock('../src/sandbox/task-auth-volume.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/task-auth-volume.js')>()),
  mergeGeminiMcpIntoSettings: vi.fn(async () => {}),
  mergeCliMcpIntoTaskVolume: vi.fn(async () => {}),
  writeMcpFileIntoTaskVolume: vi.fn(async () => {}),
}));

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

// Wiring nothing is not the same as leaving nothing wired. A `bind` delivery is self-clearing,
// because its file is written per invocation; gemini, codex and grok write INTO the per-task auth
// volume, which dies with the TASK. So an earlier full-surface dispatch in the same task — and
// `00-model-health` is index 0, so that is the normal case — leaves its servers on disk for a
// `none` invocation whose prompt says none are wired. Antigravity USED to be in that list: it
// moved to `bind` once agy's real read path was measured to sit outside its auth mount, so it is
// now self-clearing too.
describe('toolProfile: none clears a volume-backed surface', () => {
  const clear = (provider: string) =>
    resolveMcpExtraFiles(
      null as never,
      'task-1',
      provider as never,
      '/haive/workdir',
      'img:tag',
      'none',
      false,
    );

  beforeEach(() => vi.clearAllMocks());

  it('touches no volume for a bind-delivery provider', async () => {
    await clear('claude-code');
    expect(mergeGeminiMcpIntoSettings).not.toHaveBeenCalled();
    expect(mergeCliMcpIntoTaskVolume).not.toHaveBeenCalled();
    expect(writeMcpFileIntoTaskVolume).not.toHaveBeenCalled();
  });

  it('tells gemini to run on an empty map, since its no-op guard would skip it', async () => {
    await clear('gemini');
    expect(mergeGeminiMcpIntoSettings).toHaveBeenCalledWith('task-1', {}, undefined, {
      clear: true,
    });
  });

  for (const provider of ['codex', 'grok']) {
    it(`reconciles ${provider} to an empty server set`, async () => {
      await clear(provider);
      expect(mergeCliMcpIntoTaskVolume).toHaveBeenCalledWith('task-1', provider, 'img:tag', []);
    });
  }

  // Antigravity is `bind` now, so it clears by ABSENCE like the claude family rather than having
  // an empty file written into the auth volume. Writing one there was never effective anyway: the
  // path was outside the auth mount, where the volume writer skips with a warn and reports success.
  it('touches no volume for antigravity, which clears by absence', async () => {
    await clear('antigravity');
    expect(mergeGeminiMcpIntoSettings).not.toHaveBeenCalled();
    expect(mergeCliMcpIntoTaskVolume).not.toHaveBeenCalled();
    expect(writeMcpFileIntoTaskVolume).not.toHaveBeenCalled();
  });

  it('does nothing for a provider that wires no MCP at all', async () => {
    await clear('amp');
    expect(mergeGeminiMcpIntoSettings).not.toHaveBeenCalled();
    expect(mergeCliMcpIntoTaskVolume).not.toHaveBeenCalled();
    expect(writeMcpFileIntoTaskVolume).not.toHaveBeenCalled();
  });
});
