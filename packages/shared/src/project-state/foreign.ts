import { isImportMarker } from './import-marker.js';
import { isRenderContextSnapshot } from './render-context.js';
import { deriveRenderTargets } from './render-targets.js';
import { rendersAt, type AgentRenderTarget } from './render-targets.js';

const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function releaseParts(version: string): number[] | null {
  const match = RELEASE.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whether `candidate` is a release strictly newer than `installed`. A string that is not a plain
 *  `major.minor.patch` (a dev build, a pre-release, an empty stamp) has no order against any other,
 *  so it is never newer and is newer than nothing. */
export function isNewerRelease(
  candidate: string | null | undefined,
  installed: string | null | undefined,
): boolean {
  const a = candidate ? releaseParts(candidate) : null;
  const b = installed ? releaseParts(installed) : null;
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}

export type ForeignReason = 'custom-bundle' | 'newer-release' | 'not-rendered';

export interface ForeignCandidate {
  templateId: string;
  templateKind: string;
  diskPath: string;
  source: string;
  sourceStepId: string;
  haiveVersion: string | null;
  /** A custom item's own id, which names its file or directory; read off the path when absent. */
  specId?: string;
  formValuesSnapshot?: unknown;
}

export interface ForeignContext {
  /** The release this install runs. */
  haiveVersion: string;
  /** Null where no render context resolves, which leaves a row's targets unjudged. */
  agentTargets: readonly AgentRenderTarget[] | null;
  skillDirs: readonly string[];
}

const TARGETED_KINDS = new Set(['agent', 'custom-agent', 'agents-index', 'custom-skill']);

function specIdFromPath(
  row: Pick<ForeignCandidate, 'templateKind' | 'diskPath'>,
  skillDirs: readonly string[],
): string | undefined {
  if (row.templateKind === 'custom-agent') {
    const name = row.diskPath.slice(row.diskPath.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
  }
  if (row.templateKind === 'custom-skill') {
    const dir = skillDirs.find((d) => row.diskPath.startsWith(`${d}/`));
    return dir === undefined ? '' : row.diskPath.slice(dir.length + 1).split('/')[0];
  }
  return undefined;
}

/** Why an upgrade here leaves a live row alone, or null when it is this install's to manage: the
 *  row's template is a custom bundle item this install does not hold, an imported claim was made
 *  by a newer release, or an imported claim stands at a path this install does not render to. */
export function foreignReason(
  row: ForeignCandidate,
  context: ForeignContext,
): ForeignReason | null {
  if (row.templateId.startsWith('custom:')) return 'custom-bundle';
  if (!isImportMarker(row)) return null;
  if (isNewerRelease(row.haiveVersion, context.haiveVersion)) return 'newer-release';
  if (context.agentTargets !== null && TARGETED_KINDS.has(row.templateKind)) {
    const specId = row.specId ?? specIdFromPath(row, context.skillDirs);
    const targets = { agentTargets: context.agentTargets, skillDirs: context.skillDirs };
    if (!rendersAt({ ...row, specId }, targets)) {
      const snapshot = row.formValuesSnapshot;
      if (isRenderContextSnapshot(snapshot)) {
        const prior = snapshot as {
          cliTargets?: string[];
          lspLanguages: string[];
          agentTargets?: AgentRenderTarget[];
          legacyAgentFallback?: boolean;
        };
        // Only the new explicit repository contract can authorize retiring imported targets.
        if (prior.cliTargets !== undefined) {
          const before = deriveRenderTargets(
            prior.cliTargets,
            prior.lspLanguages,
            prior.agentTargets,
            prior.legacyAgentFallback,
          );
          if (
            rendersAt(
              { ...row, specId: row.specId ?? specIdFromPath(row, before.skillDirs) },
              before,
            )
          )
            return null;
        }
      }
      return 'not-rendered';
    }
  }
  return null;
}
