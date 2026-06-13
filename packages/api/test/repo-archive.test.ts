import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepoArchiveStream } from '../src/lib/repo-archive.js';
import { HttpError } from '../src/context.js';

let workRoot: string;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'haive-repo-zip-'));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('createRepoArchiveStream', () => {
  it('derives a sanitized .zip filename from the repo name', async () => {
    const { filename } = await createRepoArchiveStream(workRoot, 'My Repo!');
    expect(filename).toBe('My-Repo.zip');
  });

  it('falls back to "repo" when the name sanitizes to empty', async () => {
    const { filename } = await createRepoArchiveStream(workRoot, '///');
    expect(filename).toBe('repo.zip');
  });

  it('streams a zip (PK magic) nesting contents under the repo-name folder', async () => {
    await writeFile(join(workRoot, 'README.md'), 'hello world');
    await mkdir(join(workRoot, 'src'));
    await writeFile(join(workRoot, 'src', 'index.ts'), 'export {};');

    const { stream } = await createRepoArchiveStream(workRoot, 'demo');
    const buf = await collect(stream);

    expect(buf.length).toBeGreaterThan(0);
    // Local file header signature 'PK\x03\x04'.
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
    // Zip stores entry paths verbatim (uncompressed) in local file headers.
    expect(buf.includes(Buffer.from('demo/README.md'))).toBe(true);
    expect(buf.includes(Buffer.from('demo/src/index.ts'))).toBe(true);
  });

  it('includes the .git directory and other dotfiles', async () => {
    await writeFile(join(workRoot, '.gitignore'), 'node_modules\n');
    await mkdir(join(workRoot, '.git'));
    await writeFile(join(workRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    const { stream } = await createRepoArchiveStream(workRoot, 'demo');
    const buf = await collect(stream);

    expect(buf.includes(Buffer.from('demo/.gitignore'))).toBe(true);
    expect(buf.includes(Buffer.from('demo/.git/HEAD'))).toBe(true);
  });

  it('throws 404 HttpError when the root does not exist', async () => {
    const missing = join(workRoot, 'nope');
    await expect(createRepoArchiveStream(missing, 'demo')).rejects.toMatchObject({ status: 404 });
    await expect(createRepoArchiveStream(missing, 'demo')).rejects.toBeInstanceOf(HttpError);
  });

  it('throws 409 HttpError when the root is a file, not a directory', async () => {
    const filePath = join(workRoot, 'plain.txt');
    await writeFile(filePath, 'data');
    await expect(createRepoArchiveStream(filePath, 'demo')).rejects.toMatchObject({ status: 409 });
  });
});
