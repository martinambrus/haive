import {
  agentColorSchema,
  agentExpertiseSchema,
  agentModelSchema,
  type AgentColor,
  type AgentExpertise,
  type AgentModel,
  type AgentSpec,
  type SkillEntry,
} from '@haive/shared';
import { firstH1, parseInlineArray, splitFrontmatter } from './_frontmatter.js';

/** Decode a Claude-style agent markdown file into an AgentSpec. The decoder
 *  is lossy by design: only frontmatter is structurally parsed, the markdown
 *  body becomes a single `coreMission` field. Re-emitting through the
 *  worker's `buildAgentFileMarkdown` will produce a Haive-shaped file rather
 *  than echoing the user's original headings — but the on-disk hash is
 *  recomputed from the canonical IR, so upgrade comparisons stay stable. */
export function decodeClaudeAgent(content: string, sourcePath: string): AgentSpec {
  const { frontmatter, body } = splitFrontmatter(content);
  const id = (frontmatter.name ?? '').trim() || derivedIdFromPath(sourcePath);
  const description = (frontmatter.description ?? '').trim() || `Agent imported from ${sourcePath}`;
  const tools = frontmatter['allowed-tools'] ? parseInlineArray(frontmatter['allowed-tools']) : [];
  const model = parseEnum(frontmatter.model, agentModelSchema.options) as AgentModel | undefined;
  const expertise = parseEnum(frontmatter.expertise, agentExpertiseSchema.options) as
    | AgentExpertise
    | undefined;
  const color = (parseEnum(frontmatter.color, agentColorSchema.options) as AgentColor) ?? 'blue';
  const field = (frontmatter.field ?? '').trim() || 'general';

  const kbRefs = pickKbReferences(frontmatter);

  const trimmedBody = body.trim();
  const titleFromBody = firstH1(body) ?? id;

  return {
    id,
    title: titleFromBody,
    description,
    color,
    field,
    tools,
    ...(model ? { model } : {}),
    ...(expertise ? { expertise } : {}),
    coreMission: trimmedBody.length > 0 ? trimmedBody : description,
    responsibilities: [],
    whenInvoked: [],
    executionSteps: [],
    outputFormat: '',
    qualityCriteria: [],
    antiPatterns: [],
    ...(kbRefs ? { kbReferences: kbRefs } : {}),
  };
}

/** Decode a SKILL.md file into a SkillEntry. Sub-skills are decoded
 *  separately and threaded in by the orchestrator. */
export function decodeClaudeSkill(
  content: string,
  sourcePath: string,
  subSkillContents: { sourcePath: string; content: string }[],
): SkillEntry {
  const { frontmatter, body } = splitFrontmatter(content);
  const id = (frontmatter.name ?? '').trim() || derivedIdFromPath(sourcePath);
  const description = (frontmatter.description ?? '').trim() || `Skill imported from ${sourcePath}`;
  const titleFromBody = firstH1(body) ?? id;

  const subSkills = subSkillContents.map((s) => decodeClaudeSubSkill(s.content, s.sourcePath, id));
  const trimmedBody = body.trim();

  return {
    id,
    title: titleFromBody,
    description,
    instructions: trimmedBody.length > 0 ? trimmedBody : undefined,
    ...(subSkills.length > 0 ? { subSkills } : {}),
  };
}

function decodeClaudeSubSkill(
  content: string,
  sourcePath: string,
  parentId: string,
): SkillEntry['subSkills'] extends Array<infer T> | undefined ? T : never {
  const { frontmatter, body } = splitFrontmatter(content);
  const slug = sourcePath.split('/').pop()?.replace(/\.md$/i, '') ?? 'sub';
  const name = (frontmatter.name ?? '').trim() || `${parentId}-${slug}`;
  const description = (frontmatter.description ?? '').trim() || name;
  const titleFromBody = firstH1(body) ?? name;
  return {
    slug,
    name,
    title: titleFromBody,
    description,
    summary: description,
    body: body.trim(),
  };
}

function derivedIdFromPath(sourcePath: string): string {
  const base = sourcePath.split('/').pop() ?? 'item';
  return base
    .replace(/\.(md|toml)$/i, '')
    .replace(/[^a-z0-9-]+/gi, '-')
    .toLowerCase();
}

function parseEnum<T extends readonly string[]>(
  value: string | undefined,
  options: T,
): T[number] | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase() as T[number];
  return options.includes(normalized) ? normalized : undefined;
}

function pickKbReferences(
  fm: Record<string, string>,
): { patterns?: string; standards?: string; reference?: string } | null {
  const patterns = fm['kb-references.patterns'];
  const standards = fm['kb-references.standards'];
  const reference = fm['kb-references.reference'];
  if (!patterns && !standards && !reference) return null;
  return {
    ...(patterns ? { patterns } : {}),
    ...(standards ? { standards } : {}),
    ...(reference ? { reference } : {}),
  };
}
