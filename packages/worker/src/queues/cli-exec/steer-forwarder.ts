import type { Redis } from 'ioredis';
import { steeringUserMessageLine } from '../../cli-adapters/steering.js';
import { log } from './_shared.js';

/** How long after the turn's `result` event to keep stdin open before closing
 *  it (which makes the CLI EOF and exit). New steers are dropped the instant the
 *  result latches; the grace only delays the physical close. */
const DEFAULT_STEER_CLOSE_GRACE_MS = 750;

export interface SteerForwarder {
  /** Pass to the spawner's `onStdinWritable`: captures the running CLI's stdin. */
  captureWritable: (writable: NodeJS.WritableStream) => void;
  /** Pass as the stream collector's `onResult`: latches the forwarder (stops
   *  forwarding immediately) then closes stdin after the grace so the CLI exits
   *  after its current turn — guaranteeing one turn per invocation. */
  onResult: () => void;
  /** Idempotent cleanup: unsubscribe + quit the dedicated subscriber and end
   *  stdin. Call in the invocation's `finally`. */
  teardown: () => void;
}

/**
 * Forwards mid-run steering messages from a dedicated Redis subscriber to a
 * steerable CLI's stdin. The caller owns the subscriber connection (a duplicated
 * ioredis client) and must `subscribe(channel)` after constructing this; the
 * forwarder only registers the message handler and the lifecycle controls.
 */
export function createSteerForwarder(opts: {
  subscriber: Redis;
  graceMs?: number;
}): SteerForwarder {
  const grace = opts.graceMs ?? DEFAULT_STEER_CLOSE_GRACE_MS;
  let writable: NodeJS.WritableStream | null = null;
  let sawResult = false;
  let torn = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  opts.subscriber.on('message', (_channel: string, raw: string) => {
    // Drop once the turn's result latched (one turn per invocation) or if stdin
    // is gone; the writable.writable check + the slice-2 stdin 'error' handler
    // make a write-after-end race a no-op rather than a worker crash (Hole C).
    if (sawResult || torn || !writable || !writable.writable || !raw) return;
    try {
      writable.write(steeringUserMessageLine(raw));
    } catch (err) {
      log.warn({ err }, 'steer stdin write failed');
    }
  });

  const teardown = (): void => {
    if (torn) return;
    torn = true;
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    void opts.subscriber.unsubscribe().catch(() => undefined);
    void opts.subscriber.quit().catch(() => undefined);
    const w = writable;
    writable = null;
    if (w && w.writable) {
      try {
        w.end();
      } catch {
        /* stdin already closed */
      }
    }
  };

  return {
    captureWritable(w: NodeJS.WritableStream): void {
      writable = w;
    },
    onResult(): void {
      if (sawResult) return;
      sawResult = true; // stop forwarding immediately
      graceTimer = setTimeout(teardown, grace); // close stdin -> CLI EOFs -> exits
    },
    teardown,
  };
}
