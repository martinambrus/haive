import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { formatRagHits, type RagSearchHit } from '@haive/shared/rag';
import { RAG_MCP_SERVER_JS } from '../src/sandbox/rag-mcp-server.js';

describe('standalone RAG MCP response', () => {
  it('runs the generated script and returns the same readable text as the playground', async () => {
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
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      req.resume();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ hits }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const child = spawn(process.execPath, ['--input-type=module', '-e', RAG_MCP_SERVER_JS], {
      env: {
        ...process.env,
        RAG_API_URL: `http://127.0.0.1:${port}`,
        RAG_TASK_TOKEN: 'fixture-token',
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
      expect(requests).toEqual(['POST /rag/search Bearer fixture-token']);
      expect(JSON.parse(stdout).result).toEqual({
        content: [{ type: 'text', text: formatRagHits(hits) }],
        isError: false,
      });
    } finally {
      child.kill();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
