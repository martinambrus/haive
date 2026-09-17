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

  it('drops every link a zip carries and names each one, however deep', async () => {
    // Every other link case here is a TAR. Production reads a .zip with Info-ZIP, which restores
    // link entries of its own accord (MEASURED against the image's unzip 6.00), so the staged-tree
    // walk — not the tool — is what has to catch them. `platform: 'UNIX'` is load-bearing: without
    // it JSZip writes a DOS "version made by", unzip ignores the mode bits, and both entries land
    // as ordinary files holding the target text, leaving this asserting a drop that never happened.
    const archivePath = path.join(tmpRoot, 'links.zip');
    const zip = new JSZip();
    zip.file('README.md', '# fixture\n');
    zip.file('src/index.js', 'export const x = 1;\n');
    zip.file('config-ref', '../outside/config.json', { unixPermissions: 0o120777 });
    zip.file('docs/readme-link', '../README.md', { unixPermissions: 0o120777 });
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));

    const dest = path.join(tmpRoot, 'out-zip-links');
    const report = await extractArchive(archivePath, 'zip', dest);

    // Named by their path relative to the extracted root, so a member nested below the top level is
    // distinguishable from one beside it — a walk that only checked depth 1 would pass every other
    // case in this file and fail here. Sorted, because the walk is a LIFO stack over an unsorted
    // `readdir` and the order of `dropped` is not part of the contract.
    expect([...report.dropped].sort((a, b) => a.rel.localeCompare(b.rel))).toEqual([
      { rel: 'config-ref', reason: 'symlink' },
      { rel: 'docs/readme-link', reason: 'symlink' },
    ]);
    expect(report.note).toContain('not extracted');
    expect(report.note).toContain('config-ref');
    expect(report.note).toContain('docs/readme-link');

    // The ordinary members survive, and the directory that held a link is kept rather than removed
    // with it.
    expect((await readdir(dest)).sort()).toEqual(['README.md', 'docs', 'src']);
    expect(await readdir(path.join(dest, 'docs'))).toEqual([]);
    expect(await readFile(path.join(dest, 'README.md'), 'utf8')).toBe('# fixture\n');
  });

  it('drops a link even when its target sits inside the same tree', async () => {
    // Deliberate, and nothing else pins it: an in-tree target is still extracted at its own path,
    // so refusing the link loses no content, and an in-tree link is how a tree names a file that is
    // otherwise masked or private. A change that starts keeping these should fail right here.
    const archivePath = path.join(tmpRoot, 'intree.zip');
    const zip = new JSZip();
    zip.file('README.md', '# real\n');
    zip.file('keep.txt', 'ordinary\n');
    zip.file('alias.md', 'README.md', { unixPermissions: 0o120777 });
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));

    const dest = path.join(tmpRoot, 'out-intree');
    const report = await extractArchive(archivePath, 'zip', dest);

    expect(report.dropped).toEqual([{ rel: 'alias.md', reason: 'symlink' }]);
    expect((await readdir(dest)).sort()).toEqual(['README.md', 'keep.txt']);
    expect(await readFile(path.join(dest, 'README.md'), 'utf8')).toBe('# real\n');
  });

  it('does not flatten a zip with several top-level entries', async () => {
    // The tar path has this case; the zip path reaches the flatten through a different branch
    // (`unzip -d`, rather than tar reading the archive on stdin) and had none.
    const archivePath = path.join(tmpRoot, 'multi.zip');
    const zip = new JSZip();
    zip.file('dirA/a.txt', '1');
    zip.file('dirB/b.txt', '2');
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer' }));

    const dest = path.join(tmpRoot, 'out-zip-multi');
    const report = await extractArchive(archivePath, 'zip', dest);

    expect((await readdir(dest)).sort()).toEqual(['dirA', 'dirB']);
    expect(report.dropped).toEqual([]);
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
