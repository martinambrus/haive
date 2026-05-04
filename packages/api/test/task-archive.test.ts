import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { PassThrough } from 'node:stream';
import tar from 'tar-fs';
import { createTaskArchiveStream } from '../src/lib/task-archive.js';
import { HttpError } from '../src/context.js';

let workRoot: string;
let extractRoot: string;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'haive-archive-src-'));
  extractRoot = await mkdtemp(join(tmpdir(), 'haive-archive-out-'));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
  await rm(extractRoot, { recursive: true, force: true });
});

async function extractStream(stream: NodeJS.ReadableStream, dest: string): Promise<void> {
  await pipeline(stream as PassThrough, createGunzip(), tar.extract(dest));
}

describe('createTaskArchiveStream', () => {
  it('returns filename derived from task id', async () => {
    const { filename } = await createTaskArchiveStream(workRoot, 'abc-123');
    expect(filename).toBe('task-abc-123-source.tar.gz');
  });

  it('streams a valid gzip tar of the workspace contents', async () => {
    await writeFile(join(workRoot, 'README.md'), 'hello world');
    await mkdir(join(workRoot, 'src'));
    await writeFile(join(workRoot, 'src', 'index.ts'), 'export {};');

    const { stream } = await createTaskArchiveStream(workRoot, 'task-1');
    await extractStream(stream, extractRoot);

    expect(await readFile(join(extractRoot, 'README.md'), 'utf8')).toBe('hello world');
    expect(await readFile(join(extractRoot, 'src', 'index.ts'), 'utf8')).toBe('export {};');
  });

  it('includes hidden files and directories', async () => {
    await writeFile(join(workRoot, '.gitignore'), 'node_modules\n');
    await mkdir(join(workRoot, '.claude'));
    await writeFile(join(workRoot, '.claude', 'config.json'), '{"x":1}');

    const { stream } = await createTaskArchiveStream(workRoot, 'task-2');
    await extractStream(stream, extractRoot);

    expect(await readFile(join(extractRoot, '.gitignore'), 'utf8')).toBe('node_modules\n');
    expect(await readFile(join(extractRoot, '.claude', 'config.json'), 'utf8')).toBe('{"x":1}');
  });

  it('throws 404 HttpError when the root does not exist', async () => {
    const missing = join(workRoot, 'does-not-exist');
    await expect(createTaskArchiveStream(missing, 'task-3')).rejects.toMatchObject({
      status: 404,
    });
    await expect(createTaskArchiveStream(missing, 'task-3')).rejects.toBeInstanceOf(HttpError);
  });

  it('throws 409 HttpError when the root is a file, not a directory', async () => {
    const filePath = join(workRoot, 'plain.txt');
    await writeFile(filePath, 'data');
    await expect(createTaskArchiveStream(filePath, 'task-4')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('produces a non-empty archive even for an empty workspace', async () => {
    const { stream } = await createTaskArchiveStream(workRoot, 'task-5');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const buf = Buffer.concat(chunks);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);
  });
});
