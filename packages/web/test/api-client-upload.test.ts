import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadTaskAttachment } from '../src/lib/api-client.js';

const GATEWAY_PAGE = '<html>bad gateway</html>';

const failedWith = async (file: File, status: number, body: string): Promise<string> => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status })),
  );
  try {
    await uploadTaskAttachment('task-1', file);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('the upload did not fail');
};

const inFolder = (path: string) => {
  const file = new File(['x'], path.split('/').pop()!);
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
};

describe('a failed task attachment upload', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names a file from a picked folder by its path inside the folder when the api sends no message', async () => {
    expect(await failedWith(inFolder('docs/api/spec.md'), 502, GATEWAY_PAGE)).toBe(
      'Failed to upload docs/api/spec.md (HTTP 502)',
    );
  });

  it('names a loose file by its own name', async () => {
    expect(await failedWith(new File(['x'], 'spec.md'), 502, GATEWAY_PAGE)).toBe(
      'Failed to upload spec.md (HTTP 502)',
    );
  });

  it('keeps the message the api sent, whatever the file is called', async () => {
    const body = JSON.stringify({ error: 'too large' });
    expect(await failedWith(inFolder('docs/api/spec.md'), 413, body)).toBe('too large');
  });
});
