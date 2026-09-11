import { describe, it, expect } from 'vitest';
import { buildAgentDiscoveryPrompt } from '../src/step-engine/steps/onboarding/06_5-agent-discovery.js';
import type { LlmBuildArgs } from '../src/step-engine/step-definition.js';

// Two instructions here were each paid for by a real run, so neither may be dropped
// silently: the model used `skipped` as a notepad ("NOT skipped — emitted below", which
// contradicts itself and would have lost the agent had it not also emitted it), and one
// emitted body cited half the repo paths the others did.
const prompt = (inventory: { name: string; category: string; fileCount: number }[] = []): string =>
  buildAgentDiscoveryPrompt({
    detected: {
      candidates: [
        {
          id: 'code-reviewer',
          label: 'Code reviewer',
          hint: 'reviews',
          count: 3,
          recommended: true,
        },
      ],
      __fileTree: 'sites/all/modules/activit/activit.module',
      __techInventory: {
        items: inventory.map((i) => ({
          ...i,
          displayName: i.name,
          manifests: [],
          matchedKeys: [],
        })),
        scannedManifests: [],
      },
    },
    formValues: {},
  } as unknown as LlmBuildArgs);

describe('agent-discovery prompt rules', () => {
  it('says `skipped` is only for rows NOT emitted', () => {
    const p = prompt();
    expect(p).toMatch(/Put a row in `skipped` ONLY when you are not emitting it/);
    expect(p).toMatch(/not a place to note what you did/);
  });

  it('requires two real repo paths per custom agent', () => {
    expect(prompt()).toMatch(/cite at least TWO real paths copied from the file tree/);
  });

  // The rule must not smuggle one project's layout into every project's prompt.
  it('carries no repository-specific example path', () => {
    expect(prompt()).not.toMatch(/e\.g\. `sites\/all\/modules\/activit/);
  });

  // The threshold is quoted from the constant, so prompt and code cannot drift again.
  it('quotes the real file-count threshold', () => {
    expect(prompt()).toMatch(/threshold 2\+ files/);
    expect(prompt()).not.toMatch(/threshold 5\+ files/);
  });

  it('no longer claims a listed row is significant by virtue of being listed', () => {
    expect(prompt([{ name: 'symfony', category: 'framework', fileCount: 2 }])).not.toMatch(
      /it is significant enough/,
    );
  });
});
