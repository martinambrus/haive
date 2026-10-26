import {
  deriveRenderTargets,
  originAgentTargets,
  renderTargetsFor,
  type RenderContextColumn,
} from '@haive/shared/project-state';
import type { CliProviderName } from '../cli-adapters/types.js';
import type { TemplateRenderContext } from './template-manifest.js';

export { FALLBACK_AGENT_TARGET, renderTargetsFor } from '@haive/shared/project-state';
export type { RenderTargets } from '@haive/shared/project-state';

/** Repository CLI membership owns the derived destinations. A legacy column without that field
 * retains its stored target metadata (including []) and completes missing fields as before. */
export function renderContextFromColumn(
  column: RenderContextColumn,
  providerRows: ReadonlyArray<{ name: CliProviderName; enabled: boolean }>,
): TemplateRenderContext {
  const derived =
    column.cliTargets !== undefined
      ? deriveRenderTargets(
          column.cliTargets,
          column.lspLanguages,
          column.agentTargets,
          column.legacyAgentFallback,
        )
      : renderTargetsFor(providerRows, column.lspLanguages, { agentsFallback: true });
  const agentTargets = originAgentTargets(
    {
      from: 'column',
      cliTargets: column.cliTargets,
      legacyAgentFallback: column.legacyAgentFallback,
      agentTargets: column.agentTargets,
      lspLanguages: column.lspLanguages,
    },
    providerRows,
  );
  return {
    ...(column.cliTargets !== undefined ? { cliTargets: column.cliTargets } : {}),
    ...(column.legacyAgentFallback !== undefined
      ? { legacyAgentFallback: column.legacyAgentFallback }
      : {}),
    projectInfo: column.projectInfo,
    framework: column.framework,
    acceptedAgentIds: column.acceptedAgentIds,
    customAgentSpecs: column.customAgentSpecs,
    agentTargets,
    lspLanguages: column.lspLanguages,
    rtkEnabled: column.rtkEnabled ?? false,
    enabledCliProviders:
      column.cliTargets !== undefined
        ? derived.enabledCliProviders
        : (column.enabledCliProviders ?? derived.enabledCliProviders),
  } as unknown as TemplateRenderContext;
}
