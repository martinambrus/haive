import { createHmac } from 'node:crypto';
import type { OnboardingToolingMirror } from '../types/index.js';

function toolingOf(mirror: unknown): Record<string, unknown> | null {
  const tooling = (mirror as OnboardingToolingMirror | null | undefined)?.tooling;
  return tooling && typeof tooling === 'object' && !Array.isArray(tooling) ? tooling : null;
}

/** Proof that someone on THIS install accepted exactly this list: keyed with the install's
 *  encryption key, so no committed mirror can carry a value that passes. */
export function mcpAcceptanceMark(json: string, installKey: string): string {
  return createHmac('sha256', installKey).update(`mcp-consent:v1:${json}`).digest('hex');
}

/** Names of the imported MCP servers still waiting for a decision on this install, or null when
 *  nothing is waiting. */
export function pendingImportedMcpServers(mirror: unknown): string[] | null {
  const tooling = toolingOf(mirror);
  if (typeof tooling?.importedMcpSettingsJson !== 'string') return null;
  const names = tooling.importedMcpServerNames;
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : [];
}

/** The mirror once a person has accepted the held servers (they become the list the runtime
 *  reads) or discarded them. Null when nothing is waiting for a decision. */
export function decideImportedMcpServers(
  mirror: unknown,
  action: 'accept' | 'discard',
  installKey: string,
): OnboardingToolingMirror | null {
  const tooling = toolingOf(mirror);
  const held = tooling?.importedMcpSettingsJson;
  if (!tooling || typeof held !== 'string') return null;
  const {
    importedMcpSettingsJson: _held,
    importedMcpServerNames: _names,
    acceptedMcpSettingsMark: _accepted,
    ...rest
  } = tooling;
  return {
    ...(mirror as OnboardingToolingMirror),
    tooling:
      action === 'accept'
        ? {
            ...rest,
            mcpSettingsJson: held,
            acceptedMcpSettingsMark: mcpAcceptanceMark(held, installKey),
          }
        : rest,
  };
}
