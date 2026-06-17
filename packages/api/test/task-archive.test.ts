import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskArchiveStream } from '../src/lib/task-archive.js';
import { HttpError } from '../src/context.js';

let workRoot: string;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'haive-archive-src-'));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('createTaskArchiveStream', () => {
  it('returns a .zip filename derived from task id', async () => {
    const { filename } = await createTaskArchiveStream(workRoot, 'abc-123');
    expect(filename).toBe('task-abc-123-source.zip');
  });

  it('streams a zip (PK magic) nesting contents under the task-source folder', async () => {
    await writeFile(join(workRoot, 'README.md'), 'hello world');
    await mkdir(join(workRoot, 'src'));
    await writeFile(join(workRoot, 'src', 'index.ts'), 'export {};');

    const { stream } = await createTaskArchiveStream(workRoot, 'task-1');
    const buf = await collect(stream);

    expect(buf.length).toBeGreaterThan(0);
    // Local file header signature 'PK\x03\x04'.
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
    // Zip stores entry paths verbatim (uncompressed) in local file headers.
    expect(buf.includes(Buffer.from('task-1-source/README.md'))).toBe(true);
    expect(buf.includes(Buffer.from('task-1-source/src/index.ts'))).toBe(true);
  });

  it('includes hidden files and directories', async () => {
    await writeFile(join(workRoot, '.gitignore'), 'node_modules\n');
    await mkdir(join(workRoot, '.claude'));
    await writeFile(join(workRoot, '.claude', 'config.json'), '{"x":1}');

    const { stream } = await createTaskArchiveStream(workRoot, 'task-2');
    const buf = await collect(stream);

    expect(buf.includes(Buffer.from('task-2-source/.gitignore'))).toBe(true);
    expect(buf.includes(Buffer.from('task-2-source/.claude/config.json'))).toBe(true);
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

  it('produces a non-empty zip even for an empty workspace', async () => {
    const { stream } = await createTaskArchiveStream(workRoot, 'task-5');
    const buf = await collect(stream);
    expect(buf.length).toBeGreaterThan(0);
    // Any zip record starts with the 'PK' signature.
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });
});
