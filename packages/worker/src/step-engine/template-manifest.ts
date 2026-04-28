import { eq, notInArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  buildManifest,
  computeSetHash,
  hashRenderings,
  normalizeContent,
  sha256Hex,
  type ManifestItem,
  type TemplateItem,
  type TemplateManifest,
  type TemplateRendering,
} from '@haive/shared';
import {
  type AgentSpec,
  BASELINE_AGENT_SPECS,
  buildAgentFileMarkdown,
  buildAgentFileToml,
  FRAMEWORK_AGENT_SPECS,
} from './steps/onboarding/_agent-templates.js';
import {
  agentsIndexMarkdown,
  BASELINE_COMMANDS,
  commandFileMarkdown,
  type CommandSpec,
  DRUPAL_LSP_FILES,
  type ProjectInfo,
  workflowConfigJson,
} from './steps/onboarding/07-generate-files.js';
import {
  skillToMarkdown,
  subSkillToMarkdown,
  type SkillEntry,
} from './steps/onboarding/09_5-skill-generation.js';

/**
 * Everything needed to render any deterministic template. Heterogeneous
 * templates coexist by reading only the fields they care about; unused fields
 * are ignored per-template. For the manifest's reference hash we build a
 * canonical minimal context; for an actual onboarding we build the full
 * per-repo context.
 */
export interface TemplateRenderContext {
  projectInfo: ProjectInfo;
  prefs: {
    verificationLevel?: string;
    autoCommit?: boolean;
    maxIterations?: number;
  };
  framework: string | null;
  acceptedAgentIds: string[];
  customAgentSpecs: AgentSpec[];
  agentTargets: Array<{ dir: string; format: 'markdown' | 'toml' }>;
  lspLanguages: string[];
}

const REFERENCE_PROJECT_INFO: ProjectInfo = {
  name: null,
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
  containerType: null,
};

/**
 * Canonical reference context used only to compute stable content hashes. Must
 * be deterministic across worker restarts and deployments — no timestamps, no
 * random values, no environment-derived data. Any change to this object
 * invalidates every template hash, so treat it as API-stable.
 */
export const REFERENCE_CONTEXT: TemplateRenderContext = {
  projectInfo: REFERENCE_PROJECT_INFO,
  prefs: {},
  framework: null,
  acceptedAgentIds: [],
  customAgentSpecs: [],
  agentTargets: [{ dir: '.claude/agents', format: 'markdown' }],
  lspLanguages: [],
};

function findAgentSpec(id: string, framework: string | null): AgentSpec | null {
  for (const spec of BASELINE_AGENT_SPECS) {
    if (spec.id === id) return spec;
  }
  if (framework && FRAMEWORK_AGENT_SPECS[framework]) {
    for (const spec of FRAMEWORK_AGENT_SPECS[framework]!) {
      if (spec.id === id) return spec;
    }
  }
  return null;
}

function agentTemplateId(spec: AgentSpec): string {
  return `agent.${spec.id}`;
}

function buildAgentTemplateItem(spec: AgentSpec): TemplateItem<TemplateRenderContext> {
  return {
    id: agentTemplateId(spec),
    kind: 'agent',
    schemaVersion: 1,
    render(ctx: TemplateRenderContext): TemplateRendering[] {
      if (ctx.agentTargets.length === 0) return [];
      const out: TemplateRendering[] = [];
      for (const target of ctx.agentTargets) {
        const ext = target.format === 'toml' ? 'toml' : 'md';
        const content =
          target.format === 'toml' ? buildAgentFileToml(spec) : buildAgentFileMarkdown(spec);
        out.push({ diskPath: `${target.dir}/${spec.id}.${ext}`, content });
      }
      return out;
    },
  };
}

function buildAgentsIndexItem(): TemplateItem<TemplateRenderContext> {
  return {
    id: 'agents-index',
    kind: 'agents-index',
    schemaVersion: 1,
    render(ctx: TemplateRenderContext): TemplateRendering[] {
      const agents = resolveAgentsForIndex(ctx);
      if (agents.length === 0 || ctx.agentTargets.length === 0) return [];
      const out: TemplateRendering[] = [];
      for (const target of ctx.agentTargets) {
        const content = agentsIndexMarkdown(agents, target.format === 'toml' ? 'toml' : 'md');
        out.push({ diskPath: `${target.dir}/README.md`, content });
      }
      return out;
    },
  };
}

function resolveAgentsForIndex(ctx: TemplateRenderContext): AgentSpec[] {
  const customById = new Map(ctx.customAgentSpecs.map((s) => [s.id, s]));
  const out: AgentSpec[] = [];
  const seen = new Set<string>();
  for (const id of ctx.acceptedAgentIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const spec = findAgentSpec(id, ctx.framework) ?? customById.get(id);
    if (spec) out.push(spec);
  }
  return out;
}

function buildCommandTemplateItem(cmd: CommandSpec): TemplateItem<TemplateRenderContext> {
  return {
    id: `command.${cmd.id}`,
    kind: 'command',
    schemaVersion: 1,
    render(): TemplateRendering[] {
      return [
        {
          diskPath: `.claude/commands/${cmd.id}.md`,
          content: commandFileMarkdown(cmd),
        },
      ];
    },
  };
}

