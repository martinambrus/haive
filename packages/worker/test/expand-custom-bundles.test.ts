import { describe, expect, it } from 'vitest';
import type { AgentSpec, SkillEntry } from '@haive/shared';
import {
  expandCustomBundlesFor,
  type BundleForExpansion,
} from '../src/step-engine/template-manifest.js';

const agentSpec: AgentSpec = {
  id: 'reviewer',
  title: 'Reviewer',
  description: 'reviews things',
  color: 'red',
  field: 'quality',
  tools: ['Read', 'Grep'],
  coreMission: 'do the thing',
  responsibilities: [],
  whenInvoked: [],
  executionSteps: [],
  outputFormat: '',
  qualityCriteria: [],
  antiPatterns: [],
};

const skillSpec: SkillEntry = {
  id: 'styling',
  title: 'Styling',
  description: 'how to style',
  overview: 'style guide',
  subSkills: [
    {
      slug: 'colors',
      name: 'styling-colors',
      title: 'Colors',
      description: 'pick colors',
      summary: 'colors',
      body: 'pick wisely',
    },
  ],
};

describe('expandCustomBundlesFor', () => {
  it('fans agents out across all agentTargets in matching format', () => {
    const bundles: BundleForExpansion[] = [
      {
        id: 'b1',
        items: [
          {
            id: 'item-a',
            kind: 'agent',
            schemaVersion: 1,
            contentHash: 'agent-hash',
            spec: agentSpec,
          },
        ],
      },
    ];
    const expanded = expandCustomBundlesFor(
      bundles,
      [
        { dir: '.claude/agents', format: 'markdown' },
        { dir: '.codex/agents', format: 'toml' },
      ],
      [],
    );
    expect(expanded).toHaveLength(2);
    const md = expanded.find((e) => e.diskPath.endsWith('.md'));
    const toml = expanded.find((e) => e.diskPath.endsWith('.toml'));
    expect(md?.diskPath).toBe('.claude/agents/reviewer.md');
    expect(toml?.diskPath).toBe('.codex/agents/reviewer.toml');
    expect(md?.templateId).toBe('custom.b1.item-a');
    expect(md?.templateKind).toBe('custom-agent');
    expect(md?.templateContentHash).toBe('agent-hash');
    expect(toml?.templateContentHash).toBe('agent-hash');
    expect(md?.writtenHash).not.toBe(toml?.writtenHash);
  });

  it('emits parent SKILL.md plus one rendering per sub-skill across every skillTarget', () => {
    const bundles: BundleForExpansion[] = [
      {
        id: 'b1',
        items: [
          {
            id: 'item-s',
            kind: 'skill',
            schemaVersion: 2,
            contentHash: 'skill-hash',
            spec: skillSpec,
          },
        ],
      },
    ];
    const expanded = expandCustomBundlesFor(bundles, [], ['.claude/skills', '.gemini/skills']);
    // 2 targets × (1 parent + 1 sub-skill) = 4 renderings.
    expect(expanded).toHaveLength(4);
    const paths = expanded.map((e) => e.diskPath).sort();
    expect(paths).toEqual([
      '.claude/skills/styling/SKILL.md',
      '.claude/skills/styling/sub-skills/colors.md',
      '.gemini/skills/styling/SKILL.md',
      '.gemini/skills/styling/sub-skills/colors.md',
    ]);
    for (const e of expanded) {
      expect(e.templateKind).toBe('custom-skill');
      expect(e.templateId).toBe('custom.b1.item-s');
      expect(e.templateContentHash).toBe('skill-hash');
      expect(e.templateSchemaVersion).toBe(2);
    }
  });

  it('returns empty when there are no targets for the item kind', () => {
    const bundles: BundleForExpansion[] = [
      {
        id: 'b1',
        items: [
          {
            id: 'item-a',
            kind: 'agent',
            schemaVersion: 1,
            contentHash: 'agent-hash',
            spec: agentSpec,
          },
        ],
      },
    ];
    expect(expandCustomBundlesFor(bundles, [], ['.claude/skills'])).toHaveLength(0);
  });

  it('produces stable writtenHash for identical content across calls', () => {
    const bundles: BundleForExpansion[] = [
      {
        id: 'b1',
        items: [
          {
            id: 'item-a',
            kind: 'agent',
            schemaVersion: 1,
            contentHash: 'h',
            spec: agentSpec,
          },
        ],
      },
    ];
    const a = expandCustomBundlesFor(bundles, [{ dir: '.claude/agents', format: 'markdown' }], []);
    const b = expandCustomBundlesFor(bundles, [{ dir: '.claude/agents', format: 'markdown' }], []);
    expect(a[0]!.writtenHash).toBe(b[0]!.writtenHash);
  });

  /** Mirrors the upgrade-plan flow: a bundle is re-pulled, its IR changes,
   *  and the templateContentHash on the next expansion no longer matches the
   *  baseline stored on the live `onboarding_artifacts` row. The plan step
   *  uses that mismatch to bucket the entry as `clean_update` (or `conflict`
   *  if disk has drifted). This test proves the contract upgrade-plan relies
   *  on without booting the full upgrade machinery. */
  it('changes templateContentHash when bundle item IR hash bumps (drives clean_update)', () => {
    const baseline = expandCustomBundlesFor(
      [
        {
          id: 'b1',
          items: [
            {
              id: 'item-a',
              kind: 'agent',
              schemaVersion: 1,
              contentHash: 'baseline-hash',
              spec: agentSpec,
            },
          ],
        },
      ],
      [{ dir: '.claude/agents', format: 'markdown' }],
      [],
    );
    const updated = expandCustomBundlesFor(
      [
        {
          id: 'b1',
          items: [
            {
              id: 'item-a',
              kind: 'agent',
              schemaVersion: 1,
              contentHash: 'updated-hash',
              spec: { ...agentSpec, description: 'updated description' },
            },
          ],
        },
      ],
      [{ dir: '.claude/agents', format: 'markdown' }],
      [],
    );
    expect(baseline[0]!.diskPath).toBe(updated[0]!.diskPath);
    expect(baseline[0]!.templateContentHash).not.toBe(updated[0]!.templateContentHash);
    // writtenHash also drifts because the rendered description text differs.
    expect(baseline[0]!.writtenHash).not.toBe(updated[0]!.writtenHash);
  });
});
