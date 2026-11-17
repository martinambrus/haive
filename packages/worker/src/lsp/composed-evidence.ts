import { toolchainEnvironmentMatches } from '../sandbox/toolchain-prompt.js';
import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { readFileNoFollow } from '@haive/shared/fs-safe';
import {
  resolveSandboxImageComposition,
  type ComposedImageProvider,
} from '../sandbox/composed-image-cache.js';
import { defaultDockerRunner, type DockerRunner } from '../sandbox/docker-runner.js';
import {
  buildLspLayer,
  normalizeLspSelection,
  type SelectedLspServer,
} from '../sandbox/lsp-layer.js';
import { resolveInvocationWorkerTree } from '../repo/worktree-git-boundary.js';
import { workspaceAnchor } from '../repo/worktree-paths.js';

export const MAX_COMPOSED_LSP_PROVIDERS = 16;
export const MAX_COMPOSED_LSP_REPORTS = 7;
export const COMPOSED_IMAGE_REFS_KEY = 'composedLspImageRefs';

/** Stable hashes never persist provider settings or plugin bodies in evidence. */
export function evidenceHash(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(JSON.parse(JSON.stringify(value ?? null)))))
    .digest('hex');
}

export function lspProviderIdentity(provider: Record<string, unknown>): string {
  // Operational health/build timestamps do not configure a CLI. Every execution-affecting
  // setting does; additions fail closed until consciously excluded here.
  const {
    createdAt: _c,
    updatedAt: _u,
    sandboxImageBuildStatus: _s,
    sandboxImageBuildError: _e,
    sandboxImageTag: _t,
    sandboxImageBuiltAt: _b,
    authLastCheckedAt: _a,
    authStatus: _as,
    authMessage: _am,
    ...config
  } = provider;
  return evidenceHash(config);
}

export interface ComposedLspIdentity {
  schemaVersion: 1;
  envTemplateId: string;
  installContract: 2;
  templateBodyHash: string;
  environmentImageId: string;
  selection: SelectedLspServer[];
  recipeHash: string;
  provider: {
    id: string;
    name: string;
    cliVersion: string | null;
    extrasHash: string;
    configHash: string;
  };
  plugin: { hash: string; ready: boolean; filesHash: string | null };
  compositionHash: string;
  tag: string;
  imageId: string;
}
export interface ComposedLspReport {
  server: string;
  passed: boolean;
  skipped: boolean;
  installedVersion: string | null;
  toolchainVersion: string | null;
  stdout: string;
  stderr: string;
}
export interface ComposedLspEntry {
  identity: ComposedLspIdentity;
  outcome: 'verified' | 'failed';
  reports: ComposedLspReport[];
}
export interface ComposedLspEvidence {
  schemaVersion: 1;
  entries: ComposedLspEntry[];
}
export interface ComposedImageReference {
  tag: string;
  imageId: string;
  identityHash: string;
}
interface ProviderReferences {
  providerId: string;
  effective?: ComposedImageReference;
  prior?: ComposedImageReference;
  verifying?: ComposedImageReference;
}
export interface ComposedImageReferences {
  schemaVersion: 1;
  entries: ProviderReferences[];
}

export function composedEntryMatches(
  entry: unknown,
  current: ComposedLspIdentity,
): entry is ComposedLspEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as ComposedLspEntry;
  return (
    e.outcome === 'verified' &&
    current.plugin.ready &&
    current.selection.length > 0 &&
    e.identity?.schemaVersion === 1 &&
    evidenceHash(e.identity) === evidenceHash(current) &&
    Array.isArray(e.reports) &&
    e.reports.length === current.selection.length &&
    e.reports.length <= MAX_COMPOSED_LSP_REPORTS &&
    new Set(e.reports.map((r) => r?.server)).size === e.reports.length &&
    current.selection.every((s) =>
      e.reports.some(
        (r) =>
          r?.server === s.server &&
          r.passed === true &&
          r.skipped === false &&
          typeof r.installedVersion === 'string' &&
          r.installedVersion.length > 0 &&
          r.installedVersion.length <= 256 &&
          typeof r.toolchainVersion === 'string' &&
          r.toolchainVersion.length > 0 &&
          r.toolchainVersion.length <= 256,
      ),
    )
  );
}

/** A successful install of another selection proves no bridge for this one. */
export function pluginCoversSelection(
  detect: unknown,
  selection: readonly SelectedLspServer[],
): boolean {
  const languages = (detect as { lspLanguages?: unknown } | null)?.lspLanguages;
  if (!Array.isArray(languages)) return false;
  try {
    return (
      evidenceHash(normalizeLspSelection(languages).map((s) => s.server)) ===
      evidenceHash(selection.filter((s) => s.server !== 'solargraph').map((s) => s.server))
    );
  } catch {
    return false;
  }
}

