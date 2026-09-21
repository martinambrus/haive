import { describe, expect, it } from 'vitest';
import { buildMountArgs } from './docker-runner.js';

describe('buildMountArgs', () => {
  it('renders a bind mount as -v, read-only with :ro', () => {
    expect(buildMountArgs([{ source: '/host-fs/proj', target: '/haive/workdir' }])).toEqual([
      '-v',
      '/host-fs/proj:/haive/workdir',
    ]);
    expect(
      buildMountArgs([{ source: '/host-fs/proj', target: '/haive/workdir', readOnly: true }]),
    ).toEqual(['-v', '/host-fs/proj:/haive/workdir:ro']);
  });

  it('renders a volume subpath mount with volume-nocopy', () => {
    expect(
      buildMountArgs([{ source: 'haive_repos', target: '/haive/workdir', subpath: 'u/r' }]),
    ).toEqual([
      '--mount',
      'type=volume,source=haive_repos,destination=/haive/workdir,volume-subpath=u/r,volume-nocopy=true',
    ]);
  });

  it('renders a tmpfs mount, ignoring source, and adds readonly only when asked', () => {
    expect(
      buildMountArgs([{ source: '', target: '/haive/workdir/.claude/agents', tmpfs: true }]),
    ).toEqual(['--mount', 'type=tmpfs,destination=/haive/workdir/.claude/agents']);
    expect(
      buildMountArgs([
        { source: '', target: '/haive/workdir/.claude/agents', tmpfs: true, readOnly: true },
      ]),
    ).toEqual(['--mount', 'type=tmpfs,destination=/haive/workdir/.claude/agents,readonly']);
  });

  it('takes the tmpfs branch before the subpath and bind branches', () => {
    // A tmpfs entry carries no source; the bind branch would render `-v :<target>`, and a
    // subpath would otherwise win and emit a volume mount with no volume behind it.
    expect(buildMountArgs([{ source: '', target: '/t', tmpfs: true, subpath: 'u/r' }])).toEqual([
      '--mount',
      'type=tmpfs,destination=/t',
    ]);
  });

  it('keeps mount order and mixes forms', () => {
    expect(
      buildMountArgs([
        { source: 'haive_repos', target: '/haive/workdir', subpath: 'u/r' },
        { source: '', target: '/haive/workdir/.claude/agents', tmpfs: true, readOnly: true },
        { source: '/var/uploads', target: '/haive/uploads', readOnly: true },
      ]),
    ).toEqual([
      '--mount',
      'type=volume,source=haive_repos,destination=/haive/workdir,volume-subpath=u/r,volume-nocopy=true',
      '--mount',
      'type=tmpfs,destination=/haive/workdir/.claude/agents,readonly',
      '-v',
      '/var/uploads:/haive/uploads:ro',
    ]);
  });
});
