import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FORGE_RESPONSE_MAX_BYTES,
  ForgeAuthError,
  ForgeError,
  ForgeNotFoundError,
  GithubForgeProvider,
  readForgeJson,
  type ForgeContext,
} from '../src/forge/index.js';

const MIB = 1024 * 1024;
const CAP = 8 * MIB;
const ctx: ForgeContext = {
  provider: 'github',
  apiBase: 'https://api.github.com',
  host: 'github.com',
  owner: 'acme',
  repo: 'app',
  token: 'tok',
  username: 'user',
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (err: unknown) => err,
  );

interface Watch {
  pulls: number;
  cancelled: boolean;
}

/** A body served `size` bytes per read, only when a read asks for it, so the reads can be counted. */
function streamed(bytes: Uint8Array, size: number, status = 200): { res: Response; seen: Watch } {
  const seen: Watch = { pulls: 0, cancelled: false };
  let offset = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        seen.pulls += 1;
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(offset, offset + size));
        offset += size;
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { res: new Response(body, { status }), seen };
}

/** A pull request answer of exactly `total` bytes. */
function answerOfBytes(total: number): Uint8Array {
  const bare = JSON.stringify({ number: 1, html_url: '', state: 'open', pad: '' });
  const bytes = Buffer.from(
    JSON.stringify({
      number: 1,
      html_url: '',
      state: 'open',
      pad: 'x'.repeat(total - bare.length),
    }),
  );
  expect(bytes.length).toBe(total);
  return bytes;
}

const state = () => new GithubForgeProvider().getPullRequestState(ctx, '1');

describe('the size of a forge answer', () => {
  it('caps a success body at 8 MiB', () => {
    expect(FORGE_RESPONSE_MAX_BYTES).toBe(CAP);
  });

  it.each([
    ['in one chunk', CAP],
    ['in 64 KiB chunks', 64 * 1024],
    ['in chunks that do not divide it', 100_003],
  ])('reads a body of exactly 8 MiB %s', async (_name, size) => {
    const { res, seen } = streamed(answerOfBytes(CAP), size);
    fetchMock.mockResolvedValue(res);

    expect(await state()).toEqual({ state: 'open', mergedAt: null });
    expect(seen.cancelled).toBe(false);
  });

  it.each([
    ['in one chunk', CAP + 1, 1],
    ['in 64 KiB chunks', 64 * 1024, 129],
  ])(
    'refuses a body of 8 MiB + 1 byte %s, names the cap and cancels the stream',
    async (_name, size, pulls) => {
      const { res, seen } = streamed(answerOfBytes(CAP + 1), size);
      fetchMock.mockResolvedValue(res);

      const err = await rejection(state());

      expect(err).toBeInstanceOf(ForgeError);
      expect((err as ForgeError).message).toContain(String(CAP));
      expect(seen).toEqual({ pulls, cancelled: true });
    },
  );

  it('stops reading a body of 16 MiB as soon as it is over the cap', async () => {
    const { res, seen } = streamed(Buffer.alloc(2 * CAP, 0x20), 64 * 1024);
    fetchMock.mockResolvedValue(res);

    const err = await rejection(state());

    expect(err).toBeInstanceOf(ForgeError);
    expect(seen).toEqual({ pulls: 129, cancelled: true });
  });

  it('decodes a character that a chunk boundary cuts in two', async () => {
    const url = 'https://github.com/acme/ünïcödé/pull/7';
    const { res } = streamed(Buffer.from(JSON.stringify({ number: 7, html_url: url })), 1, 201);
    fetchMock.mockResolvedValue(res);

    const opened = await new GithubForgeProvider().openPullRequest(ctx, {
      head: 'feat',
      base: 'main',
      title: 'T',
      body: 'B',
    });

    expect(opened).toEqual({ url, number: '7' });
  });
});

describe('the size of a forge error body', () => {
  const noise = Buffer.from('e'.repeat(10 * MIB));

  it('reads at most 4 KiB of it, keeps 500 characters of that, and cancels the stream', async () => {
    const { res, seen } = streamed(noise, 1024, 404);
    fetchMock.mockResolvedValue(res);

    const err = await rejection(state());

    expect(err).toBeInstanceOf(ForgeNotFoundError);
    expect((err as ForgeError).message).toContain(`${'e'.repeat(500)}…`);
    expect((err as ForgeError).message).not.toContain('e'.repeat(501));
    expect(seen).toEqual({ pulls: 5, cancelled: true });
  });

  it('stops after 4096 bytes even when the first chunk is larger', async () => {
    const { res, seen } = streamed(noise, 5 * MIB, 404);
    fetchMock.mockResolvedValue(res);

    expect(await rejection(state())).toBeInstanceOf(ForgeNotFoundError);
    expect(seen).toEqual({ pulls: 1, cancelled: true });
  });

  it('keeps the error typed by its status when the body never arrives', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    fetchMock.mockResolvedValue(new Response(body, { status: 401 }));

    const err = await rejection(state());

    expect(err).toBeInstanceOf(ForgeAuthError);
    expect((err as ForgeError).status).toBe(401);
    expect((err as ForgeError).message).not.toContain('connection reset');
  });
});

describe('a forge success body read as JSON on its own', () => {
  const KIB = 1024;

  it('parses a body of exactly the bound, however it is chunked', async () => {
    const json = JSON.stringify({ ok: true });
    const padded = Buffer.from(`${json}${' '.repeat(KIB - json.length)}`);
    const { res, seen } = streamed(padded, 100);

    expect(await readForgeJson(res, KIB)).toEqual({ ok: true });
    expect(seen.cancelled).toBe(false);
  });

  it('refuses a body one byte over the bound, names the bound and cancels the stream', async () => {
    const { res, seen } = streamed(Buffer.alloc(KIB + 1, 0x20), 256);

    const err = await rejection(readForgeJson(res, KIB));

    expect(err).toBeInstanceOf(ForgeError);
    expect((err as ForgeError).message).toBe(`response is larger than ${KIB} bytes`);
    expect(seen).toEqual({ pulls: 5, cancelled: true });
  });

  it('bounds a body at the success cap by default', async () => {
    const { res, seen } = streamed(Buffer.alloc(CAP + 1, 0x20), 64 * 1024);

    expect(await rejection(readForgeJson(res))).toBeInstanceOf(ForgeError);
    expect(seen).toEqual({ pulls: 129, cancelled: true });
  });

  it('answers a body that is not JSON with a fixed message that does not echo it', async () => {
    const { res } = streamed(Buffer.from('<html>secret-token-123</html>'), 8);

    const err = await rejection(readForgeJson(res, KIB));

    expect(err).toBeInstanceOf(ForgeError);
    expect((err as ForgeError).message).toBe('response is not JSON');
  });
});
