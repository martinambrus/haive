import { logger } from '@haive/shared';
import { getRedis } from '../redis.js';

const log = logger.child({ module: 'cli-stream-publisher' });

const STREAM_PREFIX = 'cli-stream:';
/** Approximate cap on per-invocation stream length; XADD MAXLEN ~ trims to
 *  the nearest "round" length for performance. ~5k entries lets a 5-minute
 *  CLI stream replay fully on tab open without ballooning Redis. */
const STREAM_MAXLEN = 5000;
/** Keep the stream around for 10 min after the invocation ends so a user
 *  who opens the Terminal tab after-the-fact still sees the final output. */
const STREAM_TTL_SECONDS = 600;

export type StreamFrameKind = 'stdout' | 'stderr' | 'exit';

export function streamKey(invocationId: string): string {
  return `${STREAM_PREFIX}${invocationId}`;
}

export async function publishCliChunk(
  invocationId: string | null | undefined,
  stream: 'stdout' | 'stderr',
  data: string,
): Promise<void> {
  if (!invocationId || !data) return;
  try {
    await getRedis().xadd(
      streamKey(invocationId),
      'MAXLEN',
      '~',
      STREAM_MAXLEN,
      '*',
      'stream',
      stream,
      'data',
      data,
    );
  } catch (err) {
    log.warn({ err, invocationId }, 'publishCliChunk failed');
  }
}

export async function publishCliExit(
  invocationId: string | null | undefined,
  code: number | null,
): Promise<void> {
  if (!invocationId) return;
  try {
    const r = getRedis();
    await r.xadd(streamKey(invocationId), '*', 'stream', 'exit', 'code', String(code ?? -1));
    await r.expire(streamKey(invocationId), STREAM_TTL_SECONDS);
  } catch (err) {
    log.warn({ err, invocationId }, 'publishCliExit failed');
  }
}

/** Wraps a chunk callback so each chunk is also published to the
 *  invocation's Redis stream. When invocationId is null the original
 *  callback runs unmodified — used for one-off spawners (auth-status,
 *  version-refresh) that don't have an invocation row. */
export function wrapStreamCallback(
  invocationId: string | null | undefined,
  stream: 'stdout' | 'stderr',
  original?: (chunk: string) => void,
): ((chunk: string) => void) | undefined {
  if (!invocationId) return original;
  return (chunk: string) => {
    if (original) {
      try {
        original(chunk);
      } catch (err) {
        log.warn({ err, invocationId, stream }, 'inner chunk callback threw');
      }
    }
    void publishCliChunk(invocationId, stream, chunk);
  };
}
