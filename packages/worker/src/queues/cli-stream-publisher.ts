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
export const STREAM_TTL_SECONDS = 600;
/** Live TTL, refreshed on EVERY frame written to a stream. publishCliExit sets a TTL only on
 *  a clean/handled exit; an invocation that is superseded, or whose worker is SIGKILLed by a
 *  tsx reload, never reaches it — so without a write-time refresh the key lives forever
 *  (ttl=-1) and leaks Redis to OOM (256MB maxmemory, noeviction). This bounds every stream's
 *  lifetime to its last write + this TTL. MUST exceed the max invocation timeout — the 2h
 *  OLLAMA_CLI_TIMEOUT_MS floor (exec-core.ts) — so a live but output-silent run never has its
 *  stream expire mid-run; bump this if that config is raised past ~2h. */
export const CLI_STREAM_LIVE_TTL_SECONDS = 3 * 60 * 60; // 3h

export type StreamFrameKind = 'stdout' | 'stderr' | 'text' | 'exit' | 'steer_consumed';

export function streamKey(invocationId: string): string {
  return `${STREAM_PREFIX}${invocationId}`;
}

export async function publishCliChunk(
  invocationId: string | null | undefined,
  stream: 'stdout' | 'stderr' | 'text',
  data: string,
): Promise<void> {
  if (!invocationId || !data) return;
  try {
    // Pipeline the append with a TTL refresh (one round-trip) so a stream that stops being
    // written — orphaned by a worker SIGKILL, superseded — still expires instead of leaking.
    await getRedis()
      .multi()
      .xadd(
        streamKey(invocationId),
        'MAXLEN',
        '~',
        STREAM_MAXLEN,
        '*',
        'stream',
        stream,
        'data',
        data,
      )
      .expire(streamKey(invocationId), CLI_STREAM_LIVE_TTL_SECONDS)
      .exec();
  } catch (err) {
    log.warn({ err, invocationId }, 'publishCliChunk failed');
  }
}

/** Publish a `steer_consumed` frame: the steer with this client id has been
 *  drained by the model at a tool-call boundary. The viewer ticks the matching
 *  list row. Skipped for an empty id (legacy bare-string steer with no id —
 *  nothing the viewer could correlate it to). */
export async function publishCliSteerConsumed(
  invocationId: string | null | undefined,
  steerId: string,
): Promise<void> {
  if (!invocationId || !steerId) return;
  try {
    // Same TTL refresh as publishCliChunk: any write keeps the live stream from leaking.
    await getRedis()
      .multi()
      .xadd(
        streamKey(invocationId),
        'MAXLEN',
        '~',
        STREAM_MAXLEN,
        '*',
        'stream',
        'steer_consumed',
        'id',
        steerId,
      )
      .expire(streamKey(invocationId), CLI_STREAM_LIVE_TTL_SECONDS)
      .exec();
  } catch (err) {
    log.warn({ err, invocationId }, 'publishCliSteerConsumed failed');
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
