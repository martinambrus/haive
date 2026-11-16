import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
  it.each([
    { delivery: 'file', status: 200 },
    { delivery: 'legacy env', status: 200 },
    { delivery: 'file', status: 401 },
    { delivery: 'file', status: 403 },
    { delivery: 'file', status: 500 },
    { delivery: 'legacy env', status: 401 },
    { delivery: 'unreadable file', status: 200 },
    { delivery: 'file without env', status: 401 },
    { delivery: 'file with rejected fallback', status: 401 },
  ])('handles $delivery with HTTP $status', async ({ delivery, status }) => {
    const envToken = randomBytes(32).toString('hex');
    const fileToken = randomBytes(32).toString('hex');
    const directory = await mkdtemp(join(tmpdir(), 'haive-rag-proxy-'));
    const script = join(directory, 'haive-rag-mcp.mjs');
    await writeFile(script, RAG_MCP_SERVER_JS);
    const hasFile = delivery.startsWith('file');
    if (hasFile) await writeFile(join(directory, 'haive-rag.token'), fileToken);
    if (delivery === 'unreadable file') await mkdir(join(directory, 'haive-rag.token'));
    const fallback = hasFile && status === 401 && delivery !== 'file without env';
    const succeeds = status === 200 || (fallback && delivery !== 'file with rejected fallback');
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      req.resume();
      res.statusCode = fallback && requests.length === 2 && succeeds ? 200 : status;
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
        RAG_TASK_TOKEN: delivery === 'file without env' ? '' : envToken,
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
        `POST /rag/search Bearer ${hasFile ? fileToken : envToken}`,
        ...(fallback ? [`POST /rag/search Bearer ${envToken}`] : []),
      ]);
      expect(JSON.parse(stdout).result).toEqual({
        content: [
          {
            type: 'text',
            text: succeeds
              ? note + '\n\n' + formattedHits
              : expect.stringContaining(`rag_search HTTP ${status}`),
          },
        ],
        isError: !succeeds,
      });
      if (delivery === 'unreadable file') {
        expect(stderr.trim().split('\n')).toHaveLength(1);
        expect(stderr).toContain('haive-rag: could not read invocation token file');
        expect(stderr).not.toContain(envToken);
        expect(stderr).not.toContain(fileToken);
      } else {
        expect(stderr).toBe('');
      }
    } finally {
      child.kill();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
