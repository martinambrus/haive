import type { SandboxExtraFile } from './sandbox-runner.js';
import { shellQuote } from './shell-quote.js';

export interface LoopbackForward {
  port: number;
  host: string;
}

const SCRIPT_PATH = '/tmp/haive-loopback-forward.js';
const READY_PATH = '/tmp/haive-loopback-forward.ready';

/** Listens on both loopback addresses (`localhost` resolves to ::1 first) and pipes to argv host:port. */
const FORWARD_SCRIPT = `const net = require('net');
const [port, host] = process.argv.slice(2);
const bind = (addr) =>
  new Promise((done) => {
    const server = net.createServer((client) => {
      const upstream = net.connect(Number(port), host);
      const end = () => {
        client.destroy();
        upstream.destroy();
      };
      client.pipe(upstream);
      upstream.pipe(client);
      client.on('error', end);
      upstream.on('error', end);
      client.on('close', end);
      upstream.on('close', end);
    });
    server.on('error', done);
    server.listen(Number(port), addr, done);
  });
Promise.all(['127.0.0.1', '::1'].map(bind)).then(() => require('fs').writeFileSync('${READY_PATH}', ''));
`;

/** The script file and the sh prefix that starts it in the background and waits (up to about 2 s)
 *  for the bind. Without node on the image the prefix logs one line and the command runs anyway. */
export function loopbackForwardSetup(fwd: LoopbackForward): {
  file: SandboxExtraFile;
  prefix: string;
} {
  const port = String(fwd.port);
  const target = `${fwd.host}:${port}`;
  const prefix =
    `if command -v node >/dev/null 2>&1; then ` +
    `node ${SCRIPT_PATH} ${shellQuote(port)} ${shellQuote(fwd.host)} >/dev/null 2>&1 & ` +
    `i=0; while [ ! -e ${READY_PATH} ] && [ "$i" -lt 20 ]; do sleep 0.1; i=$((i+1)); done; ` +
    `else echo ${shellQuote(`haive: node is not on this image, so localhost:${port} does not reach ${target}`)} >&2; fi; `;
  return { file: { containerPath: SCRIPT_PATH, content: FORWARD_SCRIPT }, prefix };
}
