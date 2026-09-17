import { describe, expect, it } from 'vitest';
import { agentSpecSchema } from '../src/cli-providers/agent-spec.js';
import { bundleIdSchema } from '../src/cli-providers/bundle-id.js';
import { skillEntrySchema, skillSubSkillSchema } from '../src/cli-providers/skill-spec.js';

// A bundle-supplied id becomes a path segment in `template-manifest.ts`, which onboarding writes
// and an upgrade DELETES — so the grammar is what keeps one inside the tree it belongs to.
describe('bundleIdSchema', () => {
  it('accepts the shapes real bundles already use', () => {
    // Every one of the 38 stored custom_bundle_items ids was measured against this grammar before
    // it shipped; these are representative of what passed.
    for (const id of [
      'peer-reviewer',
      'drupal7-developer',
      'api-route-dev',
      'a',
      'x2',
      '2fa-flow',
    ]) {
      expect(bundleIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it('rejects anything that could leave the directory it names', () => {
    for (const id of ['..', '../x', 'a/b', 'a/../b', './x', '.hidden', 'a.b']) {
      expect(bundleIdSchema.safeParse(id).success).toBe(false);
    }
  });

  it('rejects case, spaces, separators and a leading dash', () => {
    for (const id of ['Agent', 'two words', 'a_b', '-lead', '', ' ', 'a b/c']) {
      expect(bundleIdSchema.safeParse(id).success).toBe(false);
    }
  });

  it('says what a valid id looks like, since renaming is the author’s fix', () => {
    const parsed = bundleIdSchema.safeParse('../escape');
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain('lowercase letters, digits and dashes');
    }
  });
});

describe('the three bundle schemas that carry a path segment', () => {
  const agent = (id: string) => ({
    id,
    title: 't',
    description: 'd',
    color: 'blue',
    field: 'review',
    tools: [],
    coreMission: 'm',
    responsibilities: [],
    whenInvoked: [],
    executionSteps: [],
    outputFormat: '',
    qualityCriteria: [],
    antiPatterns: [],
  });

  it('refuses an agent id that is a traversal', () => {
    expect(agentSpecSchema.safeParse(agent('peer-reviewer')).success).toBe(true);
    expect(agentSpecSchema.safeParse(agent('../../etc/x')).success).toBe(false);
  });

  it('refuses a skill id that is a traversal', () => {
    const skill = (id: string) => ({ id, title: 't', description: 'd' });
    expect(skillEntrySchema.safeParse(skill('testing-patterns')).success).toBe(true);
    expect(skillEntrySchema.safeParse(skill('../../x')).success).toBe(false);
  });

  it('refuses a sub-skill slug that is a traversal', () => {
    const sub = (slug: string) => ({
      slug,
      name: 'n',
      title: 't',
      description: 'd',
      summary: 's',
      body: 'b',
    });
    expect(skillSubSkillSchema.safeParse(sub('unit-tests')).success).toBe(true);
    expect(skillSubSkillSchema.safeParse(sub('../x')).success).toBe(false);
  });
});
