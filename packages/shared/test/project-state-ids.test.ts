import { describe, expect, it } from 'vitest';
import {
  FOREIGN_TEMPLATE,
  localTemplateId,
  portableBundleSource,
  type LocalBundle,
} from '../src/project-state/index.js';

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

describe('portableBundleSource', () => {
  it('carries no credential a git URL was typed with', () => {
    const at = (gitUrl: string) =>
      portableBundleSource({ sourceType: 'git', gitUrl, gitBranch: 'main', name: 'b' });
    const source = (gitUrl: string) => `git:${encodeURIComponent(gitUrl)}#main`;
    const bare = source('https://example.com/b.git');
    expect(at('https://user:secrettoken@example.com/b.git')).toBe(bare);
    expect(at('https://secrettoken@example.com/b.git')).toBe(bare);
    expect(at('https://user:secret@token@example.com/b.git')).toBe(bare);
    expect(at('https://example.com/b.git?access_token=secrettoken')).toBe(bare);
    expect(at('https://example.com/b.git#secrettoken')).toBe(bare);
    expect(at('ssh://git@example.com/b.git?secrettoken')).toBe(
      source('ssh://git@example.com/b.git'),
    );
    expect(at('https://example.com/p@th/b.git')).toBe(source('https://example.com/p@th/b.git'));
    expect(at('ssh://git:secrettoken@example.com/b.git')).toBe(
      source('ssh://git@example.com/b.git'),
    );
    expect(at('git@example.com:b.git')).toBe(source('git@example.com:b.git'));
  });
});
