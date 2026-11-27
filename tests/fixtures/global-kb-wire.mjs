import net from 'node:net';
import { setImmediate } from 'node:timers/promises';
import { expect, vi } from 'vitest';
function message(tag, body) {
  const header = Buffer.alloc(5);
  header.write(tag);
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}
/** Minimal Postgres peer: authenticate, optionally answer the existence probe, then hold SQL.
 * Real TCP, fake deadline clock; never touches a running datastore. */
export async function stalledPostgres(create = false) {
  const sockets = new Set();
  const queries = [];
  const startups = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let startup = true;
    let pending = Buffer.alloc(0);
    socket.on('data', (data) => {
      pending = Buffer.concat([pending, typeof data === 'string' ? Buffer.from(data) : data]);
      for (;;) {
        const offset = startup ? 0 : 1;
        if (pending.length < offset + 4) return;
        const size = pending.readInt32BE(offset) + offset;
        if (pending.length < size) return;
        const packet = pending.subarray(0, size);
        pending = pending.subarray(size);
        if (startup) {
          startups.push(packet.toString());
          startup = false;
          socket.write(
            Buffer.concat([message('R', Buffer.alloc(4)), message('Z', Buffer.from('I'))]),
          );
        } else if (packet[0] === 81) {
          // simple Query
          const query = packet.subarray(5, -1).toString();
          queries.push(query);
          if (create && /SELECT 1 FROM pg_database/i.test(query)) {
            socket.write(
              Buffer.concat([
                message('C', Buffer.from('SELECT 0\0')),
                message('Z', Buffer.from('I')),
              ]),
            );
          }
        } else if (packet[0] === 80) {
          // Parse (Drizzle's values query)
          const query = packet.subarray(6).toString().split('\0')[0];
          queries.push(query);
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `postgres://test:test@127.0.0.1:${port}/scratch`,
    queries,
    startups,
    open: () => sockets.size,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
/** Yield only to I/O, without advancing time or sleeping. */
export async function until(condition) {
  for (let i = 0; i < 2000 && !condition(); i++) await setImmediate();
  expect(condition()).toBe(true);
}
export const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
