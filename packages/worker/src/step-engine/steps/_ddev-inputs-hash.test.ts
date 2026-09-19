import { describe, it, expect } from 'vitest';
import { hashDdevEntries, type DdevInputEntry } from './_ddev-inputs-hash.js';

const e = (rel: string, content: string): DdevInputEntry => ({
  rel,
  content: Buffer.from(content),
});

describe('hashDdevEntries', () => {
  const config = e('.ddev/config.yaml', 'php_version: "8.3"\n');
  const extra = e('.ddev/php/extra.ini', 'memory_limit = 512M\n');
  const dockerfile = e('.ddev/web-build/Dockerfile', 'RUN echo hi\n');
  const base: DdevInputEntry[] = [config, extra, dockerfile];

  it('is order-independent (sorts before hashing)', () => {
    const shuffled = [dockerfile, config, extra];
    expect(hashDdevEntries(shuffled)).toBe(hashDdevEntries(base));
  });

  it('changes when a file content changes', () => {
    const changed = [config, e('.ddev/php/extra.ini', 'memory_limit = 1024M\n'), dockerfile];
    expect(hashDdevEntries(changed)).not.toBe(hashDdevEntries(base));
  });

  it('changes when a file is renamed (path folded into the hash)', () => {
    const renamed = [config, e('.ddev/php/renamed.ini', 'memory_limit = 512M\n'), dockerfile];
    expect(hashDdevEntries(renamed)).not.toBe(hashDdevEntries(base));
  });

  it('changes when a file is added or removed', () => {
    const withoutDockerfile = [config, extra];
    expect(hashDdevEntries(withoutDockerfile)).not.toBe(hashDdevEntries(base));
  });

  // The regression this fix exists for: the implementation added `.ddev/php/*.ini`
  // WITHOUT touching config.yaml, so a config.yaml-only hash was identical and 07c
  // no-op'd. The tree hash must differ.
  it('repro gap: adding .ddev/php/*.ini changes the hash even when config.yaml is unchanged', () => {
    const beforeImpl = [e('.ddev/config.yaml', 'php_version: "5.6"\n')];
    const afterImpl = [
      e('.ddev/config.yaml', 'php_version: "5.6"\n'),
      e('.ddev/php/rs-environment.ini', 'expose_php = Off\n'),
    ];
    expect(hashDdevEntries(afterImpl)).not.toBe(hashDdevEntries(beforeImpl));
  });
});
