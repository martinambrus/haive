import type { z } from 'zod';
import { CLI_PROVIDER_CATALOG, type CliRulesFileMode } from '../cli-providers/catalog.js';
import type { CliProviderName } from '../types/index.js';
import { agentTargetSchema } from './render-context.js';

/** A CLI-specific destination for generated agent files. */
export type AgentRenderTarget = z.infer<typeof agentTargetSchema>;

export interface RenderTargets {
  enabledCliProviders: Array<{
    name: CliProviderName;
    rulesFile: string;
    rulesFileMode: CliRulesFileMode;
  }>;
  agentTargets: AgentRenderTarget[];
}

/** Where agents land when no enabled provider has a file-based agents directory (Amp alone). */
export const FALLBACK_AGENT_TARGET: AgentRenderTarget = {
  dir: '.claude/agents',
  format: 'markdown',
  supportsLsp: false,
};

/** The half of a render context that follows the user's CLI providers: their rules-file metadata
 *  and one agent target per agents directory. `lspLanguages` is what the tooling step recorded. */
export function renderTargetsFor(
  providerRows: ReadonlyArray<{ name: CliProviderName; enabled: boolean }>,
  lspLanguages: readonly string[],
  options: { agentsFallback?: boolean } = {},
): RenderTargets {
  // Only enabled providers are included; rules content presence is ignored here (rtk works whether
  // the user has populated cli_providers.rules_content or not).
  const enabledProviders = providerRows.filter((p) => p.enabled);
  const enabledCliProviders = enabledProviders.map((p) => {
    const meta = CLI_PROVIDER_CATALOG[p.name];
    return { name: p.name, rulesFile: meta.rulesFile, rulesFileMode: meta.rulesFileMode };
  });

  // Per-CLI agent file targets. Claude-code and Zai share `.claude/agents`
  // (markdown + YAML frontmatter); Gemini uses its own `.gemini/agents`
  // (markdown); Codex uses `.codex/agents` (TOML — Codex's own schema);
  // Amp has no file-based custom agents so is omitted entirely.
  const hasConfiguredLsp = lspLanguages.length > 0;
  const agentTargetsByDir = new Map<string, AgentRenderTarget>();
  for (const p of enabledProviders) {
    const meta = CLI_PROVIDER_CATALOG[p.name];
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
  const agentTargets = Array.from(agentTargetsByDir.values());
  if (agentTargets.length === 0 && options.agentsFallback)
    agentTargets.push({ ...FALLBACK_AGENT_TARGET });
  return { enabledCliProviders, agentTargets };
}

/** Repository membership, independent of this install's configured or enabled providers. Unknown
 * record names remain portable but never acquire filesystem destinations on an older install. */
export function deriveRenderTargets(
  cliTargets: readonly string[],
  lspLanguages: readonly string[],
  legacyAgentTargets?: readonly AgentRenderTarget[],
  legacyAgentFallback = false,
): RenderTargets & { skillDirs: string[] } {
  const names = [...new Set(cliTargets)].filter((name): name is CliProviderName =>
    Object.hasOwn(CLI_PROVIDER_CATALOG, name),
  );
  const derived = renderTargetsFor(
    names.map((name) => ({ name, enabled: true })),
    lspLanguages,
  );
  const fallback = legacyAgentTargets?.find(
    (t) => t.dir === FALLBACK_AGENT_TARGET.dir && t.format === FALLBACK_AGENT_TARGET.format,
  );
  if (legacyAgentFallback && fallback && !derived.agentTargets.some((t) => t.dir === fallback.dir))
    derived.agentTargets.push({ ...fallback });
  return {
    ...derived,
    skillDirs: skillTargetDirs(names),
  };
}

/** Explicit [] is authoritative. Legacy metadata contributes only names actually recorded,
 * never names guessed from agent directories (several providers share those directories). */
export function recordedCliTargets(context: {
  cliTargets?: readonly string[];
  enabledCliProviders?: ReadonlyArray<{ name: string }>;
}): string[] | undefined {
  const names = context.cliTargets ?? context.enabledCliProviders?.map((p) => p.name);
  return names === undefined ? undefined : [...new Set(names)];
}

/** A compatibility fact, not provider membership: old 07 wrote an actual Claude-format fallback
 * for Amp alone OR zero enabled providers. New explicit lists need the recorded marker. */
export function hasLegacyAgentFallback(context: {
  cliTargets?: readonly string[];
  legacyAgentFallback?: boolean;
  enabledCliProviders?: ReadonlyArray<{ name: string }>;
  agentTargets?: readonly AgentRenderTarget[];
}): boolean {
  if (context.legacyAgentFallback !== undefined) return context.legacyAgentFallback;
  if (context.cliTargets !== undefined) return false;
  const actual = context.agentTargets?.some(
    (t) => t.dir === FALLBACK_AGENT_TARGET.dir && t.format === FALLBACK_AGENT_TARGET.format,
  );
  return (
    actual === true &&
    deriveRenderTargets(recordedCliTargets(context) ?? [], []).agentTargets.length === 0
  );
}

type RecordedCliContext = {
  cliTargets?: readonly string[];
  legacyAgentFallback?: boolean;
  enabledCliProviders?: ReadonlyArray<{ name: string }>;
  agentTargets?: readonly AgentRenderTarget[];
};

/** Promote recorded legacy membership without consulting local providers or replacing context/RTK
 * origin. Callers supply only snapshots accepted by recoverCliMembership's strict decoder. */
export function completeRecordedCliMembership<T extends RecordedCliContext>(
  context: T,
  recovered?: { cliTargets: string[]; snapshot: RecordedCliContext },
): T {
  if (context.cliTargets !== undefined) return context;
  const cliTargets = recovered?.cliTargets ?? recordedCliTargets(context);
  if (cliTargets === undefined) return context;
  const basis = context.agentTargets !== undefined ? context : (recovered?.snapshot ?? context);
  const explicitClearsFallback =
    recovered?.snapshot.cliTargets !== undefined && recovered.snapshot.legacyAgentFallback !== true;
  const next = { ...context, cliTargets };
  if (!explicitClearsFallback && hasLegacyAgentFallback(basis)) {
    next.legacyAgentFallback = true;
    next.agentTargets ??= deriveRenderTargets([], [], basis.agentTargets, true).agentTargets;
  } else delete next.legacyAgentFallback;
  return next;
}

/** Repo-relative skills directories to write to: one per unique `projectSkillsDir` across the
 *  enabled providers, else `fallback`. Bundle expansion takes the empty default, so it renders
 *  nothing rather than writing to a directory no CLI asked for. */
export function skillTargetDirs(
  enabledNames: readonly string[],
  fallback: string[] = [],
): string[] {
  const dirs = new Set<string>();
  for (const name of enabledNames) {
    const dir = Object.hasOwn(CLI_PROVIDER_CATALOG, name)
      ? CLI_PROVIDER_CATALOG[name as CliProviderName].projectSkillsDir
      : undefined;
    if (dir) dirs.add(dir);
  }
  return dirs.size > 0 ? Array.from(dirs) : fallback;
}

/** The file an agent lands in under one target. */
export function agentFilePath(
  target: Pick<AgentRenderTarget, 'dir' | 'format'>,
  id: string,
): string {
  return `${target.dir}/${id}.${target.format === 'toml' ? 'toml' : 'md'}`;
}

/** Gemini CLI loads every `*.md` file in `.gemini/agents/` as an agent definition and errors if
 *  frontmatter is missing, so an index README there triggers "Missing mandatory YAML frontmatter"
 *  on every run. Claude and Codex ignore non-agent files in their dirs. */
export function shouldEmitAgentsReadme(target: { dir: string }): boolean {
  return target.dir !== '.gemini/agents';
}

export type AgentTargetsOrigin =
  | {
      from: 'column';
      cliTargets?: readonly string[];
      legacyAgentFallback?: boolean;
      agentTargets?: readonly AgentRenderTarget[];
      lspLanguages: readonly string[];
    }
  | {
      from: 'snapshot';
      cliTargets?: readonly string[];
      legacyAgentFallback?: boolean;
      agentTargets?: readonly AgentRenderTarget[];
      lspLanguages: readonly string[];
    }
  | { from: 'blank' }
  | {
      from: 'onboarding';
      cliTargets?: readonly string[];
      legacyAgentFallback?: boolean;
      agentTargets?: readonly AgentRenderTarget[];
    };

/** The agent targets 01 renders with, by where its render context comes from. A column holds its
 *  stored targets, [] included, else the user's enabled CLIs complete it; a snapshot that holds
 *  none is completed the same way; a blank repository seeds no agent, so an Amp-only user has none;
 *  an onboarding's recorded targets, else the fallback directory. */
export function originAgentTargets(
  origin: AgentTargetsOrigin,
  providerRows: ReadonlyArray<{ name: CliProviderName; enabled: boolean }>,
): AgentRenderTarget[] {
  if ('cliTargets' in origin && origin.cliTargets !== undefined)
    return deriveRenderTargets(
      origin.cliTargets,
      'lspLanguages' in origin ? origin.lspLanguages : [],
      origin.agentTargets,
      origin.legacyAgentFallback,
    ).agentTargets;
  switch (origin.from) {
    case 'blank':
      return renderTargetsFor(providerRows, []).agentTargets;
    case 'onboarding':
      return origin.agentTargets
        ? origin.agentTargets.map((t) => ({ ...t }))
        : [{ ...FALLBACK_AGENT_TARGET }];
    case 'column':
    case 'snapshot':
      return origin.agentTargets
        ? origin.agentTargets.map((t) => ({ ...t }))
        : renderTargetsFor(providerRows, origin.lspLanguages, { agentsFallback: true })
            .agentTargets;
  }
}

/** Whether a custom bundle item renders to any file: an agent needs an agent target, a skill a skills
 *  directory. */
export function bundleItemRenders(
  kind: 'agent' | 'skill',
  targets: { agentTargets: readonly AgentRenderTarget[]; skillDirs: readonly string[] },
): boolean {
  return kind === 'agent' ? targets.agentTargets.length > 0 : targets.skillDirs.length > 0;
}

/** Whether the template that wrote a live row still renders to the row's path. A kind that does not
 *  follow the agent targets or skills directories always does. `specId` is a custom item's own id,
 *  which names its file or directory. */
export function rendersAt(
  row: { templateKind: string; templateId: string; diskPath: string; specId?: string },
  targets: { agentTargets: readonly AgentRenderTarget[]; skillDirs: readonly string[] },
): boolean {
  const { templateKind, templateId, diskPath, specId } = row;
  switch (templateKind) {
    case 'agent': {
      const id = templateId.startsWith('agent.') ? templateId.slice('agent.'.length) : null;
      return id === null || targets.agentTargets.some((t) => agentFilePath(t, id) === diskPath);
    }
    case 'custom-agent':
      return (
        specId === undefined ||
        targets.agentTargets.some((t) => agentFilePath(t, specId) === diskPath)
      );
    case 'agents-index':
      return targets.agentTargets.some(
        (t) => shouldEmitAgentsReadme(t) && `${t.dir}/README.md` === diskPath,
      );
    case 'custom-skill':
      return (
        specId === undefined ||
        targets.skillDirs.some((d) => diskPath.startsWith(`${d}/${specId}/`))
      );
    default:
      return true;
  }
}
