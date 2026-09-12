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
  // Per DIRECTORY, not the first N paths: walk order is not representative, and MEASURED the
  // same 77 rendered as four examples put two CONTRIB files first (`sites/` sorts before
  // `test-playwright/`), after which the model concluded "the remaining scan matches are
  // contrib-bundled files this project never edits" — from a sample that was accurate.
  it('breaks the count down by directory, largest first', () => {
    const out = promptFor([
      {
        id: 'test-writer',
        label: 'Test writer',
        hint: 'writes tests',
        count: 77,
        recommended: true,
        matchDirs: [
          { dir: 'test-playwright/tests/functionality-validation', count: 62 },
          { dir: 'test-playwright/tests/data-validation', count: 11 },
          { dir: 'sites/all/modules/views/tests', count: 1 },
        ],
        matchDirTotal: 6,
      },
    ]);
    expect(out).toContain(
      '77 matching files, by directory: test-playwright/tests/functionality-validation (62)',
    );
    expect(out).toContain('+3 more directories');
  });

  // Two opposite failures came from the same number: "the scan ran and found none" alone
  // made zero the LEAD argument in three declines, and pushing back the other way aimed at
  // the wrong half — those declines were mostly CORRECT, while the models that KEPT the
  // agent never had to say why. So the row must read neutrally in both directions.
  it('presents a zero count as settling nothing either way', () => {
    const out = promptFor([
      {
        id: 'api-route-dev',
        label: 'API route developer',
        hint: 'routes',
        count: 0,
        recommended: true,
        matchDirs: [],
        matchDirTotal: 0,
      },
    ]);
    expect(out).toContain('settles nothing on its own in either direction');
    expect(out).toContain('hook_menu()');
  });

  // A `true` needed no justification, so retention was unauditable while rejection was
  // fully reasoned — MEASURED, three CLIs kept an API-route agent on a repo with no routing
  // layer, all three wrote the id explicitly, and there was simply no reason to read.
  it('requires a reason for keeping a zero-match agent', () => {
    const out = promptFor([
      {
        id: 'api-route-dev',
        label: 'API route developer',
        hint: 'routes',
        count: 0,
        recommended: true,
        matchDirs: [],
        matchDirTotal: 0,
      },
    ]);
    expect(out).toContain('"kept": [');
    expect(out).toContain('a `true` on a row showing 0 matching files needs a reason too');
    // Scoped: only where the count and the verdict disagree.
    expect(out).toContain('Only those rows');
  });

  // An agent named in a repo's OLD workflow docs is not thereby covered here.
  it('warns that pre-existing .claude/ files describe a prior setup', () => {
    const out = promptFor([
      {
        id: 'code-reviewer',
        label: 'Code reviewer',
        hint: 'reviews',
        count: 1,
        recommended: true,
        matchDirs: [{ dir: 'src', count: 1 }],
        matchDirTotal: 1,
      },
    ]);
    expect(out).toContain('from a PRIOR setup');
    expect(out).toContain('never as evidence about which agent runs when');
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
    // Scoped to the ROW: the `kept` rule elsewhere in the prompt legitimately says
    // "0 matching files" when describing when a reason is required.
    const row = unscanned.split('\n').find((l) => l.startsWith('- api-route-dev:'));
    expect(row).toBeDefined();
    expect(row).not.toContain('0 matching files');

    const scannedEmpty = promptFor([
      {
        id: 'api-route-dev',
        label: 'API route developer',
        hint: 'routes',
        count: 0,
        recommended: true,
        matchDirs: [],
        matchDirTotal: 0,
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
        matchDirs: [{ dir: '.', count: 1 }],
        matchDirTotal: 1,
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
