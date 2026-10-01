import { describe, expect, it } from 'vitest';
import { FOREIGN_TEMPLATE, localTemplateId, type LocalBundle } from '../src/project-state/index.js';

describe('localTemplateId with a source two local bundles hold', () => {
  it('reads a zip source as foreign when two bundles hold the same item path', () => {
    const source = 'zip:skills';
    const sourcePath = 'agents/a.md';
    const portableId = `custom:${encodeURIComponent(source)}:${encodeURIComponent(sourcePath)}`;
    const a: LocalBundle = {
      bundleId: 'bundle-a',
      source,
      items: new Map([['item-1', sourcePath]]),
    };
    const b: LocalBundle = {
      bundleId: 'bundle-b',
      source,
      items: new Map([['item-2', sourcePath]]),
    };
    expect(localTemplateId(portableId, [a, b])).toBe(FOREIGN_TEMPLATE);
    expect(localTemplateId(portableId, [b, a])).toBe(FOREIGN_TEMPLATE);
  });

  it('reads a git source as foreign when two bundles hold the same item path', () => {
    const source = 'git:https://example.test/x.git#main';
    const sourcePath = 'agents/a.md';
    const portableId = `custom:${encodeURIComponent(source)}:${encodeURIComponent(sourcePath)}`;
    const a: LocalBundle = {
      bundleId: 'bundle-a',
      source,
      items: new Map([['item-1', sourcePath]]),
    };
    const b: LocalBundle = {
      bundleId: 'bundle-b',
      source,
      items: new Map([['item-2', sourcePath]]),
    };
    expect(localTemplateId(portableId, [a, b])).toBe(FOREIGN_TEMPLATE);
    expect(localTemplateId(portableId, [b, a])).toBe(FOREIGN_TEMPLATE);
  });

  it('reads a single bundle at that source and path back to its ids, as a guard', () => {
    const source = 'zip:skills';
    const sourcePath = 'agents/a.md';
    const portableId = `custom:${encodeURIComponent(source)}:${encodeURIComponent(sourcePath)}`;
    const bundle: LocalBundle = {
      bundleId: 'bundle-a',
      source,
      items: new Map([['item-1', sourcePath]]),
    };
    expect(localTemplateId(portableId, [bundle])).toBe('custom.bundle-a.item-1');
  });
});
