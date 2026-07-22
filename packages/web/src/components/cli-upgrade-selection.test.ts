import { describe, it, expect } from 'vitest';
import type { CliProvider, CliProviderCatalogEntry, CliProviderName } from '@/lib/api-client';
import { cliUpgradeLatest, groupUpgradable } from './cli-upgrade-selection';

const provider = (id: string, name: CliProviderName, cliVersion: string | null): CliProvider =>
  ({ id, name, label: `${name} ${id}`, cliVersion }) as CliProvider;

/** versions[0] is the newest published, matching the real catalog ordering. */
const meta = (
  name: CliProviderName,
  versions: string[],
  versionPinnable = true,
): CliProviderCatalogEntry =>
  ({
    name,
    versionPinnable,
    versionCache: versions.length ? { versions } : null,
  }) as CliProviderCatalogEntry;

describe('cliUpgradeLatest', () => {
  const versions = ['1.4.1', '1.3.0', '1.2.0'];

  it('offers the newest version when the pin is a known older entry', () => {
    expect(
      cliUpgradeLatest(provider('a', 'claude-code', '1.2.0'), meta('claude-code', versions)),
    ).toBe('1.4.1');
  });

  it('offers nothing when already on the newest', () => {
    expect(
      cliUpgradeLatest(provider('a', 'claude-code', '1.4.1'), meta('claude-code', versions)),
    ).toBeNull();
  });

  it('never proposes a downgrade for a pin missing from the cache', () => {
    expect(
      cliUpgradeLatest(provider('a', 'claude-code', '9.9.9'), meta('claude-code', versions)),
    ).toBeNull();
  });

  it('offers nothing for an unpinnable provider or an unpinned version', () => {
    expect(
      cliUpgradeLatest(provider('a', 'claude-code', '1.2.0'), meta('claude-code', versions, false)),
    ).toBeNull();
    expect(
      cliUpgradeLatest(provider('a', 'claude-code', null), meta('claude-code', versions)),
    ).toBeNull();
    expect(cliUpgradeLatest(provider('a', 'claude-code', '1.2.0'), undefined)).toBeNull();
  });
});

describe('groupUpgradable', () => {
  const catalog = [
    meta('claude-code', ['1.4.1', '1.3.0', '1.2.0']),
    meta('codex', ['0.9.3', '0.9.0']),
    meta('gemini', ['2.1.0', '2.0.1'], false),
  ];

  it('returns nothing when no provider has an upgrade', () => {
    const providers = [provider('a', 'claude-code', '1.4.1'), provider('b', 'codex', '0.9.3')];
    expect(groupUpgradable(providers, catalog)).toEqual([]);
  });

  it('groups several rows of the same CLI type under one entry', () => {
    const providers = [
      provider('a', 'claude-code', '1.2.0'),
      provider('b', 'claude-code', '1.3.0'),
      provider('c', 'codex', '0.9.0'),
    ];
    const groups = groupUpgradable(providers, catalog);
    expect(groups.map((g) => g.name)).toEqual(['claude-code', 'codex']);
    expect(groups[0]!.rows).toEqual([
      { id: 'a', label: 'claude-code a', from: '1.2.0', to: '1.4.1' },
      { id: 'b', label: 'claude-code b', from: '1.3.0', to: '1.4.1' },
    ]);
    expect(groups[1]!.rows).toHaveLength(1);
  });

  it('omits rows with no upgrade, and drops a type once all its rows are current', () => {
    const providers = [
      provider('a', 'claude-code', '1.4.1'),
      provider('b', 'claude-code', '1.2.0'),
      provider('c', 'codex', '0.9.3'),
    ];
    const groups = groupUpgradable(providers, catalog);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe('claude-code');
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(['b']);
  });

  it('excludes unpinnable types even when a newer version is published', () => {
    const groups = groupUpgradable([provider('a', 'gemini', '2.0.1')], catalog);
    expect(groups).toEqual([]);
  });
});
