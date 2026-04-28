import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentSpecSchema, skillEntrySchema } from '@haive/shared';
import { classifyBundle } from '../src/bundle-parser/classifier.js';
import { decodeClaudeAgent, decodeClaudeSkill } from '../src/bundle-parser/decoders/claude-md.js';
import { decodeCodexAgent } from '../src/bundle-parser/decoders/codex-toml.js';
import { decodeGeminiSkill } from '../src/bundle-parser/decoders/gemini-md.js';
import {
  expandCustomBundlesFor,
  type BundleForExpansion,
} from '../src/step-engine/template-manifest.js';

let tmpRoot: string;
let bundleRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-bundle-pipeline-'));
  bundleRoot = path.join(tmpRoot, 'bundle');
  await mkdir(bundleRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function stageFixture(): Promise<void> {
  await mkdir(path.join(bundleRoot, '.claude', 'agents'), { recursive: true });
  await mkdir(path.join(bundleRoot, '.codex', 'agents'), { recursive: true });
  await mkdir(path.join(bundleRoot, '.gemini', 'skills', 'styling', 'sub-skills'), {
    recursive: true,
  });

  await writeFile(
    path.join(bundleRoot, '.claude', 'agents', 'reviewer.md'),
    [
      '---',
      'name: reviewer',
      'description: reviews code',
      'color: red',
      'field: quality',
      'allowed-tools: [Read, Grep]',
      '---',
      '',
      '# Reviewer',
      '',
      'Body content for reviewer.',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(bundleRoot, '.codex', 'agents', 'planner.toml'),
    [
      'name = "planner"',
      'description = "plans tasks"',
      'developer_instructions = """',
      'Plan tasks carefully.',
      '"""',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(bundleRoot, '.gemini', 'skills', 'styling', 'SKILL.md'),
    [
      '---',
      'name: styling',
      'description: how to style',
      '---',
      '',
      '# Styling',
      '',
      'Style guide overview.',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(bundleRoot, '.gemini', 'skills', 'styling', 'sub-skills', 'colors.md'),
    [
      '---',
      'name: styling-colors',
      'description: pick colors',
      '---',
      '',
      '# Colors',
      '',
      'Color guidance.',
      '',
    ].join('\n'),
  );
}

/** End-to-end pipeline for the in-process stages of bundle ingest:
 *  classify → decode → assemble BundleForExpansion → expandCustomBundlesFor.
 *  This is the path executed by 12-post-onboarding minus the DB I/O — failing
 *  here would surface the same regression as a full onboarding smoke. */
describe('bundle ingest → expansion pipeline', () => {
  it('classifies, decodes, and expands a mixed-format fixture bundle', async () => {
    await stageFixture();

    const classified = await classifyBundle(bundleRoot);
    expect(classified.agents).toHaveLength(2);
    expect(classified.skills).toHaveLength(1);

    // Decode each into IR (mirrors what parseBundle does).
    const decodedAgents = await Promise.all(
      classified.agents.map(async (a) => {
        const content = await readFile(a.absPath, 'utf8');
        const spec =
          a.sourceFormat === 'codex-toml'
            ? decodeCodexAgent(content, a.sourcePath)
            : decodeClaudeAgent(content, a.sourcePath);
        return agentSpecSchema.parse(spec);
      }),
    );
    expect(decodedAgents.map((a) => a.id).sort()).toEqual(['planner', 'reviewer']);

    const skillFolder = classified.skills[0]!;
    const skillContent = await readFile(skillFolder.absPath, 'utf8');
    const subSkillContents = await Promise.all(
      skillFolder.subSkillFiles.map(async (s) => ({
        sourcePath: s.sourcePath,
        content: await readFile(s.absPath, 'utf8'),
      })),
    );
    const decodedSkill =
      skillFolder.sourceFormat === 'gemini-md'
        ? decodeGeminiSkill(skillContent, skillFolder.sourcePath, subSkillContents)
        : decodeClaudeSkill(skillContent, skillFolder.sourcePath, subSkillContents);
    const skill = skillEntrySchema.parse(decodedSkill);
    expect(skill.id).toBe('styling');
    expect(skill.subSkills).toHaveLength(1);

    // Build BundleForExpansion structure as 12-post-onboarding does.
    const bundle: BundleForExpansion = {
      id: 'bundle-uuid-1',
      items: [
        ...decodedAgents.map((a, idx) => ({
          id: `agent-item-${idx}`,
          kind: 'agent' as const,
          schemaVersion: 1,
          contentHash: `agent-hash-${idx}`,
          spec: a,
        })),
        {
          id: 'skill-item-0',
          kind: 'skill' as const,
          schemaVersion: 1,
          contentHash: 'skill-hash-0',
          spec: skill,
        },
      ],
    };

    const expanded = expandCustomBundlesFor(
      [bundle],
      [
        { dir: '.claude/agents', format: 'markdown' },
        { dir: '.codex/agents', format: 'toml' },
      ],
      ['.claude/skills', '.gemini/skills'],
    );
    // 2 agents × 2 agent targets = 4 agent renderings.
    // 1 skill × 2 skill targets × (1 parent + 1 sub-skill) = 4 skill renderings.
    expect(expanded).toHaveLength(8);

    const paths = expanded.map((e) => e.diskPath).sort();
    expect(paths).toEqual([
      '.claude/agents/planner.md',
      '.claude/agents/reviewer.md',
      '.claude/skills/styling/SKILL.md',
      '.claude/skills/styling/sub-skills/colors.md',
      '.codex/agents/planner.toml',
      '.codex/agents/reviewer.toml',
      '.gemini/skills/styling/SKILL.md',
      '.gemini/skills/styling/sub-skills/colors.md',
    ]);

    // templateContentHash is the bundle item's IR hash and must be identical
    // across every rendering of one item.
    const reviewerHashes = new Set(
      expanded
        .filter((e) => e.diskPath.endsWith('reviewer.md') || e.diskPath.endsWith('reviewer.toml'))
        .map((e) => e.templateContentHash),
    );
    expect(reviewerHashes.size).toBe(1);

    // writtenHash differs across formats (markdown vs toml) for the same agent.
    const reviewerMd = expanded.find((e) => e.diskPath === '.claude/agents/reviewer.md');
    const reviewerToml = expanded.find((e) => e.diskPath === '.codex/agents/reviewer.toml');
    expect(reviewerMd?.writtenHash).not.toBe(reviewerToml?.writtenHash);

    // Every custom rendering has a templateId of the form custom.<bundleId>.<itemId>.
    for (const e of expanded) {
      expect(e.templateId.startsWith(`custom.${bundle.id}.`)).toBe(true);
    }
  });
});
