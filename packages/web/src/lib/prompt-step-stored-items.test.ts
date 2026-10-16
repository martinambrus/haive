import { describe, expect, it } from 'vitest';
import { checkPromptSteps, parsePromptSteps } from '@haive/shared/modularity';
import { catalogEntries, describePromptStepIssue } from './composition-messages';
import { TEST_CATALOG } from './composition-test-catalog';
import {
  promptStepIssues,
  readPromptSteps,
  withPromptStepEntries,
  type StoredPromptSteps,
} from './prompt-step-editing';

// Controls of J6a fix-1 (task #185), web side: [F1] fails before the fix, [F0] is a pin that passes before and after.

const STEP = 'custom.t.check';
const base = catalogEntries(TEST_CATALOG);

const stored = {
  check: {
    slug: 'check',
    title: 'Check',
    template: 'Say {{nope}}',
    capabilities: [],
    timeoutMs: 300_000,
    tools: [null, {}],
    integrations: [null, 7, {}, { id: 3, category: 'forge', access: 'read' }],
  },
} as unknown as StoredPromptSteps;

// What the task type editor does with a row: read the steps, add their composable entries, run the check.
function editorIssues(row: StoredPromptSteps) {
  const promptSteps = readPromptSteps(row);
  return promptStepIssues({
    typeSlug: 't',
    stepIds: [STEP],
    requiresRepository: true,
    promptSteps,
    catalog: withPromptStepEntries(base, 't', true, promptSteps),
  });
}

describe('[F0] the steps of a row as the editor reads them', () => {
  it('[F0] passes the stored tools and integrations on as they are, so a save writes back what is stored', () => {
    const read = readPromptSteps(stored).check!;

    expect(read.tools).toEqual([null, {}]);
    expect(read.integrations).toEqual([null, 7, {}, { id: 3, category: 'forge', access: 'read' }]);
  });

  it('[F0] adds the composable entry of such a step without a throw', () => {
    const merged = withPromptStepEntries(base, 't', true, readPromptSteps(stored));

    expect(merged.get(STEP)).toMatchObject({ stepId: STEP, label: 'Check' });
  });
});

describe('[F1] the check the editor runs on a stored row', () => {
  it('[F1] answers one issue for each item it cannot type, and does not throw', () => {
    expect(editorIssues(stored).map((i) => [i.kind, i.stepId, i.raw])).toEqual([
      ['unknown-token', STEP, '{{nope}}'],
      ['tool-no-longer-valid', STEP, '#0'],
      ['tool-no-longer-valid', STEP, '#1'],
      ['integration-no-longer-valid', STEP, '#0'],
      ['integration-no-longer-valid', STEP, '#1'],
      ['integration-no-longer-valid', STEP, '#2'],
      ['integration-no-longer-valid', STEP, '#3'],
    ]);
  });

  it('[F1] words each of those issues and names the item', () => {
    const items = editorIssues(stored).filter((i) => i.kind.endsWith('-no-longer-valid'));

    expect(items).toHaveLength(6);
    for (const issue of items) {
      const text = describePromptStepIssue(issue);
      expect(text).toContain(`\`${issue.raw}\``);
      expect(text).toContain('no longer passes its checks');
    }
  });

  it('[F1] says what the api says of the same row', () => {
    const def = { slug: 't', stepIds: [STEP], requiresRepository: true };
    const server = checkPromptSteps(def, parsePromptSteps(stored), { composable: base });

    expect(server).toHaveLength(7);
    expect(editorIssues(stored)).toEqual(server);
  });
});
