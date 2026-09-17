import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { extractArchive } from '../src/repo/clone.js';

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed (${code}): ${stderr.trim()}`));
    });
  });
}

async function buildFixtureSource(root: string, topDir: string): Promise<string> {
  const src = path.join(root, topDir);
  await mkdir(path.join(src, 'sub'), { recursive: true });
  await writeFile(path.join(src, 'README.md'), '# fixture\n');
  await writeFile(path.join(src, 'sub', 'a.txt'), 'hello\n');
  await writeFile(path.join(src, 'package.json'), JSON.stringify({ name: 'fixture' }));
  return src;
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-extract-'));
  // mkdtemp is ALWAYS 0700, which the unprivileged extraction uid cannot traverse — so when these
  // run as root (the in-image CI job) every case fails on the fixture rather than on the code, and
  // both the stage and the archive `unzip` has to open sit under here. MEASURED in the running
  // worker: every level of every real anchor chain — the storage and bundle roots, each `<userId>`
  // and `<repoId>`, `.haive` and the uploads dir — is 0755. So this matches production rather than
  // relaxing anything: extraction requires the destination's parents to be traversable.
  await chmod(tmpRoot, 0o711);
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('extractArchive', () => {
  it('extracts .tar.gz and flattens single top-level directory', async () => {
    await buildFixtureSource(tmpRoot, 'my-project');
    const archivePath = path.join(tmpRoot, 'fixture.tar.gz');
    await run('tar', ['-czf', archivePath, '-C', tmpRoot, 'my-project']);

    const dest = path.join(tmpRoot, 'out');
    await extractArchive(archivePath, 'tar.gz', dest);

    const entries = await readdir(dest);
    expect(entries.sort()).toEqual(['README.md', 'package.json', 'sub'].sort());
    const readme = await readFile(path.join(dest, 'README.md'), 'utf8');
    expect(readme).toBe('# fixture\n');
    const sub = await readFile(path.join(dest, 'sub', 'a.txt'), 'utf8');
    expect(sub).toBe('hello\n');
  });

  it('extracts plain .tar', async () => {
    await buildFixtureSource(tmpRoot, 'proj');
    const archivePath = path.join(tmpRoot, 'fixture.tar');
    await run('tar', ['-cf', archivePath, '-C', tmpRoot, 'proj']);

    const dest = path.join(tmpRoot, 'out-tar');
    await extractArchive(archivePath, 'tar', dest);

    const entries = await readdir(dest);
    expect(entries).toContain('README.md');
    expect(entries).toContain('package.json');
  });

  it('extracts .zip and flattens single top-level directory', async () => {
    await buildFixtureSource(tmpRoot, 'zipped');
    const archivePath = path.join(tmpRoot, 'fixture.zip');
    // Build the fixture archive in pure JS so the test doesn't depend on the
    // `zip` system binary (only `unzip` is installed in the runtime image).
    const zip = new JSZip();
    zip.file('zipped/README.md', '# fixture\n');
    zip.file('zipped/sub/a.txt', 'hello\n');
    zip.file('zipped/package.json', JSON.stringify({ name: 'fixture' }));
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    await writeFile(archivePath, zipBuffer);

    const dest = path.join(tmpRoot, 'out-zip');
    await extractArchive(archivePath, 'zip', dest);

    const entries = await readdir(dest);
    expect(entries.sort()).toEqual(['README.md', 'package.json', 'sub'].sort());
  });

  it('does not flatten when archive has multiple top-level entries', async () => {
    const src = path.join(tmpRoot, 'multi');
    await mkdir(path.join(src, 'dirA'), { recursive: true });
    await mkdir(path.join(src, 'dirB'), { recursive: true });
    await writeFile(path.join(src, 'dirA', 'a'), '1');
    await writeFile(path.join(src, 'dirB', 'b'), '2');
    const archivePath = path.join(tmpRoot, 'multi.tar.gz');
    await run('tar', ['-czf', archivePath, '-C', src, 'dirA', 'dirB']);

    const dest = path.join(tmpRoot, 'out-multi');
    await extractArchive(archivePath, 'tar.gz', dest);

    const entries = await readdir(dest);
    expect(entries.sort()).toEqual(['dirA', 'dirB']);
  });

  it('does not flatten when the only top-level entry is a link', async () => {
    // An uploaded archive is untrusted, and the flatten used to `stat` its lone entry: a LINK there
    // was followed, `readdir` listed the TARGET's children, and each was renamed into the
    // destination. With `x -> ..` those children are the user's other repositories.
    const staging = path.join(tmpRoot, 'staging');
    const sibling = path.join(tmpRoot, 'sibling-repo');
    await mkdir(staging, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(path.join(sibling, 'their-file.txt'), 'another repo\n');
    await run('ln', ['-s', '..', path.join(staging, 'escape')]);
    const archivePath = path.join(tmpRoot, 'link.tar.gz');
    // No `-h`: tar stores a symlink AS a symlink by default, which is the fixture this needs.
    await run('tar', ['-czf', archivePath, '-C', staging, 'escape']);

    const dest = path.join(tmpRoot, 'out-link');
    const report = await extractArchive(archivePath, 'tar.gz', dest);

    // The link is DROPPED now, not merely left unfollowed — a symlink cannot safely live in an
    // extracted repository tree, and the flatten is no longer the only thing standing between
    // `escape -> ..` and every sibling repository under the staging parent.
    const entries = await readdir(dest);
    expect(entries).toEqual([]);
    expect(entries).not.toContain('sibling-repo');

    // And the drop is REPORTED. A member silently removed from someone's upload is the one outcome
    // worse than refusing the archive outright.
    expect(report.dropped).toEqual([{ rel: 'escape', reason: 'symlink' }]);
    expect(report.note).toContain('not extracted');
    expect(report.note).toContain('escape');

    // The sibling it pointed at is untouched.
    const siblingFile = await readFile(path.join(sibling, 'their-file.txt'), 'utf8');
    expect(siblingFile).toBe('another repo\n');
  });

  it('reports nothing when every member is ordinary', async () => {
    await buildFixtureSource(tmpRoot, 'clean');
    const archivePath = path.join(tmpRoot, 'clean.tar.gz');
    await run('tar', ['-czf', archivePath, '-C', tmpRoot, 'clean']);

    const report = await extractArchive(archivePath, 'tar.gz', path.join(tmpRoot, 'out-clean'));
    expect(report.dropped).toEqual([]);
    expect(report.note).toBeNull();
  });

  it('replaces an existing destination only once the new tree is ready', async () => {
    // The swap is the reason extraction stages: the old shape `rm -rf`'d the destination BEFORE
    // unpacking, so a failure left the repository empty. Here the previous contents survive until a
    // validated tree is ready to take their place.
    const dest = path.join(tmpRoot, 'out-replace');
    await mkdir(dest, { recursive: true });
    await writeFile(path.join(dest, 'previous.txt'), 'old\n');

    await buildFixtureSource(tmpRoot, 'fresh');
    const archivePath = path.join(tmpRoot, 'fresh.tar.gz');
    await run('tar', ['-czf', archivePath, '-C', tmpRoot, 'fresh']);
    await extractArchive(archivePath, 'tar.gz', dest);

    const entries = await readdir(dest);
    expect(entries).toContain('README.md');
    expect(entries).not.toContain('previous.txt');
    // No stage left beside it.
    expect((await readdir(tmpRoot)).filter((n) => n.startsWith('.haive-extract-'))).toEqual([]);
  });

  it('rejects unsupported format', async () => {
    const archivePath = path.join(tmpRoot, 'fake.bin');
    await writeFile(archivePath, 'not an archive');
    await expect(
      extractArchive(archivePath, 'rar' as never, path.join(tmpRoot, 'out-bad')),
    ).rejects.toThrow();
  });
});
