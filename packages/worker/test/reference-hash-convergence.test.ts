import { describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { hashRenderings, normalizeContent, sha256Hex } from '@haive/shared';
import {
  convergeReferenceHashes,
  getTemplateManifest,
} from '../src/step-engine/template-manifest.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';
const TASK = '00000000-0000-4000-8000-0000000000d1';
const USER = '00000000-0000-4000-8000-0000000000a1';
const EMPTY = hashRenderings([]);

const manifest = getTemplateManifest();
const rtk = manifest.items.find((i) => i.id === 'rtk.claude-settings')!;
const [render] = rtk.render(rtk.referenceCtx!);
const todaysBody = sha256Hex(normalizeContent(render!.content));

function seed(rows: Record<string, unknown>[]) {
  const fake = createFakeDb({ onboardingArtifacts: schema.onboardingArtifacts });
  const ids = rows.map(
    (overrides) =>
      fake.insert(schema.onboardingArtifacts, {
        userId: USER,
        repositoryId: REPO,
        taskId: TASK,
        diskPath: render!.diskPath,
        templateId: rtk.id,
        templateKind: rtk.kind,
        templateSchemaVersion: rtk.schemaVersion,
        templateContentHash: EMPTY,
        writtenHash: todaysBody,
        sourceStepId: '12-post-onboarding',
        ...overrides,
      }).id as string,
  );
  const hashOf = (i: number) =>
    fake.rows(schema.onboardingArtifacts).find((r) => r.id === ids[i])!.templateContentHash;
  return { fake, hashOf };
}

describe('reference hash convergence', () => {
  it('has an item whose reference context renders a body', () => {
    expect(rtk.contentHash).not.toBe(EMPTY);
    expect(render?.diskPath).toBe('.claude/settings.json');
  });

  it("brings a row holding today's body to the item's hash, live or superseded", async () => {
    const t = seed([{}, { supersededAt: new Date(1) }]);
    await convergeReferenceHashes(t.fake.db as never, manifest);
    expect([t.hashOf(0), t.hashOf(1)]).toEqual([rtk.contentHash, rtk.contentHash]);
  });

  it('leaves a row holding an older body on the hash of nothing, so the banner offers the newer one', async () => {
    const t = seed([{ writtenHash: sha256Hex('an older body\n') }]);
    await convergeReferenceHashes(t.fake.db as never, manifest);
    expect(t.hashOf(0)).toBe(EMPTY);
  });

  it('leaves other templates, other schema versions and a declined edit alone', async () => {
    const t = seed([
      { templateId: 'workflow-config', templateKind: 'workflow-config' },
      { templateSchemaVersion: rtk.schemaVersion + 1 },
      { templateContentHash: sha256Hex('what the person kept\n') },
    ]);
    await convergeReferenceHashes(t.fake.db as never, manifest);
    expect([t.hashOf(0), t.hashOf(1), t.hashOf(2)]).toEqual([
      EMPTY,
      EMPTY,
      sha256Hex('what the person kept\n'),
    ]);
  });

  it('changes nothing the second time', async () => {
    const t = seed([{}, { writtenHash: sha256Hex('an older body\n') }]);
    await convergeReferenceHashes(t.fake.db as never, manifest);
    const once = [t.hashOf(0), t.hashOf(1)];
    await convergeReferenceHashes(t.fake.db as never, manifest);
    expect([t.hashOf(0), t.hashOf(1)]).toEqual(once);
  });
});