const PHP_PLUGIN_FILES = [
  '.claude/plugins/drupal-php-lsp/.claude-plugin/marketplace.json',
  '.claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.claude-plugin/plugin.json',
  '.claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.lsp.json',
];

export async function currentPhpPluginFilesHash(
  db: Database,
  taskId: string,
): Promise<string | null> {
  const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) });
  if (!task?.repositoryId) return null;
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, task.repositoryId),
  });
  const root = repo?.storagePath ?? repo?.localPath;
  if (!root) return null;
  const tree = await resolveInvocationWorkerTree(db, taskId);
  if (!tree) return null;
  const { anchor, prefix } = workspaceAnchor(tree);
  const hashes: string[] = [];
  for (const rel of PHP_PLUGIN_FILES) {
    const read = await readFileNoFollow(anchor, `${prefix}${rel}`, {
      maxBytes: 64 * 1024,
      strict: true,
    });
    if (!read || read.truncated || read.data.length === 0) return null;
    hashes.push(createHash('sha256').update(read.data).digest('hex'));
  }
  return evidenceHash(hashes);
}

export async function loadComposedLspIdentity(
  db: Database,
  taskId: string,
  providerId: string,
  runner: DockerRunner = defaultDockerRunner,
): Promise<ComposedLspIdentity | null> {
  const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) });
  if (!task?.envTemplateId) return null;
  const env = await db.query.envTemplates.findFirst({
    where: eq(schema.envTemplates.id, task.envTemplateId),
  });
  if (
    env?.declaredDeps?.lspInstallContractVersion !== 2 ||
    env.status !== 'ready' ||
    !env.generatedDockerfile?.trim()
  )
    return null;
  const provider = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, providerId),
  });
  if (!provider || provider.userId !== task.userId || provider.enabled !== true) return null;
  const selection = normalizeLspSelection(
    env.declaredDeps.lspServers,
    env.declaredDeps.lspServerVersions,
  );
  const composition = await resolveSandboxImageComposition(
    db,
    taskId,
    provider as ComposedImageProvider,
    runner,
  );
  if (!composition) return null;
  const environment = env.imageTag ? await runner.inspect(env.imageTag) : null;
  if (
    !environment?.exists ||
    !environment.imageId ||
    (env.builtImageId && env.builtImageId !== environment.imageId)
  )
    return null;
  const inspected = await runner.inspect(composition.tag);
  if (!inspected.exists || !inspected.imageId) return null;
  const plugin = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, taskId),
      eq(schema.taskSteps.stepId, '01b-install-plugins'),
    ),
    orderBy: [desc(schema.taskSteps.round), desc(schema.taskSteps.endedAt)],
  });
  const pluginOut = plugin?.output as {
    skipped?: unknown;
    missingDrupalLsp?: unknown;
    composedLspProviderHash?: unknown;
    composedLspFilesHash?: unknown;
    executed?: Array<{ exitCode?: unknown }>;
  } | null;
  const configHash = lspProviderIdentity(provider);
  const filesHash = selection.some((s) => s.server === 'intelephense')
    ? await currentPhpPluginFilesHash(db, taskId)
    : null;
  const ready =
    toolchainEnvironmentMatches(provider.wrapperContent, provider.envVars) &&
    plugin?.status === 'done' &&
    pluginCoversSelection(plugin.detectOutput, selection) &&
    pluginOut?.skipped === false &&
    !pluginOut.missingDrupalLsp &&
    pluginOut.composedLspProviderHash === configHash &&
    Array.isArray(pluginOut.executed) &&
    pluginOut.executed.length > 0 &&
    pluginOut.executed.every((r) => r.exitCode === 0) &&
    (!selection.some((s) => s.server === 'intelephense') ||
      (filesHash !== null && pluginOut.composedLspFilesHash === filesHash));
  return {
    schemaVersion: 1,
    envTemplateId: env.id,
    installContract: 2,
    templateBodyHash: evidenceHash(env.generatedDockerfile),
    environmentImageId: environment.imageId,
    selection,
    recipeHash: evidenceHash(
      buildLspLayer(env.declaredDeps.lspServers, env.declaredDeps.lspServerVersions),
    ),
    provider: {
      id: provider.id,
      name: provider.name,
      cliVersion: provider.cliVersion,
      extrasHash: evidenceHash(provider.sandboxDockerfileExtra),
      configHash,
    },
    plugin: {
      hash: evidenceHash(
        plugin
          ? {
              id: plugin.id,
              status: plugin.status,
              generation: plugin.rerunGeneration,
              detect: plugin.detectOutput,
              output: plugin.output,
            }
          : null,
      ),
      ready,
      filesHash,
    },
    compositionHash: composition.hash,
    tag: composition.tag,
    imageId: inspected.imageId,
  };
}

