import {
  originAgentTargets,
  renderTargetsFor,
  type RenderContextColumn,
} from '@haive/shared/project-state';
import type { CliProviderName } from '../cli-adapters/types.js';
import type { TemplateRenderContext } from './template-manifest.js';

export { FALLBACK_AGENT_TARGET, renderTargetsFor } from '@haive/shared/project-state';
export type { RenderTargets } from '@haive/shared/project-state';

/** The render context of a column. One the sync wrote holds no per-install fields, so each it lacks
 *  is derived from the user's providers as 07 derives it, and one it holds is kept, [] included. */
export function renderContextFromColumn(
  column: RenderContextColumn,
  providerRows: ReadonlyArray<{ name: CliProviderName; enabled: boolean }>,
): TemplateRenderContext {
  const derived = renderTargetsFor(providerRows, column.lspLanguages, {
    agentsFallback: true,
  });
  const agentTargets = originAgentTargets(
    { from: 'column', agentTargets: column.agentTargets, lspLanguages: column.lspLanguages },
    providerRows,
  );
  return {
    projectInfo: column.projectInfo,
    framework: column.framework,
    acceptedAgentIds: column.acceptedAgentIds,
    customAgentSpecs: column.customAgentSpecs,
    agentTargets,
    lspLanguages: column.lspLanguages,
    rtkEnabled: column.rtkEnabled ?? false,
    enabledCliProviders: column.enabledCliProviders ?? derived.enabledCliProviders,
  } as unknown as TemplateRenderContext;
}
