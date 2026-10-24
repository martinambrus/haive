import type { Duplex } from 'node:stream';
import { logger } from '@haive/shared/logger';

const log = logger.child({ module: 'upgrade-transport' });
const guarded = new WeakSet<Duplex>();

/** HTTP drops its transport error listener on upgrade, before authentication can await. */
export function guardUpgradeSocket(socket: Duplex): void {
  if (guarded.has(socket)) return;
  guarded.add(socket);
  socket.on('error', logTransportError);
}

export function logTransportError(error: NodeJS.ErrnoException): void {
  log.debug({ code: error.code }, 'upgrade transport error');
}
