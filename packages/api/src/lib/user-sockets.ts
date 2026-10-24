import type { Duplex } from 'node:stream';
import type { WebSocket } from 'ws';
import { logTransportError } from './upgrade-errors.js';

// Compose pins the api to one process, as the terminal/IDE refcount resets also require.
const users = new Map<string, Set<UpgradeSession>>();
const POLICY_CLOSE_CODE = 1008;
const CLOSE_GRACE_MS = 1_000;

/** Track before reading the user row: a revocation during auth/ownership/runtime awaits
 *  must fence that pending upgrade too, even if its database read returns an old snapshot. */
export function trackUserUpgrade(userId: string, socket: Duplex): UpgradeSession {
  let sockets = users.get(userId);
  if (!sockets) users.set(userId, (sockets = new Set()));
  const session = new UpgradeSession(socket, () => {
    sockets.delete(session);
    if (sockets.size === 0 && users.get(userId) === sockets) users.delete(userId);
  });
  if (socket.destroyed) session.dispose();
  else sockets.add(session);
  return session;
}

/** Called immediately after the session-changing database write commits. */
export function closeUserSockets(userId: string): void {
  for (const session of users.get(userId) ?? []) session.revoke();
}

export class UpgradeSession {
  revoked = false;
  private disposed = false;
  private ws: WebSocket | null = null;
  private rawUpgraded = false;
  private onRevoked: (() => void) | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly socket: Duplex,
    private readonly remove: () => void,
  ) {
    socket.once('close', this.dispose);
  }

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.socket.off('close', this.dispose);
    this.remove();
  };

  /** Call synchronously in handleUpgrade, before starting any session work. */
  accept(ws: WebSocket): boolean {
    if (this.revoked || this.socket.destroyed) return false;
    ws.on('error', logTransportError);
    this.ws = ws;
    return true;
  }

  /** The IDE relays raw bytes rather than owning a ws instance. */
  acceptRaw(): boolean {
    if (this.revoked || this.socket.destroyed) return false;
    this.rawUpgraded = true;
    return true;
  }

  onRevoke(callback: () => void): void {
    this.onRevoked = callback;
    if (this.revoked) callback();
  }

  revoke(): void {
    if (this.revoked) return;
    this.revoked = true;
    // Fence input immediately; the close handshake itself still needs to be read.
    this.ws?.removeAllListeners('message');
    this.onRevoked?.();
    if (this.socket.destroyed) return;
    if (this.socket.writableEnded) {
      this.socket.destroy();
      return;
    }
    if (this.ws) {
      this.ws.close(POLICY_CLOSE_CODE, 'session_revoked');
    } else if (this.rawUpgraded) {
      this.socket.unpipe();
      this.socket.pause();
      // Server-to-client WebSocket close frames are unmasked: FIN+CLOSE, length, status.
      const frame = Buffer.alloc(4);
      frame[0] = 0x88;
      frame[1] = 2;
      frame.writeUInt16BE(POLICY_CLOSE_CODE, 2);
      this.socket.end(frame);
    } else {
      this.socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    }
    // Bound cleanup even when a peer never acknowledges the policy close.
    this.timer = setTimeout(() => this.socket.destroy(), CLOSE_GRACE_MS).unref();
  }
}
