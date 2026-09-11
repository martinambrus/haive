import { describe, it, expect } from 'vitest';
import {
  injectMissingTier1Specialists,
  parseLlmAgentOutputWithDiagnostic,
} from '../src/step-engine/steps/onboarding/06_5-agent-discovery.js';
import type { TechInventory } from '../src/step-engine/steps/onboarding/_tech-inventory.js';

// The response had no way to say "I looked at this row and it needs no specialist", so a
// judged rejection and an oversight were the same bytes and the safety net assumed
// oversight. MEASURED on a live Drupal 7 run: the model was shown
// `Symfony (framework, 4 files)` — matches being a polyfill-mbstring vendored inside
// PhpSpreadsheet — correctly left it out, and `symfony-specialist` was put back on the
// user's form anyway.
const inventory = (names: string[]): TechInventory => ({
  items: names.map((name) => ({
    name,
    displayName: name,
    category: 'framework',
    manifests: [],
    matchedKeys: [],
    fileCount: 4,
  })),
  scannedManifests: [],
});

describe('injectMissingTier1Specialists', () => {
  it('still fills a row the model never ruled on — the net it has always been', () => {
    const candidates: never[] = [];
    injectMissingTier1Specialists(candidates, inventory(['symfony']), []);
    expect(candidates.map((c) => (c as { id: string }).id)).toEqual(['symfony-specialist']);
  });

  it('leaves out a row the model explicitly rejected', () => {
    const candidates: never[] = [];
    injectMissingTier1Specialists(candidates, inventory(['symfony']), [
      { id: 'symfony-specialist', reason: 'vendored polyfill inside PhpSpreadsheet' },
    ]);
    expect(candidates).toEqual([]);
  });

  // The prompt asks for the agent id; a model naming the bare tech means the same thing.
  it('accepts the bare tech name as a rejection too', () => {
    const candidates: never[] = [];
    injectMissingTier1Specialists(candidates, inventory(['symfony']), [
      { id: 'symfony', reason: 'third-party' },
    ]);
    expect(candidates).toEqual([]);
  });

  it('rejects only what was named', () => {
    const candidates: never[] = [];
    injectMissingTier1Specialists(candidates, inventory(['symfony', 'drupal-7']), [
      { id: 'symfony-specialist', reason: 'vendored' },
    ]);
    expect(candidates.map((c) => (c as { id: string }).id)).toEqual(['drupal-7-specialist']);
  });
});

describe('parseLlmAgentOutputWithDiagnostic — skipped rows', () => {
  const wrap = (body: string): string => '```json\n' + body + '\n```';

  it('carries a rejection with its reason', () => {
    const { result } = parseLlmAgentOutputWithDiagnostic(
      wrap(
        '{"predefined":{},"custom":[],"skipped":[{"id":"symfony-specialist","reason":"vendored"}]}',
      ),
    );
    expect(result?.skipped).toEqual([{ id: 'symfony-specialist', reason: 'vendored' }]);
  });

  // A response written before this field existed must parse exactly as it did.
  it('is an empty list when the field is absent', () => {
    const { result } = parseLlmAgentOutputWithDiagnostic(wrap('{"predefined":{},"custom":[]}'));
    expect(result?.skipped).toEqual([]);
  });

  // A malformed rejection must LOSE the row to the safety net, never suppress a
  // specialist on an id nobody can read.
  it('drops entries with no usable id, and tolerates a missing reason', () => {
    const { result } = parseLlmAgentOutputWithDiagnostic(
      wrap(
        '{"predefined":{},"custom":[],"skipped":[{"reason":"no id"},{"id":"  "},{"id":"ok-specialist"},"junk"]}',
      ),
    );
    expect(result?.skipped).toEqual([{ id: 'ok-specialist', reason: '' }]);
  });

  it('ignores a non-array skipped field', () => {
    const { result } = parseLlmAgentOutputWithDiagnostic(
      wrap('{"predefined":{},"custom":[],"skipped":"nope"}'),
    );
    expect(result?.skipped).toEqual([]);
  });

  // A predefined agent the model turns OFF stays on the form as an unticked box. Without
  // a reason the user is left guessing — MEASURED, two bundle agents the user had
  // deliberately imported were unticked with nothing shown, and the only way to learn why
  // was to read the raw invocation.
  it('carries a decline reason for a predefined agent', () => {
    const { result } = parseLlmAgentOutputWithDiagnostic(
      wrap(
        '{"predefined":{"bundle-x":false},"custom":[],"declined":[{"id":"bundle-x","reason":"body describes game modding, not Drupal"}]}',
      ),
    );
    expect(result?.declined).toEqual([
      { id: 'bundle-x', reason: 'body describes game modding, not Drupal' },
    ]);
  });

  it('is an empty list when the model declines nothing', () => {
    const { result } = parseLlmAgentOutputWithDiagnostic(wrap('{"predefined":{},"custom":[]}'));
    expect(result?.declined).toEqual([]);
  });
});
