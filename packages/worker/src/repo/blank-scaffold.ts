import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { schema } from '@haive/database';
import { getCliProviderMetadata } from '@haive/shared';
import { cliAdapterRegistry } from '../cli-adapters/registry.js';
import type { CliProviderName } from '../cli-adapters/types.js';
import {
  expandManifestFor,
  type ExpandedRendering,
  type TemplateRenderContext,
} from '../step-engine/template-manifest.js';
import type { AgentRenderTarget } from '../step-engine/steps/onboarding/_agent-templates.js';
import type { ProjectInfo } from '../step-engine/steps/onboarding/07-generate-files.js';

/** A project that does not exist yet: every field a detector would have filled
 *  is genuinely unknown, and saying so beats inventing a stack for an empty
 *  directory. Only the name is real. */
function blankProjectInfo(name: string | null): ProjectInfo {
  return {
    name,
    framework: null,
    primaryLanguage: null,
    description: null,
    localUrl: null,
    databaseType: null,
    databaseVersion: null,
    webserver: null,
    docroot: null,
    runtimeVersions: {},
    testFrameworks: [],
    testPaths: [],
    buildTool: null,
    commands: [],
    containerType: null,
  };
}

/**
 * The template render context for a repository created empty.
 *
 * Everything an onboarding run would DERIVE from code is absent, because there
 * is no code: no framework, no languages, no LSP. What remains is the part that
 * never depended on the repository at all — the agent specs, the skills, the
 * workflow config — which is exactly the half worth installing up front.
 *
 * `acceptedAgentIds` is left empty deliberately. The manifest reads an empty
 * list as "no snapshot" and emits every agent, so a blank repo needs no
 * agent-selection decision made on the user's behalf.
 *
 * Shared with the upgrade path rather than private to INIT: a seeded blank repo
 * has no artifact rows and no prior onboarding task, which is the one state
 * `resolveRenderContext` cannot reconstruct from history.
 */
export async function buildBlankRenderContext(
  db: Database,
  args: { userId: string; repositoryId: string; repoName: string | null },
): Promise<TemplateRenderContext> {
  const providerRows = await db
    .select({ name: schema.cliProviders.name, enabled: schema.cliProviders.enabled })
    .from(schema.cliProviders)
    .where(eq(schema.cliProviders.userId, args.userId));

  const [repoRow] = await db
    .select({ rtkEnabled: schema.repositories.rtkEnabled })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, args.repositoryId))
    .limit(1);

  const enabled = providerRows.filter((p) => p.enabled);

  // Same fan-out rule as 07-generate-files: one target per agents directory,
  // shared where two CLIs write to the same one. `supportsLsp` is false
  // throughout — LSP follows configured languages, and a blank repo has none.
  const byDir = new Map<string, AgentRenderTarget>();
  for (const p of enabled) {
    const meta = getCliProviderMetadata(p.name as CliProviderName);
    if (!meta.projectAgentsDir || !meta.agentFileFormat) continue;
    if (byDir.has(meta.projectAgentsDir)) continue;
    byDir.set(meta.projectAgentsDir, {
      dir: meta.projectAgentsDir,
      format: meta.agentFileFormat,
      supportsLsp: false,
    });
  }

  return {
    projectInfo: blankProjectInfo(args.repoName),
    framework: null,
    acceptedAgentIds: [],
    customAgentSpecs: [],
    agentTargets: [...byDir.values()],
    lspLanguages: [],
    rtkEnabled: repoRow?.rtkEnabled ?? false,
    enabledCliProviders: enabled.map((p) => {
      const adapter = cliAdapterRegistry.get(p.name as CliProviderName);
      return {
        name: p.name as CliProviderName,
        rulesFile: adapter.rulesFile,
        rulesFileMode: adapter.rulesFileMode,
      };
    }),
  };
}

/**
 * Write the deterministic onboarding scaffold into a freshly created repo.
 *
 * Rendered through `expandManifestFor`, the same function onboarding's
 * post-apply hook and the upgrade planner use, so there is ONE definition of
 * what a repository gets and a seeded repo cannot drift from an onboarded one.
 *
 * Deliberately does NOT write `onboarding_artifacts` rows: that table's
 * `task_id` is NOT NULL and repo INIT has no task. The upgrade planner already
 * adopts on-disk template files when a repo has no rows (`ranBackfill`), which
 * is precisely this state.
 *
 * The knowledge base is NOT seeded. It is mined from code, and an empty
 * directory created to satisfy the marker would make "onboarded" mean "has
 * directories" while letting the plan canvas offer to build a plan from nothing.
 *
 * Returns the repo-relative paths written, for the caller to stage.
 */
export async function seedBlankScaffold(
  db: Database,
  args: { userId: string; repositoryId: string; repoName: string | null },
  dest: string,
): Promise<string[]> {
  const renderCtx = await buildBlankRenderContext(db, args);
  const expanded: ExpandedRendering[] = expandManifestFor(renderCtx);

  for (const r of expanded) {
    const full = path.join(dest, r.diskPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, r.content, 'utf8');
  }
  return expanded.map((r) => r.diskPath);
}
