import { getCliProviderMetadata } from '@haive/shared';
import type { RenderContextColumn } from '@haive/shared/project-state';
import { cliAdapterRegistry } from '../cli-adapters/registry.js';
import type { CliProviderName, CliRulesFileMode } from '../cli-adapters/types.js';
import type { AgentRenderTarget } from './steps/onboarding/_agent-templates.js';
import type { TemplateRenderContext } from './template-manifest.js';

export interface RenderTargets {
  enabledCliProviders: Array<{
    name: CliProviderName;
    rulesFile: string;
    rulesFileMode: CliRulesFileMode;
  }>;
  agentTargets: AgentRenderTarget[];
}

/** The half of a render context that follows the user's CLI providers: their rules-file metadata
 *  and one agent target per agents directory. `lspLanguages` is what the tooling step recorded. */
export function renderTargetsFor(
  providerRows: ReadonlyArray<{ name: CliProviderName; enabled: boolean }>,
  lspLanguages: readonly string[],
): RenderTargets {
  // Carry per-CLI rules-file metadata into detect so the rtk-config items
  // can fan out per CLI without re-querying the adapter registry inside
  // the manifest expansion. Only enabled providers are included; rules
  // content presence is ignored here (rtk works whether the user has
  // populated cli_providers.rules_content or not).
  const enabledCliProviders = providerRows
    .filter((p) => p.enabled)
    .map((p) => {
      const adapter = cliAdapterRegistry.get(p.name);
      return {
        name: p.name,
        rulesFile: adapter.rulesFile,
        rulesFileMode: adapter.rulesFileMode,
      };
    });

  // Per-CLI agent file targets. Claude-code and Zai share `.claude/agents`
  // (markdown + YAML frontmatter); Gemini uses its own `.gemini/agents`
  // (markdown); Codex uses `.codex/agents` (TOML — Codex's own schema);
  // Amp has no file-based custom agents so is omitted entirely.
  const enabledProviders = providerRows.filter((p) => p.enabled);
  const hasConfiguredLsp = lspLanguages.length > 0;
  const agentTargetsByDir = new Map<string, AgentRenderTarget>();
  for (const p of enabledProviders) {
    const meta = getCliProviderMetadata(p.name);
    if (!meta.projectAgentsDir || !meta.agentFileFormat) continue;
    const existingTarget = agentTargetsByDir.get(meta.projectAgentsDir);
    if (!existingTarget) {
      agentTargetsByDir.set(meta.projectAgentsDir, {
        dir: meta.projectAgentsDir,
        format: meta.agentFileFormat,
        supportsLsp: meta.supportsLsp && hasConfiguredLsp,
      });
    } else if (meta.supportsLsp && hasConfiguredLsp) {
      // Shared targets (currently Claude Code + Z.AI) can use LSP whenever
      // at least one provider wired to that directory can expose it.
      existingTarget.supportsLsp = true;
    }
  }
  return { enabledCliProviders, agentTargets: Array.from(agentTargetsByDir.values()) };
}

/** The render context of a column. One the sync wrote holds no per-install fields, so each it lacks
 *  is derived from the user's providers as 07 derives it, and one it holds is kept, [] included. */
export function renderContextFromColumn(
  column: RenderContextColumn,
  providerRows: ReadonlyArray<{ name: CliProviderName; enabled: boolean }>,
): TemplateRenderContext {
  const derived = renderTargetsFor(providerRows, column.lspLanguages);
  return {
    projectInfo: column.projectInfo,
    framework: column.framework,
    acceptedAgentIds: column.acceptedAgentIds,
    customAgentSpecs: column.customAgentSpecs,
    agentTargets: column.agentTargets ?? derived.agentTargets,
    lspLanguages: column.lspLanguages,
    rtkEnabled: column.rtkEnabled ?? false,
    enabledCliProviders: column.enabledCliProviders ?? derived.enabledCliProviders,
  } as unknown as TemplateRenderContext;
}