function buildWorkflowConfigItem(): TemplateItem<TemplateRenderContext> {
  return {
    id: 'workflow-config',
    kind: 'workflow-config',
    schemaVersion: 1,
    render(ctx: TemplateRenderContext): TemplateRendering[] {
      return [
        {
          diskPath: '.claude/workflow-config.json',
          content: workflowConfigJson(ctx.prefs, ctx.framework),
        },
      ];
    },
  };
}

function buildPluginFileItem(
  id: string,
  diskPath: string,
  content: string,
): TemplateItem<TemplateRenderContext> {
  return {
    id,
    kind: 'plugin-file',
    schemaVersion: 1,
    render(ctx: TemplateRenderContext): TemplateRendering[] {
      // Drupal LSP plugin files are only emitted when the php-extended LSP is
      // selected. Keeping the gating here means a template removal (LSP
      // disabled) surfaces as `obsolete` at upgrade time rather than
      // silently.
      if (!ctx.lspLanguages.includes('php-extended')) return [];
      return [{ diskPath, content: `${content}\n` }];
    },
  };
}

const DRUPAL_LSP_ITEMS: TemplateItem<TemplateRenderContext>[] = DRUPAL_LSP_FILES.map((f) =>
  buildPluginFileItem(`plugin.drupal-php-lsp.${f.rel}`, f.rel, f.content),
);

function collectKnownAgentSpecs(): AgentSpec[] {
  const out: AgentSpec[] = [...BASELINE_AGENT_SPECS];
  for (const frameworkAgents of Object.values(FRAMEWORK_AGENT_SPECS)) {
    for (const spec of frameworkAgents) {
      out.push(spec);
    }
  }
  return out;
}

/** All deterministic template items. For hash-stability reasons, the
 *  reference context used to compute `contentHash` targets a single canonical
 *  agent directory and no LSP languages; per-repo rendering uses real ctx. */
function buildTemplateItems(): TemplateItem<TemplateRenderContext>[] {
  const items: TemplateItem<TemplateRenderContext>[] = [];
  items.push(buildWorkflowConfigItem());
  items.push(buildAgentsIndexItem());
  for (const spec of collectKnownAgentSpecs()) {
    items.push(buildAgentTemplateItem(spec));
  }
  for (const cmd of BASELINE_COMMANDS) {
    items.push(buildCommandTemplateItem(cmd));
  }
  for (const item of DRUPAL_LSP_ITEMS) {
    items.push(item);
  }
  return items;
}

let cachedManifest: TemplateManifest<TemplateRenderContext> | null = null;

/** Idempotent accessor for the singleton manifest. Hashes are computed on
 *  first call against REFERENCE_CONTEXT; subsequent calls return the cached
 *  instance. Worker boot should call this once so a stable hash is logged. */
export function getTemplateManifest(): TemplateManifest<TemplateRenderContext> {
  if (cachedManifest) return cachedManifest;
  cachedManifest = buildManifest(buildTemplateItems(), REFERENCE_CONTEXT);
  return cachedManifest;
}

/** Force recomputation — used in unit tests that mutate the item list. */
export function resetTemplateManifestCache(): void {
  cachedManifest = null;
}

export interface ExpandedRendering {
  templateId: string;
  templateKind: ManifestItem<TemplateRenderContext>['kind'];
  templateSchemaVersion: number;
  templateContentHash: string;
  diskPath: string;
  content: string;
  writtenHash: string;
}

/** Expand every manifest item against a real per-repo context and return one
 *  record per concrete file output — each with enough metadata to write an
 *  `onboarding_artifacts` row. Used by onboarding's post-apply hook and by
 *  the upgrade-plan step's "what would we render now" computation. */
export function expandManifestFor(
  ctx: TemplateRenderContext,
  manifest: TemplateManifest<TemplateRenderContext> = getTemplateManifest(),
): ExpandedRendering[] {
  const out: ExpandedRendering[] = [];
  for (const item of manifest.items) {
    const renderings = item.render(ctx);
    for (const r of renderings) {
      const normalized = normalizeContent(r.content);
      out.push({
        templateId: item.id,
        templateKind: item.kind,
        templateSchemaVersion: item.schemaVersion,
        templateContentHash: item.contentHash,
        diskPath: r.diskPath,
        content: r.content,
        writtenHash: sha256Hex(normalized),
      });
    }
  }
  return out;
}

export { computeSetHash, hashRenderings, normalizeContent, sha256Hex };

/** Upsert every manifest item into `template_manifest_cache` and delete rows
 *  for template ids that no longer exist. Called from worker bootstrap so the
 *  API can read the current manifest without spawning worker-side generators. */
