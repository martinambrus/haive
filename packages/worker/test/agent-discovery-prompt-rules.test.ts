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

const promptFor = (candidates: unknown[]): string =>
  buildAgentDiscoveryPrompt({
    detected: {
      candidates,
      __fileTree: 'sites/all/modules/activit/activit.module',
      __techInventory: { items: [], scannedManifests: [] },
    },
  } as unknown as LlmBuildArgs);

// A bare count is unfalsifiable, and a model asked to justify a decision describes what it
// cannot see. MEASURED on a live run: `Test writer (77 files)` was declined as "Drupal core
// SimpleTest .test files under modules/" when 75 of the 77 were the project's OWN Playwright
// specs — and the scanner's regex cannot match a bare `.test` file at all.
describe('candidate rows carry checkable evidence', () => {
  it('names example matched files beside the count', () => {
    const out = promptFor([
      {
        id: 'test-writer',
        label: 'Test writer',
        hint: 'writes tests',
        count: 77,
        recommended: true,
        sampleFiles: [
          'test-playwright/tests/functionality-validation/a.spec.ts',
          'test-playwright/tests/data-validation/b.spec.ts',
        ],
      },
    ]);
    expect(out).toContain(
      '77 matching files, e.g. test-playwright/tests/functionality-validation/a.spec.ts',
    );
    expect(out).toContain('+75 more');
  });

  // "Nothing was looked for" and "nothing was found" license opposite conclusions.
  it('distinguishes an unscanned agent from one that matched nothing', () => {
    const unscanned = promptFor([
      {
        id: 'api-route-dev',
        label: 'API route developer',
        hint: 'routes',
        count: 0,
        recommended: true,
      },
    ]);
    expect(unscanned).toContain('no file-pattern scan for this agent');
    expect(unscanned).not.toContain('0 matching files');

    const scannedEmpty = promptFor([
      {
        id: 'api-route-dev',
        label: 'API route developer',
        hint: 'routes',
        count: 0,
        recommended: true,
        sampleFiles: [],
      },
    ]);
    expect(scannedEmpty).toContain('the scan ran and found none');
  });

  it('requires a reason to rest on something checkable, or admit it is inferred', () => {
    const out = promptFor([
      {
        id: 'code-reviewer',
        label: 'Code reviewer',
        hint: 'reviews',
        count: 1,
        recommended: true,
        sampleFiles: ['a.ts'],
      },
    ]);
    expect(out).toContain('a path, a symbol, a config key, a line you opened');
    expect(out).toContain('inferred from the framework, not verified');
  });
});

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
