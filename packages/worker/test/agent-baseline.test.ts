import { describe, expect, it } from 'vitest';
import { agentSpecSchema } from '@haive/shared';
import {
  BASELINE_AGENT_SPECS,
  buildAgentFileForTarget,
} from '../src/step-engine/steps/onboarding/_agent-templates.js';
import { BASELINE_AGENT_DEFS } from '../src/step-engine/steps/onboarding/06_5-agent-discovery.js';
import {
  getTemplateManifest,
  resetTemplateManifestCache,
} from '../src/step-engine/template-manifest.js';

// Legacy agents ported into Haive's baseline (integration-tester was already a
// baseline). First wave: workflow/review agents. Second wave: the adversarial-QA
// suite + business-requirements-writer + spec-quality-reviewer.
const PORTED_AGENTS = [
  'code-tracer',
  'peer-reviewer',
  'security-code-reviewer',
  'pattern-replicator',
  'markdown-humanizer',
  'auth-bandit',
  'chaos-creator',
  'edge-case-breaker',
  'injection-infector',
  'logic-lunatic',
  'workflow-disruptor',
  'business-requirements-writer',
  'spec-quality-reviewer',
  'accessibility-specialist',
  'technical-spec-writer',
];

describe('ported baseline agents', () => {
  it('each ported agent is in BASELINE_AGENT_SPECS and BASELINE_AGENT_DEFS', () => {
    const specIds = new Set(BASELINE_AGENT_SPECS.map((s) => s.id));
    const defIds = new Set(BASELINE_AGENT_DEFS.map((d) => d.id));
    for (const id of PORTED_AGENTS) {
      expect(specIds.has(id), `${id} missing from BASELINE_AGENT_SPECS`).toBe(true);
      expect(defIds.has(id), `${id} missing from BASELINE_AGENT_DEFS`).toBe(true);
    }
  });

  it('baseline defs and specs are in 1:1 sync (every def has a spec and vice versa)', () => {
    const specIds = new Set(BASELINE_AGENT_SPECS.map((s) => s.id));
    const defIds = new Set(BASELINE_AGENT_DEFS.map((d) => d.id));
    for (const d of BASELINE_AGENT_DEFS) {
      expect(specIds.has(d.id), `def ${d.id} has no matching BASELINE_AGENT_SPECS entry`).toBe(
        true,
      );
    }
    for (const s of BASELINE_AGENT_SPECS) {
      expect(defIds.has(s.id), `spec ${s.id} has no matching BASELINE_AGENT_DEFS entry`).toBe(true);
    }
  });

  it('each ported agent spec passes agentSpecSchema validation', () => {
    for (const id of PORTED_AGENTS) {
      const spec = BASELINE_AGENT_SPECS.find((s) => s.id === id);
      expect(spec, `${id} spec not found`).toBeDefined();
      const result = agentSpecSchema.safeParse(spec);
      expect(
        result.success,
        `${id} failed schema: ${result.success ? '' : JSON.stringify(result.error.issues)}`,
      ).toBe(true);
    }
  });

  it('each ported agent renders markdown with its name in frontmatter', () => {
    for (const id of PORTED_AGENTS) {
      const spec = BASELINE_AGENT_SPECS.find((s) => s.id === id)!;
      const md = buildAgentFileForTarget(spec, { dir: '.claude/agents', format: 'markdown' });
      expect(md.length).toBeGreaterThan(0);
      expect(md).toContain(`name: ${id}`);
    }
  });

  it('each ported agent is registered as an agent.<id> manifest template item', () => {
    resetTemplateManifestCache();
    const ids = getTemplateManifest().items.map((i) => i.id);
    for (const id of PORTED_AGENTS) {
      expect(ids).toContain(`agent.${id}`);
    }
  });
});
