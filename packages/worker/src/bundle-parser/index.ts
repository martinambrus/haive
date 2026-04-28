import { readFile } from 'node:fs/promises';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  agentSpecSchema,
  getCliProviderMetadata,
  skillEntrySchema,
  type AgentSpec,
  type CliProviderName,
  type CustomBundleItemSourceFormat,
  type SkillEntry,
} from '@haive/shared';
import { createHash } from 'node:crypto';
import {
  classifyBundle,
  type AgentFile,
  type SkillFolder,
  type UnknownFile,
} from './classifier.js';

/** Minimal structural logger type — the parser only calls `.warn`. Using a
 *  shape rather than importing the concrete pino type avoids a transitive
 *  dep declaration in the worker package. */
interface ParserLogger {
  warn(obj: unknown, msg?: string): void;
}
import { decodeClaudeAgent, decodeClaudeSkill } from './decoders/claude-md.js';
import { decodeCodexAgent } from './decoders/codex-toml.js';
import { decodeGeminiAgent, decodeGeminiSkill } from './decoders/gemini-md.js';
import { splitFrontmatter } from './decoders/_frontmatter.js';

export interface ParsedAgentItem {
  kind: 'agent';
  sourceFormat: CustomBundleItemSourceFormat;
  sourcePath: string;
  spec: AgentSpec;
  contentHash: string;
}

export interface ParsedSkillItem {
  kind: 'skill';
  sourceFormat: CustomBundleItemSourceFormat;
  sourcePath: string;
  spec: SkillEntry;
  contentHash: string;
}

export type ParsedBundleItem = ParsedAgentItem | ParsedSkillItem;

export interface ParseBundleResult {
  items: ParsedBundleItem[];
  ambiguous: UnknownFile[];
  /** Files dropped by the active-CLI tie-breaker so the orchestrator can log
   *  what was discarded. Useful for surfacing in the form's output. */
  dropped: { sourcePath: string; reason: string }[];
}

const FORMAT_PREFERENCE: CustomBundleItemSourceFormat[] = ['claude-md', 'gemini-md', 'codex-toml'];

function decodeAgentByFormat(
  format: CustomBundleItemSourceFormat,
  content: string,
  sourcePath: string,
): AgentSpec {
  if (format === 'codex-toml') return decodeCodexAgent(content, sourcePath);
  if (format === 'gemini-md') return decodeGeminiAgent(content, sourcePath);
  return decodeClaudeAgent(content, sourcePath);
}

function decodeSkillByFormat(
  format: CustomBundleItemSourceFormat,
  content: string,
  sourcePath: string,
  subSkillContents: { sourcePath: string; content: string }[],
): SkillEntry {
  if (format === 'gemini-md') return decodeGeminiSkill(content, sourcePath, subSkillContents);
  return decodeClaudeSkill(content, sourcePath, subSkillContents);
}

/** Stable hash over the canonical-form IR. JSON.stringify with sorted keys
 *  gives a deterministic byte stream so the same agent body always produces
 *  the same hash regardless of insertion order. */
