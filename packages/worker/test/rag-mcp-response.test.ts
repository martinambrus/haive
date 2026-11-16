import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatRagHits, type RagSearchHit } from '@haive/shared/rag';
import { formatRagResponse, RAG_MCP_SERVER_JS } from '../src/sandbox/rag-mcp-server.js';

const hits: RagSearchHit[] = [
  {
    sourcePath: 'global_kb/cookies.md',
    sectionId: '',
    chunkIndex: 0,
    sourceType: 'kb',
    scope: 'global',
    rrf: 0.05,
    denseSim: 0.8,
    hybrid: 0,
    tsNorm: 0,
    content: '[Cookies — FULL ENTRY]\n\nSet secure cookies.',
  },
];
const note = 'Global KB unavailable; returning per-repo results only.';
const formattedHits =
  '### 1. [global] global_kb/cookies.md  (rrf=0.0500, dense=0.800)\n' +
  '[Cookies — FULL ENTRY]\n\nSet secure cookies.';
const noHits = 'No RAG hits — ground directly with grep + direct file reads.';

describe('RAG MCP response formatting', () => {
  it.each([
    { name: 'hits without a note', hits, note: undefined, expected: formattedHits },
    { name: 'note before hits', hits, note, expected: note + '\n\n' + formattedHits },
    { name: 'note before empty results', hits: [], note, expected: note + '\n\n' + noHits },
    { name: 'empty results without a note', hits: [], note: undefined, expected: noHits },
    { name: 'non-string note', hits, note: 42, expected: formattedHits },
    { name: 'empty string note', hits, note: '', expected: '\n\n' + formattedHits },
  ])('$name', ({ hits, note, expected }) => {
    expect(formatRagResponse(hits, note, 'grep + direct file reads', formatRagHits)).toBe(expected);
  });

  it('uses the available grounding tools for empty results', () => {
    expect(formatRagResponse([], note, 'LSP + grep', formatRagHits)).toBe(
      note + '\n\nNo RAG hits — ground directly with LSP + grep.',
    );
  });
});

describe('standalone RAG MCP response', () => {
  it.each(['file', 'legacy env'])(
    'returns hits using the %s credential, preferring the run-private file',
    async (delivery) => {
      const envToken = randomBytes(32).toString('hex');
      const fileToken = randomBytes(32).toString('hex');
      const directory = await mkdtemp(join(tmpdir(), 'haive-rag-proxy-'));
      const script = join(directory, 'haive-rag-mcp.mjs');
      await writeFile(script, RAG_MCP_SERVER_JS);
      if (delivery === 'file') await writeFile(join(directory, 'haive-rag.token'), fileToken);
      const requests: string[] = [];
      const server = createServer((req, res) => {
        requests.push(`${req.method} ${req.url} ${req.headers.authorization}`);
        req.resume();
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ hits, note }));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as { port: number }).port;
      const child = spawn(process.execPath, [script], {
        env: {
          ...process.env,
          RAG_API_URL: `http://127.0.0.1:${port}`,
          RAG_TASK_TOKEN: envToken,
          HAIVE_LSP_AVAILABLE: '0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      try {
        const closed = once(child, 'close');
        child.stdin.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'rag_search', arguments: { query: 'cookies' } },
          }) + '\n',
        );
        const [code] = await closed;
        expect(code, stderr).toBe(0);
        expect(requests).toEqual([
          `POST /rag/search Bearer ${delivery === 'file' ? fileToken : envToken}`,
        ]);
        expect(JSON.parse(stdout).result).toEqual({
          content: [{ type: 'text', text: note + '\n\n' + formattedHits }],
          isError: false,
        });
      } finally {
        child.kill();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
