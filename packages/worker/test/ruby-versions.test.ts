import { describe, expect, it } from 'vitest';
import { parseRubyBuilderAssets } from '../src/cli-versions/ruby-versions.js';
import { resolveRubyVersion } from '../src/step-engine/steps/env-replicate/01-declare-deps.js';

/** Asset names taken verbatim from the live `ruby/ruby-builder` toolcache release. Every
 *  exclusion below is one MEASURED against it, not a hypothetical: the release carries 919
 *  assets, of which 129 wear the ubuntu-24.04 suffix and only 95 are installable CRuby. */
const assets = (names: string[]) => ({ assets: names.map((name) => ({ name })) });

describe('parseRubyBuilderAssets', () => {
  it('returns installable CRuby builds newest first', () => {
    expect(
      parseRubyBuilderAssets(
        assets([
          'ruby-3.3.9-ubuntu-24.04.tar.gz',
          'ruby-3.4.6-ubuntu-24.04.tar.gz',
          'ruby-3.4.5-ubuntu-24.04.tar.gz',
        ]),
      ),
    ).toEqual([
      { version: '3.4.6', label: 'Ruby 3.4.6' },
      { version: '3.4.5', label: 'Ruby 3.4.5' },
      { version: '3.3.9', label: 'Ruby 3.3.9' },
    ]);
  });

  // jruby and truffleruby are 33 of the 129 assets carrying this OS suffix. They are not
  // interpreters this image installs, and an unanchored match would sweep them in.
  it('excludes jruby and truffleruby', () => {
    expect(
      parseRubyBuilderAssets(
        assets([
          'jruby-10.0.0.0-ubuntu-24.04.tar.gz',
          'truffleruby-24.1.1-ubuntu-24.04.tar.gz',
          'ruby-3.4.6-ubuntu-24.04.tar.gz',
        ]),
      ),
    ).toEqual([{ version: '3.4.6', label: 'Ruby 3.4.6' }]);
  });

  // The arm64 builds share the OS suffix and differ only after it, so without anchoring the
  // name's END the catalog would offer a binary this image cannot run.
  it('excludes the arm64 builds', () => {
    expect(parseRubyBuilderAssets(assets(['ruby-3.4.6-ubuntu-24.04-arm64.tar.gz']))).toEqual([]);
  });

  // A different suite's tarball links against that suite's shared libraries. Offering one
  // would install an interpreter that cannot start.
  it('excludes builds for another suite', () => {
    expect(parseRubyBuilderAssets(assets(['ruby-3.4.6-ubuntu-22.04.tar.gz']))).toEqual([]);
  });

  it('excludes previews but keeps the -pNNN releases 2.0/2.1 shipped with', () => {
    expect(
      parseRubyBuilderAssets(
        assets(['ruby-3.5.0-preview1-ubuntu-24.04.tar.gz', 'ruby-2.0.0-p648-ubuntu-24.04.tar.gz']),
      ),
    ).toEqual([{ version: '2.0.0-p648', label: 'Ruby 2.0.0-p648' }]);
  });

  it('survives a payload whose shape changed, rather than throwing', () => {
    expect(parseRubyBuilderAssets(null)).toEqual([]);
    expect(parseRubyBuilderAssets({})).toEqual([]);
    expect(parseRubyBuilderAssets({ assets: 'nope' })).toEqual([]);
    expect(parseRubyBuilderAssets({ assets: [{}, { name: 42 }] })).toEqual([]);
  });
});

describe('resolveRubyVersion', () => {
  // Newest first, as the refresher writes it.
  const catalog = [
    { version: '3.4.6' },
    { version: '3.4.5' },
    { version: '3.1.7' },
    { version: '3.1.0' },
    { version: '2.7.8' },
  ];

  it('takes an exact version straight through', () => {
    expect(resolveRubyVersion('3.1.0', catalog)).toBe('3.1.0');
    expect(resolveRubyVersion('2.7.8', catalog)).toBe('2.7.8');
  });

  // A Gemfile commonly says `ruby "3.1"`, and no such artifact exists — this is the case the
  // whole resolution exists for.
  it('widens a two-part version to the newest patch on that line', () => {
    expect(resolveRubyVersion('3.1', catalog)).toBe('3.1.7');
    expect(resolveRubyVersion('3.4', catalog)).toBe('3.4.6');
  });

  // Widening a three-part request would quietly serve a DIFFERENT patch than asked for.
  // Falling back visibly to apt is the better answer.
  it('never widens a three-part version that has no build', () => {
    expect(resolveRubyVersion('3.1.4', catalog)).toBeNull();
  });

  it('resolves nothing when the line has no build at all', () => {
    expect(resolveRubyVersion('3.2', catalog)).toBeNull();
    expect(resolveRubyVersion('9.9.9', catalog)).toBeNull();
  });

  // A cold cache, a downed feed and an absent declaration must all land the same way: the
  // apt install path, which is what shipped before this existed.
  it('resolves nothing for an empty catalog or an empty declaration', () => {
    expect(resolveRubyVersion('3.4.6', [])).toBeNull();
    expect(resolveRubyVersion('', catalog)).toBeNull();
    expect(resolveRubyVersion(null, catalog)).toBeNull();
    expect(resolveRubyVersion(undefined, catalog)).toBeNull();
  });

  // `.ruby-version` files are sometimes written as `ruby-3.4.6`.
  it('tolerates a ruby- prefixed .ruby-version value', () => {
    expect(resolveRubyVersion('ruby-3.4.6', catalog)).toBe('3.4.6');
  });
});
