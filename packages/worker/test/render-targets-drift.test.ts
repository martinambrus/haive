import { describe, expect, it } from 'vitest';
import { CLI_PROVIDER_LIST, type AgentSpec, type SkillEntry } from '@haive/shared';
import {
  agentFilePath,
  bundleItemRenders,
  originAgentTargets,
  renderTargetsFor,
  rendersAt,
  skillTargetDirs,
  type AgentRenderTarget,
  type AgentTargetsOrigin,
} from '@haive/shared/project-state';
import { renderContextFromColumn } from '../src/step-engine/_render-targets.js';
import {
  expandCustomBundlesFor,
  expandManifestFor,
  REFERENCE_CONTEXT,
  type BundleForExpansion,
  type TemplateRenderContext,
} from '../src/step-engine/template-manifest.js';

const BUNDLE_AGENT: AgentSpec = {
  id: 'bundle-agent',
  title: 'Bundle agent',
  description: 'an agent from a bundle',
  color: 'red',
  field: 'quality',
  tools: [],
  coreMission: 'review',
  responsibilities: [],
  whenInvoked: [],
  executionSteps: [],
  outputFormat: '',
  qualityCriteria: [],
  antiPatterns: [],
};
const BUNDLE_SKILL: SkillEntry = {
  id: 'bundle-skill',
  title: 'Bundle skill',
  description: 'a skill from a bundle',
  subSkills: [
    {
      slug: 'part',
      name: 'bundle-skill-part',
      title: 'Part',
      description: 'one part',
      summary: 'part',
      body: 'a body',
    },
  ],
};
const BUNDLES: BundleForExpansion[] = [
  {
    id: 'b1',
    items: [
      { id: 'a', kind: 'agent', schemaVersion: 1, contentHash: 'ha', spec: BUNDLE_AGENT },
      { id: 's', kind: 'skill', schemaVersion: 1, contentHash: 'hs', spec: BUNDLE_SKILL },
    ],
  },
];

const CLI_SETS: Record<string, string[]> = {
  'claude-code': ['claude-code'],
  'claude-code+codex': ['claude-code', 'codex'],
  'claude-code+gemini+zai': ['claude-code', 'gemini', 'zai'],
  amp: ['amp'],
  none: [],
};

type OriginName =
  | 'column-with-targets'
  | 'column-sync-filled'
  | 'snapshot'
  | 'snapshot-without-targets'
  | 'blank'
  | 'onboarding'
  | 'onboarding-without-targets';
const ORIGINS: OriginName[] = [
  'column-with-targets',
  'column-sync-filled',
  'snapshot',
  'snapshot-without-targets',
  'blank',
  'onboarding',
  'onboarding-without-targets',
];

function originOf(name: OriginName, stored: AgentRenderTarget[]): AgentTargetsOrigin {
  switch (name) {
    case 'column-with-targets':
      return { from: 'column', agentTargets: stored, lspLanguages: [] };
    case 'column-sync-filled':
      return { from: 'column', lspLanguages: [] };
    case 'snapshot':
      return { from: 'snapshot', agentTargets: stored, lspLanguages: [] };
    case 'snapshot-without-targets':
      return { from: 'snapshot', lspLanguages: [] };
    case 'blank':
      return { from: 'blank' };
    case 'onboarding':
      return { from: 'onboarding', agentTargets: stored };
    case 'onboarding-without-targets':
      return { from: 'onboarding' };
  }
}

const ALL_NAMES = CLI_PROVIDER_LIST.map((p) => p.name);

