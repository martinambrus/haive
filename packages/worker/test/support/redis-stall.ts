import net from 'node:net';

export type Fake = {
  port: number;
  commands: string[][];
  mute: boolean;
  loading: boolean;
  nextCommand: (name: string) => Promise<void>;
  dropAll: () => void;
  stop: () => Promise<void>;
};

function parseCommands(buf: Buffer): { cmds: string[][]; rest: Buffer } {
  const cmds: string[][] = [];
  let pos = 0;
  for (;;) {
    if (buf[pos] !== 0x2a) break;
    let p = pos;
    const eol = buf.indexOf('\r\n', p);
    if (eol < 0) break;
    const count = Number(buf.subarray(p + 1, eol).toString());
    p = eol + 2;
    const args: string[] = [];
    let ok = true;
    for (let i = 0; i < count; i++) {
      const e = buf.indexOf('\r\n', p);
      if (e < 0) {
        ok = false;
        break;
      }
      const len = Number(buf.subarray(p + 1, e).toString());
      if (buf.length < e + 2 + len + 2) {
        ok = false;
        break;
      }
      args.push(buf.subarray(e + 2, e + 2 + len).toString());
      p = e + 2 + len + 2;
    }
    if (!ok) break;
    cmds.push(args);
    pos = p;
  }
  return { cmds, rest: buf.subarray(pos) };
}

export async function startFake(): Promise<Fake> {
  const sockets = new Set<net.Socket>();
  const waiters: Array<{ name: string; resolve: () => void }> = [];
  const fake: Fake = {
    port: 0,
    commands: [],
    mute: false,
    loading: false,
    nextCommand: (name) => new Promise((resolve) => waiters.push({ name, resolve })),
    dropAll: () => {
      for (const s of sockets) s.destroy();
    },
    stop: async () => {
      fake.dropAll();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => undefined);
    let pending: Buffer = Buffer.alloc(0);
    sock.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const { cmds, rest } = parseCommands(pending);
      pending = Buffer.from(rest);
      for (const args of cmds) {
        fake.commands.push(args);
        for (const waiter of waiters.filter((w) => w.name === args[0]!.toUpperCase())) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
        if (fake.mute) continue;
        const name = args[0]!.toUpperCase();
        if (name === 'INFO') {
          const body = `redis_version:7.0.0\r\nloading:${fake.loading ? 1 : 0}\r\n`;
          sock.write(`$${body.length}\r\n${body}\r\n`);
        } else if (name === 'EVAL') sock.write('*2\r\n:1\r\n:1\r\n');
        else if (name === 'HGETALL') sock.write('*0\r\n');
        else if (name === 'INCR' || name === 'EXPIRE') sock.write(':1\r\n');
        else if (name === 'GET') sock.write('$-1\r\n');
        else if (name === 'PING') sock.write('+PONG\r\n');
        else if (name === 'HSET' && args[1] === 'wrongkey')
          sock.write('-WRONGTYPE Operation against a key holding the wrong kind of value\r\n');
        else sock.write('+OK\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  fake.port = (server.address() as net.AddressInfo).port;
  return fake;
}

export async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
