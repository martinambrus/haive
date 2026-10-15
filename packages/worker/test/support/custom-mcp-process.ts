import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  CUSTOM_MCP_SERVER_JS,
  CUSTOM_MCP_SERVER_PATH,
  CUSTOM_MCP_TOKEN_PATH,
  CUSTOM_MCP_TOOLS_PATH,
} from '../../src/sandbox/custom-mcp-server.js';

export interface Reply {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface Started {
  child: ChildProcessWithoutNullStreams;
  ask: (method: string, params?: unknown) => Promise<Reply>;
}

export interface Seen {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: unknown;
}

const cleanups: Array<() => Promise<void>> = [];

/** Stops every process and server a test started; call it from afterEach. */
export async function runCleanups(): Promise<void> {
  for (const cleanup of cleanups.splice(0)) await cleanup();
}

/** The script is run the way the sandbox runs it: from a directory that holds its two files. */
export async function start(opts: {
  tools?: string;
  token?: string;
  apiUrl?: string;
  script?: string;
}): Promise<Started> {
  const dir = await mkdtemp(join(tmpdir(), 'haive-custom-mcp-'));
  await writeFile(join(dir, basename(CUSTOM_MCP_SERVER_PATH)), opts.script ?? CUSTOM_MCP_SERVER_JS);
  if (opts.tools !== undefined) {
    await writeFile(join(dir, basename(CUSTOM_MCP_TOOLS_PATH)), opts.tools);
  }
  if (opts.token !== undefined) {
    await writeFile(join(dir, basename(CUSTOM_MCP_TOKEN_PATH)), opts.token);
  }
  const child = spawn(process.execPath, [join(dir, basename(CUSTOM_MCP_SERVER_PATH))], {
    env: { ...process.env, ...(opts.apiUrl ? { CUSTOM_MCP_API_URL: opts.apiUrl } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const waiting = new Map<number, (reply: Reply) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const reply = JSON.parse(line) as Reply;
    waiting.get(reply.id)?.(reply);
  });
  let next = 1;
  const ask = (method: string, params: unknown = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(
        () => reject(new Error(`no answer to ${method}; exit=${child.exitCode}; stderr=${stderr}`)),
        10_000,
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
  return { child, ask };
}

/** A local stand-in for the Haive API; with `never` it reads a request and never answers it. */
export async function api(
  answer: (seen: Seen) => { status: number; body: string },
  opts: { never?: boolean } = {},
): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (opts.never) return;
      const entry: Seen = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: raw === '' ? undefined : JSON.parse(raw),
      };
      seen.push(entry);
      const { status, body } = answer(entry);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
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
  (reply.result?.content as Array<{ text: string }>)[0]!.text;