export function parseImageReferences(metadata: unknown): ComposedImageReferences {
  const raw = (metadata as Record<string, unknown> | null)?.[COMPOSED_IMAGE_REFS_KEY] as
    ComposedImageReferences | undefined;
  if (!raw) return { schemaVersion: 1, entries: [] };
  if (
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.entries) ||
    raw.entries.length > MAX_COMPOSED_LSP_PROVIDERS
  )
    throw new Error('Invalid retained composed image references');
  for (const e of raw.entries) {
    if (typeof e.providerId !== 'string')
      throw new Error('Invalid composed image provider reference');
    for (const ref of [e.effective, e.prior, e.verifying])
      if (
        ref &&
        (typeof ref.tag !== 'string' ||
          typeof ref.imageId !== 'string' ||
          typeof ref.identityHash !== 'string')
      )
        throw new Error('Invalid retained composed image reference');
  }
  return raw;
}

export function updateImageReferences(
  refs: ComposedImageReferences,
  providerId: string,
  ref: ComposedImageReference,
  publish: boolean,
  limit = MAX_COMPOSED_LSP_PROVIDERS,
): ComposedImageReferences {
  const entries = refs.entries.map((e) => ({ ...e }));
  let e = entries.find((e) => e.providerId === providerId);
  if (!e) {
    if (entries.length >= limit) throw new Error('Retained composed image provider limit reached');
    e = { providerId };
    entries.push(e);
  }
  if (publish) {
    if (e.effective?.imageId !== ref.imageId) e.prior = e.effective;
    e.effective = ref;
    delete e.verifying;
  } else e.verifying = ref;
  return { schemaVersion: 1, entries };
}

/** A reset clears 04 output, not this task-owned key. Task-row serialization and a fresh locked read
 * preserve unrelated metadata. The caller holds the image-tag turn until this commits. */
export async function retainComposedImage(
  db: Database,
  taskId: string,
  identity: ComposedLspIdentity,
  publish: boolean,
  fence: { stepId: string; generation: number; epoch: number },
  runner: DockerRunner,
): Promise<void> {
  await db.transaction(async (tx) => {
    const steps = await tx
      .select()
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.id, fence.stepId))
      .for('update');
    if (steps[0]?.status !== 'running' || steps[0].rerunGeneration !== fence.generation)
      throw new Error('Composed verification superseded');
    // Same lock order as resets: step first, task last. Provider/environment edits
    // are fenced until the reference write commits; no build or probe holds SQL locks.
    await tx
      .select()
      .from(schema.cliProviders)
      .where(eq(schema.cliProviders.id, identity.provider.id))
      .for('update');
    await tx
      .select()
      .from(schema.envTemplates)
      .where(eq(schema.envTemplates.id, identity.envTemplateId))
      .for('update');
    const tasks = await tx
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .for('update');
    const task = tasks[0];
    if (!task || task.orchestrationEpoch !== fence.epoch)
      throw new Error('Composed verification superseded');
    const current = await loadComposedLspIdentity(
      tx as unknown as Database,
      taskId,
      identity.provider.id,
      runner,
    );
    if (!current || evidenceHash(current) !== evidenceHash(identity))
      throw new Error('Composed image inputs changed during verification');
    const refs = updateImageReferences(
      parseImageReferences(task.metadata),
      identity.provider.id,
      { tag: identity.tag, imageId: identity.imageId, identityHash: evidenceHash(identity) },
      publish,
    );
    await tx
      .update(schema.tasks)
      .set({
        metadata: { ...(task.metadata ?? {}), [COMPOSED_IMAGE_REFS_KEY]: refs },
        updatedAt: new Date(),
      })
      .where(eq(schema.tasks.id, taskId));
  });
}

export async function retainedComposedImageRefs(db: Database): Promise<Set<string>> {
  const tasks = await db
    .select({ metadata: schema.tasks.metadata })
    .from(schema.tasks)
    .where(sql`${schema.tasks.metadata} ? ${COMPOSED_IMAGE_REFS_KEY}`);
  const held = new Set<string>();
  for (const task of tasks)
    for (const e of parseImageReferences(task.metadata).entries)
      for (const r of [e.effective, e.prior, e.verifying])
        if (r) {
          held.add(r.tag);
          held.add(r.imageId);
        }
  return held;
}
