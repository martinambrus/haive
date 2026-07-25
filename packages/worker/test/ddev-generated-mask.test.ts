import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeDdevGeneratedMasks } from '../src/queues/cli-exec/ddev-generated-mask.js';

const MARKED = '#ddev-generated\nsome config\n';
const WORKDIR = '/haive/workdir';

let root: string;

async function write(rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

function targets(masks: { containerPath: string }[]): string[] {
  return masks.map((m) => m.containerPath.replace(`${WORKDIR}/.ddev/`, '')).sort();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ddev-mask-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('computeDdevGeneratedMasks', () => {
  it('masks marker-carrying config with its REAL bytes', async () => {
    // The point of the payload: the agent must still be able to READ the file. An empty
    // mask (what secret-masking uses) would make DDEV's own config look corrupt.
    const conf = '#ddev-generated\n<VirtualHost *:80>\n  Alias "/phpstatus" "/x"\n</VirtualHost>\n';
    await write('.ddev/apache/apache-site.conf', conf);

    const masks = await computeDdevGeneratedMasks(root, WORKDIR);

    expect(masks).toHaveLength(1);
    expect(masks[0]!.containerPath).toBe(`${WORKDIR}/.ddev/apache/apache-site.conf`);
    expect(masks[0]!.content).toBe(conf);
  });

  it('leaves user-owned files writable', async () => {
    // config.yaml and web-build/Dockerfile are the project's to edit — an "Add DDEV" task
    // does nothing if it cannot write them.
    await write('.ddev/config.yaml', 'name: proj\nphp_version: "5.6"\n');
    await write('.ddev/web-build/Dockerfile', 'RUN apt-get install -y php5.6-mysql\n');
    await write('.ddev/apache/proj.conf', '<Location /x>\n</Location>\n');

    expect(await computeDdevGeneratedMasks(root, WORKDIR)).toEqual([]);
  });

  it('does NOT mask a file whose marker was already stripped', async () => {
    // The aba4d722 case. Masking a broken file read-only would freeze the breakage in
    // place; the pre-flight healthcheck guard is what catches this one.
    await write('.ddev/apache/apache-site.conf', '<VirtualHost *:80>\n</VirtualHost>\n');

    expect(await computeDdevGeneratedMasks(root, WORKDIR)).toEqual([]);
  });

  it('skips docs and templates so the mount count stays sane', async () => {
    await write('.ddev/apache/README.apache.txt', MARKED);
    await write('.ddev/apache/seconddocroot.conf.example', MARKED);
    await write('.ddev/nginx_full/nginx-site.conf', MARKED);

    expect(targets(await computeDdevGeneratedMasks(root, WORKDIR))).toEqual([
      'nginx_full/nginx-site.conf',
    ]);
  });

  it('skips DDEV build/state subtrees', async () => {
    await write('.ddev/.webimageBuild/Dockerfile', MARKED);
    await write('.ddev/.dbimageBuild/Dockerfile', MARKED);
    await write('.ddev/db_snapshots/snap/meta.yaml', MARKED);
    await write('.ddev/traefik/config/proj.yaml', MARKED);

    expect(targets(await computeDdevGeneratedMasks(root, WORKDIR))).toEqual([
      'traefik/config/proj.yaml',
    ]);
  });

  it('recurses into nested config directories', async () => {
    await write('.ddev/commands/web/mycmd', MARKED);
    await write('.ddev/commands/host/other', MARKED);

    expect(targets(await computeDdevGeneratedMasks(root, WORKDIR))).toEqual([
      'commands/host/other',
      'commands/web/mycmd',
    ]);
  });

  it('does not follow symlinks out of the tree', async () => {
    await write('.ddev/apache/real.conf', MARKED);
    await writeFile(join(root, 'outside.conf'), MARKED, 'utf8');
    await symlink(join(root, 'outside.conf'), join(root, '.ddev/apache/link.conf'));

    expect(targets(await computeDdevGeneratedMasks(root, WORKDIR))).toEqual(['apache/real.conf']);
  });

  it('ignores the marker when it appears far into a large file', async () => {
    // Probe-bounded on purpose: a marker buried in an agent-authored file is not DDEV
    // declaring ownership of it.
    await write('.ddev/apache/big.conf', `${'x'.repeat(8000)}\n#ddev-generated\n`);

    expect(await computeDdevGeneratedMasks(root, WORKDIR)).toEqual([]);
  });

  it('returns [] when the repo has no .ddev directory', async () => {
    expect(await computeDdevGeneratedMasks(root, WORKDIR)).toEqual([]);
  });

  it('returns [] for a root that does not exist', async () => {
    expect(await computeDdevGeneratedMasks(join(root, 'nope'), WORKDIR)).toEqual([]);
  });

  it('targets the mount the invocation actually uses', async () => {
    await write('.ddev/apache/apache-site.conf', MARKED);

    const masks = await computeDdevGeneratedMasks(root, '/other/mount');
    expect(masks[0]!.containerPath).toBe('/other/mount/.ddev/apache/apache-site.conf');
  });
});