export function hashIr(spec: AgentSpec | SkillEntry): string {
  return createHash('sha256').update(canonicalJson(spec)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function readFrontmatterName(absPath: string): Promise<string | null> {
  try {
    const raw = await readFile(absPath, 'utf8');
    const { frontmatter } = splitFrontmatter(raw);
    const name = frontmatter.name?.trim();
    return name && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

async function readTomlNameField(absPath: string): Promise<string | null> {
  try {
    const raw = await readFile(absPath, 'utf8');
    const match = raw.match(/^\s*name\s*=\s*"([^"]+)"\s*$/m);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

async function canonicalAgentId(file: AgentFile): Promise<string> {
  const fromFile =
    file.sourceFormat === 'codex-toml'
      ? await readTomlNameField(file.absPath)
      : await readFrontmatterName(file.absPath);
  if (fromFile) return fromFile;
  const base = file.sourcePath.split('/').pop() ?? 'item';
  return base.replace(/\.(md|toml)$/i, '').toLowerCase();
}

async function canonicalSkillId(file: SkillFolder): Promise<string> {
  const fromFile = await readFrontmatterName(file.absPath);
  if (fromFile) return fromFile;
  // SKILL.md sits inside a directory whose name is conventionally the skill id.
  const parts = file.sourcePath.split('/');
  return parts[parts.length - 2] ?? 'skill';
}

async function resolveActiveCliFormat(
  db: Database,
  repositoryId: string,
): Promise<CustomBundleItemSourceFormat | null> {
  const row = await db
    .select({ providerName: schema.cliProviders.name })
    .from(schema.tasks)
    .innerJoin(schema.cliProviders, eq(schema.tasks.cliProviderId, schema.cliProviders.id))
    .where(and(eq(schema.tasks.repositoryId, repositoryId), isNotNull(schema.tasks.cliProviderId)))
    .orderBy(desc(schema.tasks.completedAt), desc(schema.tasks.createdAt))
    .limit(1);
  const providerName = row[0]?.providerName as CliProviderName | undefined;
  if (!providerName) return null;
  const meta = getCliProviderMetadata(providerName);
  if (!meta.agentFileFormat) return null;
  return meta.agentFileFormat === 'toml' ? 'codex-toml' : 'claude-md';
}

function pickPreferredAgent(
  files: AgentFile[],
  preferred: CustomBundleItemSourceFormat | null,
): { keep: AgentFile; dropped: AgentFile[] } {
  if (files.length === 1) return { keep: files[0]!, dropped: [] };
  const order: CustomBundleItemSourceFormat[] = preferred
    ? [preferred, ...FORMAT_PREFERENCE.filter((f) => f !== preferred)]
    : FORMAT_PREFERENCE;
  for (const fmt of order) {
    const match = files.find((f) => f.sourceFormat === fmt);
    if (match) {
      return { keep: match, dropped: files.filter((f) => f !== match) };
    }
  }
  return { keep: files[0]!, dropped: files.slice(1) };
}

function pickPreferredSkill(
  files: SkillFolder[],
  preferred: CustomBundleItemSourceFormat | null,
): { keep: SkillFolder; dropped: SkillFolder[] } {
  if (files.length === 1) return { keep: files[0]!, dropped: [] };
  // Skill format options are a strict subset of agent options (claude-md,
  // gemini-md). Reuse the agent ordering and let the find-by-format step
  // skip codex-toml automatically.
  const order: CustomBundleItemSourceFormat[] = preferred
    ? [preferred, ...FORMAT_PREFERENCE.filter((f) => f !== preferred)]
    : FORMAT_PREFERENCE;
  for (const fmt of order) {
    const match = files.find((f) => f.sourceFormat === fmt);
    if (match) {
      return { keep: match, dropped: files.filter((f) => f !== match) };
    }
  }
  return { keep: files[0]!, dropped: files.slice(1) };
}

/** Walk a bundle's extracted dir, decode its agents/skills into canonical
 *  IR, and dedupe multi-format duplicates by deferring to the repository's
 *  active CLI. The returned `items` are ready to be persisted into
 *  `custom_bundle_items` (the orchestrator wraps them with `bundleId` /
 *  schemaVersion at the call site). */
export async function parseBundle(
  bundleId: string,
  db: Database,
  logger: ParserLogger,
): Promise<ParseBundleResult> {
  const bundle = await db.query.customBundles.findFirst({
    where: eq(schema.customBundles.id, bundleId),
  });
  if (!bundle) throw new Error(`bundle not found: ${bundleId}`);
  if (!bundle.storageRoot) throw new Error(`bundle has no storageRoot: ${bundleId}`);

  const classified = await classifyBundle(bundle.storageRoot);
  const preferred = await resolveActiveCliFormat(db, bundle.repositoryId);

  // Group agents by canonical id, apply tie-breaker per group.
  const agentGroups = new Map<string, AgentFile[]>();
  for (const file of classified.agents) {
    const id = await canonicalAgentId(file);
    const existing = agentGroups.get(id) ?? [];
    existing.push(file);
    agentGroups.set(id, existing);
  }

  const dropped: { sourcePath: string; reason: string }[] = [];
  const items: ParsedBundleItem[] = [];

  for (const [id, group] of agentGroups) {
    const { keep, dropped: discards } = pickPreferredAgent(group, preferred);
    for (const d of discards) {
      dropped.push({
        sourcePath: d.sourcePath,
        reason: `duplicate of ${id} — kept ${keep.sourceFormat} (${keep.sourcePath})`,
      });
    }
    let content: string;
    try {
      content = await readFile(keep.absPath, 'utf8');
    } catch (err) {
      logger.warn({ err, file: keep.sourcePath }, 'bundle-parser: failed to read agent file');
      dropped.push({ sourcePath: keep.sourcePath, reason: 'read failed' });
      continue;
    }
    const spec = decodeAgentByFormat(keep.sourceFormat, content, keep.sourcePath);
    const parsed = agentSpecSchema.safeParse(spec);
    if (!parsed.success) {
      logger.warn(
        { issues: parsed.error.issues, file: keep.sourcePath },
        'bundle-parser: agent failed schema validation',
      );
      dropped.push({ sourcePath: keep.sourcePath, reason: 'schema validation failed' });
      continue;
    }
    items.push({
      kind: 'agent',
      sourceFormat: keep.sourceFormat,
      sourcePath: keep.sourcePath,
      spec: parsed.data,
      contentHash: hashIr(parsed.data),
    });
  }

  // Skills.
  const skillGroups = new Map<string, SkillFolder[]>();
  for (const folder of classified.skills) {
    const id = await canonicalSkillId(folder);
    const existing = skillGroups.get(id) ?? [];
    existing.push(folder);
    skillGroups.set(id, existing);
  }

  for (const [id, group] of skillGroups) {
    const { keep, dropped: discards } = pickPreferredSkill(group, preferred);
    for (const d of discards) {
      dropped.push({
        sourcePath: d.sourcePath,
        reason: `duplicate skill ${id} — kept ${keep.sourceFormat} (${keep.sourcePath})`,
      });
    }
    let content: string;
    try {
      content = await readFile(keep.absPath, 'utf8');
    } catch (err) {
      logger.warn({ err, file: keep.sourcePath }, 'bundle-parser: failed to read SKILL.md');
      dropped.push({ sourcePath: keep.sourcePath, reason: 'read failed' });
      continue;
    }
    const subSkillContents: { sourcePath: string; content: string }[] = [];
    for (const sub of keep.subSkillFiles) {
      try {
        const subContent = await readFile(sub.absPath, 'utf8');
        subSkillContents.push({ sourcePath: sub.sourcePath, content: subContent });
      } catch (err) {
        logger.warn({ err, file: sub.sourcePath }, 'bundle-parser: failed to read sub-skill');
      }
    }
    const spec = decodeSkillByFormat(keep.sourceFormat, content, keep.sourcePath, subSkillContents);
    const parsed = skillEntrySchema.safeParse(spec);
    if (!parsed.success) {
      logger.warn(
        { issues: parsed.error.issues, file: keep.sourcePath },
        'bundle-parser: skill failed schema validation',
      );
      dropped.push({ sourcePath: keep.sourcePath, reason: 'schema validation failed' });
      continue;
    }
    items.push({
      kind: 'skill',
      sourceFormat: keep.sourceFormat,
      sourcePath: keep.sourcePath,
      spec: parsed.data,
      contentHash: hashIr(parsed.data),
    });
  }

  return { items, ambiguous: classified.unknown, dropped };
}

/** Persist parsed items into `custom_bundle_items`. Idempotent on
 *  `(bundle_id, source_path)` — re-parsing replaces the prior rows for the
 *  same source path. Items absent from `parsed` and present in the DB are
 *  deleted (drives the upgrade-plan `obsolete` bucket via the
 *  ON DELETE SET NULL hop on onboarding_artifacts.bundle_item_id). */
export async function persistBundleItems(
  db: Database,
  bundleId: string,
  parsed: ParseBundleResult,
): Promise<{ inserted: number; updated: number; removed: number }> {
  const now = new Date();
  const existing = await db
    .select({
      id: schema.customBundleItems.id,
      sourcePath: schema.customBundleItems.sourcePath,
      contentHash: schema.customBundleItems.contentHash,
    })
    .from(schema.customBundleItems)
    .where(eq(schema.customBundleItems.bundleId, bundleId));
  const existingByPath = new Map(existing.map((e) => [e.sourcePath, e]));

  let inserted = 0;
  let updated = 0;
  for (const item of parsed.items) {
    const prior = existingByPath.get(item.sourcePath);
    if (!prior) {
      await db.insert(schema.customBundleItems).values({
        bundleId,
        kind: item.kind,
        sourceFormat: item.sourceFormat,
        sourcePath: item.sourcePath,
        normalizedSpec: item.spec as unknown as Record<string, unknown>,
        contentHash: item.contentHash,
        schemaVersion: 1,
      });
      inserted += 1;
    } else if (prior.contentHash !== item.contentHash) {
      await db
        .update(schema.customBundleItems)
        .set({
          kind: item.kind,
          sourceFormat: item.sourceFormat,
          normalizedSpec: item.spec as unknown as Record<string, unknown>,
          contentHash: item.contentHash,
          updatedAt: now,
        })
        .where(eq(schema.customBundleItems.id, prior.id));
      updated += 1;
    }
    existingByPath.delete(item.sourcePath);
  }

  let removed = 0;
  for (const [, row] of existingByPath) {
    await db.delete(schema.customBundleItems).where(eq(schema.customBundleItems.id, row.id));
    removed += 1;
  }
  return { inserted, updated, removed };
}