describe('the render targets the banner and the plan share', () => {
  describe.each(Object.entries(CLI_SETS))('CLIs %s', (_label, enabled) => {
    const providerRows = ALL_NAMES.map((name) => ({ name, enabled: enabled.includes(name) }));
    const stored = renderTargetsFor(providerRows, [], { agentsFallback: true }).agentTargets;

    it.each(ORIGINS)('%s: every rendering stands at a path rendersAt accepts', (originName) => {
      const agentTargets = originAgentTargets(originOf(originName, stored), providerRows);
      const skillDirs = skillTargetDirs(providerRows.filter((p) => p.enabled).map((p) => p.name));
      const ctx: TemplateRenderContext = {
        ...REFERENCE_CONTEXT,
        acceptedAgentIds: ['code-reviewer', 'test-writer'],
        agentTargets,
        rtkEnabled: true,
        enabledCliProviders: renderTargetsFor(providerRows, []).enabledCliProviders,
      };
      const expanded = [
        ...expandManifestFor(ctx),
        ...expandCustomBundlesFor(BUNDLES, agentTargets, skillDirs),
      ];
      const targets = { agentTargets, skillDirs };

      for (const r of expanded) {
        const specId = r.templateKind.startsWith('custom-')
          ? r.templateId.endsWith('.a')
            ? BUNDLE_AGENT.id
            : BUNDLE_SKILL.id
          : undefined;
        expect(rendersAt({ ...r, specId }, targets), `${r.templateKind} ${r.diskPath}`).toBe(true);
      }

      const rendered = (kind: string) => expanded.some((r) => r.templateKind === kind);
      expect(rendered('custom-agent')).toBe(bundleItemRenders('agent', targets));
      expect(rendered('custom-skill')).toBe(bundleItemRenders('skill', targets));
      expect(rendered('agent')).toBe(agentTargets.length > 0);
    });

    it.each(ORIGINS)('%s: a path in a directory no target names is not accepted', (originName) => {
      const agentTargets = originAgentTargets(originOf(originName, stored), providerRows);
      const skillDirs = skillTargetDirs(providerRows.filter((p) => p.enabled).map((p) => p.name));
      const targets = { agentTargets, skillDirs };

      for (const meta of CLI_PROVIDER_LIST) {
        const { projectAgentsDir: dir, agentFileFormat: format } = meta;
        if (dir && format && !agentTargets.some((t) => t.dir === dir)) {
          const diskPath = agentFilePath({ dir, format }, 'code-reviewer');
          expect(
            rendersAt(
              { templateKind: 'agent', templateId: 'agent.code-reviewer', diskPath },
              targets,
            ),
            diskPath,
          ).toBe(false);
          expect(
            rendersAt(
              {
                templateKind: 'custom-agent',
                templateId: 'custom.b1.a',
                diskPath,
                specId: 'code-reviewer',
              },
              targets,
            ),
            diskPath,
          ).toBe(false);
        }
        if (!skillDirs.includes(meta.projectSkillsDir)) {
          const diskPath = `${meta.projectSkillsDir}/bundle-skill/SKILL.md`;
          expect(
            rendersAt(
              {
                templateKind: 'custom-skill',
                templateId: 'custom.b1.s',
                diskPath,
                specId: 'bundle-skill',
              },
              targets,
            ),
            diskPath,
          ).toBe(false);
        }
      }
    });
  });

  it('01 builds a column context from the same targets the banner reads', () => {
    for (const enabled of Object.values(CLI_SETS)) {
      const providerRows = ALL_NAMES.map((name) => ({ name, enabled: enabled.includes(name) }));
      const stored = renderTargetsFor(providerRows, [], { agentsFallback: true }).agentTargets;
      const column = {
        projectInfo: {},
        framework: null,
        acceptedAgentIds: [],
        customAgentSpecs: [],
        lspLanguages: [],
        rtkChoiceRecorded: true,
      };
      expect(renderContextFromColumn(column, providerRows).agentTargets).toEqual(
        originAgentTargets({ from: 'column', lspLanguages: [] }, providerRows),
      );
      expect(
        renderContextFromColumn({ ...column, agentTargets: [] }, providerRows).agentTargets,
      ).toEqual(
        originAgentTargets({ from: 'column', agentTargets: [], lspLanguages: [] }, providerRows),
      );
      expect(
        renderContextFromColumn({ ...column, agentTargets: stored }, providerRows).agentTargets,
      ).toEqual(stored);
    }
  });

  it('a blank repository of an Amp-only user has no agent target, any other origin falls back', () => {
    const amp = ALL_NAMES.map((name) => ({ name, enabled: name === 'amp' }));
    expect(originAgentTargets({ from: 'blank' }, amp)).toEqual([]);
    expect(originAgentTargets({ from: 'column', lspLanguages: [] }, amp).map((t) => t.dir)).toEqual(
      ['.claude/agents'],
    );
    expect(
      originAgentTargets({ from: 'snapshot', lspLanguages: [] }, amp).map((t) => t.dir),
    ).toEqual(['.claude/agents']);
    expect(originAgentTargets({ from: 'onboarding' }, amp).map((t) => t.dir)).toEqual([
      '.claude/agents',
    ]);
    expect(originAgentTargets({ from: 'column', agentTargets: [], lspLanguages: [] }, amp)).toEqual(
      [],
    );
  });
});
