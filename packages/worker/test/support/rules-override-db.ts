import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

export const RULES_USER = '00000000-0000-4000-8000-0000000000a1';
export const RULES_REPO = '00000000-0000-4000-8000-0000000000b1';
export const RULES_TASK = '00000000-0000-4000-8000-0000000000c1';

/** The two tables 07's apply reads for the repository's live rules override: the onboarding task and
 *  its repository, which holds `override` (NULL for none, '' for an explicitly empty one). */
export function rulesOverrideDb(override: string | null = null) {
  const fake = createFakeDb({ tasks: schema.tasks, repositories: schema.repositories });
  fake.insert(schema.repositories, {
    id: RULES_REPO,
    userId: RULES_USER,
    name: 'acme',
    source: 'upload',
    agentRulesOverride: override,
  });
  fake.insert(schema.tasks, {
    id: RULES_TASK,
    userId: RULES_USER,
    repositoryId: RULES_REPO,
    type: 'onboarding',
    status: 'running',
    title: 'onboarding',
  });
  return fake;
}
