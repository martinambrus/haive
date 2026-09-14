import { describe, expect, it } from 'vitest';
import { buildMountArgs } from '../src/sandbox/docker-runner.js';

describe('buildMountArgs', () => {
  it('refuses image copy-up on a subpath mount', () => {
    // Without volume-nocopy Docker seeds an EMPTY volume path from the image and copies that
    // directory's ownership onto it, so a scratch workspace handed to uid 1000 comes back
    // root:root and the sandbox user has an unwritable CWD.
    const args = buildMountArgs([
      { source: 'haive_repos', target: '/haive/workdir', subpath: 'user/_scratch/task' },
    ]);
    expect(args[0]).toBe('--mount');
    expect(args[1]!.split(',')).toContain('volume-nocopy=true');
  });

  it('keeps readonly on a subpath mount', () => {
    const args = buildMountArgs([
      { source: 'ca', target: '/ca/rootCA.pem', subpath: 'rootCA.pem', readOnly: true },
    ]);
    expect(args[1]!.split(',')).toEqual([
      'type=volume',
      'source=ca',
      'destination=/ca/rootCA.pem',
      'volume-subpath=rootCA.pem',
      'volume-nocopy=true',
      'readonly',
    ]);
  });

  it('leaves a whole-volume mount on the -v form', () => {
    // Auth volumes are populated by us and mounted whole; nothing here changes for them.
    expect(
      buildMountArgs([{ source: 'auth', target: '/home/node/.config', kind: 'auth' }]),
    ).toEqual(['-v', 'auth:/home/node/.config']);
    expect(buildMountArgs([{ source: 'auth', target: '/x', readOnly: true }])).toEqual([
      '-v',
      'auth:/x:ro',
    ]);
  });
});
