import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { API_URL_ENV, integrationsServerModule } from './integrations-contract.js';

export interface Reply {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface Started {
  child: ChildProcessWithoutNullStreams;
  ask: (method: string, params?: unknown, waitMs?: number) => Promise<Reply>;
  /** A line the client sends that is not a request: a notification, or noise. */
  send: (line: string) => void;
  /** Every line of stdout that was not a JSON-RPC message; the protocol channel carries nothing else. */
  noise: string[];
  stderr: () => string;
}

export interface Seen {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  raw: string;
  body: unknown;
}

export type Answer =
  { status: number; body?: string; contentType?: string } | { hang: true } | { destroy: true };

const cleanups: Array<() => Promise<void>> = [];

/** Stops every process and server a test started; call it from afterEach. */
export async function runCleanups(): Promise<void> {
  for (const cleanup of cleanups.splice(0)) await cleanup();
}

const PROXY_VARIABLES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NODE_USE_ENV_PROXY',
];

/** The script is run the way the sandbox runs it: from a directory that holds it and its token file. */
export async function start(
  opts: { token?: string; apiUrl?: string; script?: string } = {},
): Promise<Started> {
  const mod = await integrationsServerModule();
  const dir = await mkdtemp(join(tmpdir(), 'haive-integrations-mcp-'));
  const scriptFile = join(dir, basename(mod.INTEGRATIONS_MCP_SERVER_PATH));
  await writeFile(scriptFile, opts.script ?? mod.INTEGRATIONS_MCP_SERVER_JS);
  if (opts.token !== undefined) {
    await writeFile(join(dir, basename(mod.INTEGRATIONS_MCP_TOKEN_PATH)), opts.token);
  }
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of [API_URL_ENV, ...PROXY_VARIABLES]) delete env[name];
  if (opts.apiUrl !== undefined) env[API_URL_ENV] = opts.apiUrl;
  const child = spawn(process.execPath, [scriptFile], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const noise: string[] = [];
  const waiting = new Map<number, (reply: Reply) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    let reply: Reply;
    try {
      reply = JSON.parse(line) as Reply;
    } catch {
      noise.push(line);
      return;
    }
    if (typeof reply !== 'object' || reply === null) {
      noise.push(line);
      return;
    }
    waiting.get(reply.id)?.(reply);
  });
  let next = 1;
  const ask = (method: string, params: unknown = {}, waitMs = 10_000) =>
    new Promise<Reply>((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(
        () => reject(new Error(`no answer to ${method}; exit=${child.exitCode}; stderr=${stderr}`)),
        waitMs,
      );
      waiting.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  cleanups.push(async () => {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    child,
    ask,
    send: (line) => {
      child.stdin.write(`${line}\n`);
    },
    noise,
    stderr: () => stderr,
  };
}

/** A local stand-in for the broker. A request is recorded when it has arrived, whether or not it is ever answered. */
export async function broker(
  answer: (seen: Seen) => Answer,
): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body: unknown = undefined;
      if (raw !== '') {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const entry: Seen = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        raw,
        body,
      };
      seen.push(entry);
      const reply = answer(entry);
      if ('hang' in reply) return;
      if ('destroy' in reply) {
        res.socket?.destroy();
        return;
      }
      res.writeHead(reply.status, { 'content-type': reply.contentType ?? 'application/json' });
      res.end(reply.body ?? '');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= (async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    })());
  cleanups.push(close);
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close };
}

export const content = (reply: Reply): string =>
  (reply.result?.content as Array<{ type?: string; text: string }>)[0]!.text;

export const listed = (reply: Reply): unknown[] => (reply.result as { tools: unknown[] }).tools;
