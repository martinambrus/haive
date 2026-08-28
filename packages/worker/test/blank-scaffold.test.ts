import { describe, expect, it } from 'vitest';
import { buildBlankRenderContext } from '../src/repo/blank-scaffold.js';
import { expandManifestFor } from '../src/step-engine/template-manifest.js';

function mockDb(providers: { name: string; enabled: boolean }[], rtkEnabled = false) {
  const rows: Record<string, unknown[]> = {
    cli_providers: providers,
    repositories: [{ rtkEnabled }],
  };
  let which: string | null = null;
  const thenable = (data: unknown[]) => ({
    then: (res: (v: unknown[]) => unknown) => Promise.resolve(data).then(res),
    limit: async () => data,
  });
  return {
    select: () => ({
      from: (table: unknown) => {
        const sym = Object.getOwnPropertySymbols(table as object).find(
          (s) => s.description === 'drizzle:Name',
        );
        which = sym ? ((table as Record<symbol, string>)[sym] ?? null) : null;
        return { where: () => thenable(rows[which ?? ''] ?? []) };
      },
    }),
  } as never;
}

const ARGS = { userId: 'u1', repositoryId: 'r1', repoName: 'greenfield' };

describe('buildBlankRenderContext', () => {
  it('knows only the name — everything else is genuinely unknown', async () => {
    // A detector would fill these from code. There is no code, and inventing a
    // stack for an empty directory would be worse than admitting it.
    const ctx = await buildBlankRenderContext(
      mockDb([{ name: 'claude-code', enabled: true }]),
      ARGS,
    );
    expect(ctx.projectInfo.name).toBe('greenfield');
    expect(ctx.framework).toBeNull();
    expect(ctx.projectInfo.primaryLanguage).toBeNull();
    expect(ctx.lspLanguages).toEqual([]);
    expect(ctx.customAgentSpecs).toEqual([]);
  });

  it('installs every agent rather than choosing for the user', async () => {
    // The manifest reads an empty acceptedAgentIds as "no snapshot" and emits
    // all of them, so a blank repo needs no agent-selection decision.
    const ctx = await buildBlankRenderContext(
      mockDb([{ name: 'claude-code', enabled: true }]),
      ARGS,
    );
    expect(ctx.acceptedAgentIds).toEqual([]);
  });

  it('targets only the agent dirs of ENABLED providers', async () => {
    const ctx = await buildBlankRenderContext(
      mockDb([
        { name: 'claude-code', enabled: true },
        { name: 'gemini', enabled: false },
      ]),
      ARGS,
    );
    expect(ctx.agentTargets.map((t) => t.dir)).toEqual(['.claude/agents']);
    expect(ctx.enabledCliProviders.map((p) => p.name)).toEqual(['claude-code']);
  });

  it('never claims LSP support, having no languages to support', async () => {
    const ctx = await buildBlankRenderContext(
      mockDb([{ name: 'claude-code', enabled: true }]),
      ARGS,
    );
    expect(ctx.agentTargets.every((t) => t.supportsLsp === false)).toBe(true);
  });

  it('renders the deterministic scaffold and NOT a knowledge base', async () => {
    // Asserted through expandManifestFor rather than a hardcoded file list, so
    // this cannot drift from the manifest. The KB is absent on purpose: it is
    // mined from code, and an empty directory created to satisfy the marker
    // would make "onboarded" mean "has directories".
    const ctx = await buildBlankRenderContext(
      mockDb([{ name: 'claude-code', enabled: true }]),
      ARGS,
    );
    const paths = expandManifestFor(ctx).map((r) => r.diskPath);

    expect(paths).toContain('.claude/workflow-config.json');
    expect(paths.some((p) => p.startsWith('.claude/agents/'))).toBe(true);
    expect(paths.some((p) => p.includes('knowledge_base'))).toBe(false);
  });

  it('produces no agent targets when the user has no CLI enabled', async () => {
    const ctx = await buildBlankRenderContext(
      mockDb([{ name: 'claude-code', enabled: false }]),
      ARGS,
    );
    expect(ctx.agentTargets).toEqual([]);
  });
});