export async function syncTemplateManifestCache(db: Database): Promise<void> {
  const manifest = getTemplateManifest();
  const now = new Date();
  const liveIds = manifest.items.map((i) => i.id);

  if (liveIds.length === 0) {
    await db.delete(schema.templateManifestCache);
    return;
  }

  for (const item of manifest.items) {
    await db
      .insert(schema.templateManifestCache)
      .values({
        templateId: item.id,
        templateKind: item.kind,
        schemaVersion: item.schemaVersion,
        contentHash: item.contentHash,
        setHash: manifest.setHash,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.templateManifestCache.templateId,
        set: {
          templateKind: item.kind,
          schemaVersion: item.schemaVersion,
          contentHash: item.contentHash,
          setHash: manifest.setHash,
          updatedAt: now,
        },
      });
  }

  await db
    .delete(schema.templateManifestCache)
    .where(notInArray(schema.templateManifestCache.templateId, liveIds));
}

/** Bundle item shape consumed by `expandCustomBundlesFor`. The orchestrator
 *  loads `custom_bundle_items` rows for the repo, parses `normalizedSpec` via
 *  the canonical zod schema, and assembles these structures. Decoupling the
 *  expansion API from the DB row shape keeps tests cheap and avoids
 *  importing Drizzle types into the manifest module. */
export interface BundleAgentItem {
  id: string;
  kind: 'agent';
  schemaVersion: number;
  contentHash: string;
  spec: AgentSpec;
}

export interface BundleSkillItem {
  id: string;
  kind: 'skill';
  schemaVersion: number;
  contentHash: string;
  spec: SkillEntry;
}

export type BundleItemForExpansion = BundleAgentItem | BundleSkillItem;

export interface BundleForExpansion {
  id: string;
  items: BundleItemForExpansion[];
}

/** Expand custom-bundle items into one `ExpandedRendering` per `(item, target)`
 *  tuple. Mirrors `expandManifestFor` so onboarding/upgrade callers can union
 *  Haive-template renderings with bundle renderings without branching on
 *  shape. Bundle agents fan out across `agentTargets` exactly like Haive
 *  agent templates; bundle skills fan out across `skillTargets` and emit one
 *  rendering for the parent SKILL.md plus one per sub-skill.
 *
 *  `templateId` is `custom.<bundleId>.<itemId>` — globally unique across
 *  bundles, stable across re-parses (item id is the DB row id, not a derived
 *  slug). `templateContentHash` is the IR hash from `bundle_items.contentHash`
 *  — same value across all of one item's renderings, so upgrade-status drift
 *  detection works the same way it does for Haive items. */
export function expandCustomBundlesFor(
  bundles: ReadonlyArray<BundleForExpansion>,
  agentTargets: TemplateRenderContext['agentTargets'],
  skillTargets: ReadonlyArray<string>,
): ExpandedRendering[] {
  const out: ExpandedRendering[] = [];
  for (const bundle of bundles) {
    for (const item of bundle.items) {
      const templateId = `custom.${bundle.id}.${item.id}`;
      if (item.kind === 'agent') {
        if (agentTargets.length === 0) continue;
        for (const target of agentTargets) {
          const ext = target.format === 'toml' ? 'toml' : 'md';
          const content =
            target.format === 'toml'
              ? buildAgentFileToml(item.spec)
              : buildAgentFileMarkdown(item.spec);
          out.push({
            templateId,
            templateKind: 'custom-agent',
            templateSchemaVersion: item.schemaVersion,
            templateContentHash: item.contentHash,
            diskPath: `${target.dir}/${item.spec.id}.${ext}`,
            content,
            writtenHash: sha256Hex(normalizeContent(content)),
          });
        }
        continue;
      }
      // skill
      if (skillTargets.length === 0) continue;
      const skillContent = skillToMarkdown(item.spec);
      const subRenderings = (item.spec.subSkills ?? []).map((sub) => ({
        slug: sub.slug,
        content: subSkillToMarkdown(item.spec.id, sub),
      }));
      for (const targetDir of skillTargets) {
        out.push({
          templateId,
          templateKind: 'custom-skill',
          templateSchemaVersion: item.schemaVersion,
          templateContentHash: item.contentHash,
          diskPath: `${targetDir}/${item.spec.id}/SKILL.md`,
          content: skillContent,
          writtenHash: sha256Hex(normalizeContent(skillContent)),
        });
        for (const sub of subRenderings) {
          out.push({
            templateId,
            templateKind: 'custom-skill',
            templateSchemaVersion: item.schemaVersion,
            templateContentHash: item.contentHash,
            diskPath: `${targetDir}/${item.spec.id}/sub-skills/${sub.slug}.md`,
            content: sub.content,
            writtenHash: sha256Hex(normalizeContent(sub.content)),
          });
        }
      }
    }
  }
  return out;
}

/** Persist the set of template_ids that expanded to non-empty renderings for
 *  a specific repo. The API uses this to limit upgrade-status comparisons to
 *  templates that are actually applicable to the repo's gating context (e.g.
 *  drupal-php-lsp items only when the user opted into php-extended LSP). */
export async function updateApplicableTemplateIds(
  db: Database,
  repositoryId: string,
  expanded: Pick<ExpandedRendering, 'templateId'>[],
): Promise<void> {
  const ids = Array.from(new Set(expanded.map((e) => e.templateId))).sort();
  await db
    .update(schema.repositories)
    .set({ applicableTemplateIds: ids, updatedAt: new Date() })
    .where(eq(schema.repositories.id, repositoryId));
}
