import { ONBOARDING_TOOLING_SCHEMA_VERSION, type OnboardingToolingMirror } from '@haive/shared';
import { withoutMachineLocalTooling } from '@haive/shared/project-state';
import { holdImportedMcpServers } from '../sandbox/mcp-config.js';

/** The `onboarding_tooling` column for the tooling unit of another install's record. Its MCP servers
 *  go through the same hold as the legacy mirror's: a list that is not Haive's own is moved to
 *  `importedMcpSettingsJson`, which nothing reads, until a person here accepts it. */
export function toolingColumnFromUnit(unit: Readonly<Record<string, unknown>>): {
  column: OnboardingToolingMirror;
  heldServers: string[] | null;
} {
  const local = withoutMachineLocalTooling(unit);
  const held = holdImportedMcpServers(local);
  const names = held?.importedMcpServerNames;
  return {
    column: { schemaVersion: ONBOARDING_TOOLING_SCHEMA_VERSION, tooling: held ?? local },
    heldServers: Array.isArray(names) ? (names as string[]) : null,
  };
}
