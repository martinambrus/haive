import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { requireAuth } from '../middleware/auth.js';
import type { AppEnv } from '../context.js';

const CONNECT_TIMEOUT_MS = 10_000;

const tooling = new Hono<AppEnv>();
tooling.use('*', requireAuth);

/* ------------------------------------------------------------------ */
/* PostgreSQL connection test                                          */
/* ------------------------------------------------------------------ */

tooling.post('/test-postgres', async (c) => {
  const body = (await c.req.json()) as { connectionString?: string };
  const connStr = body.connectionString;
  if (!connStr || typeof connStr !== 'string') {
    return c.json({ ok: false, error: 'connectionString is required' }, 400);
  }

  try {
    const postgres = (await import('postgres')).default;
    const sql = postgres(connStr, {
      max: 1,
      connect_timeout: CONNECT_TIMEOUT_MS / 1000,
      idle_timeout: 5,
    });
    try {
      const rows = await sql`SELECT 1 AS ok`;
      const ok = Array.isArray(rows) && rows.length > 0;
      await sql.end();
      return c.json({ ok, version: null });
    } catch (err) {
      await sql.end().catch(() => {});
      return c.json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } catch (err) {
    return c.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/* ------------------------------------------------------------------ */
/* Ollama connection + model test                                      */
/* ------------------------------------------------------------------ */

tooling.post('/test-ollama', async (c) => {
  const body = (await c.req.json()) as { ollamaUrl?: string; model?: string };
  const url = body.ollamaUrl;
  if (!url || typeof url !== 'string') {
    return c.json({ ok: false, error: 'ollamaUrl is required' }, 400);
  }

  // Test connectivity
  try {
    const resp = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
    if (!resp.ok) {
      return c.json({
        ok: false,
        reachable: false,
        error: `Ollama returned HTTP ${resp.status}`,
      });
    }
    const data = (await resp.json()) as { models?: { name: string }[] };
    const models = (data.models ?? []).map((m) => m.name);

    // Check if requested model exists
    let modelFound: boolean | null = null;
    if (body.model && typeof body.model === 'string') {
      const needle = body.model;
      modelFound = models.some(
        (m) => m === needle || m === `${needle}:latest` || m.startsWith(`${needle}:`),
      );
    }

    return c.json({
      ok: true,
      reachable: true,
      modelCount: models.length,
      modelFound,
      models: models.slice(0, 50),
    });
  } catch (err) {
    return c.json({
      ok: false,
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/* ------------------------------------------------------------------ */
/* Ollama model pull (SSE streaming)                                   */
/* ------------------------------------------------------------------ */

const activePulls = new Map<string, AbortController>();

tooling.post('/pull-ollama-model', (c) => {
  const pullId = crypto.randomUUID();

  return streamSSE(c, async (stream) => {
    let body: { ollamaUrl?: string; model?: string };
    try {
      body = await c.req.json();
    } catch {
      await stream.writeSSE({
        data: JSON.stringify({ error: 'Invalid JSON body' }),
        event: 'error',
      });
      return;
    }

    const url = body.ollamaUrl;
    const model = body.model;
    if (!url || !model) {
      await stream.writeSSE({
        data: JSON.stringify({ error: 'ollamaUrl and model are required' }),
        event: 'error',
      });
      return;
    }

    const controller = new AbortController();
    activePulls.set(pullId, controller);

    await stream.writeSSE({
      data: JSON.stringify({ pullId, status: 'starting', model }),
      event: 'start',
    });

    try {
      const resp = await fetch(`${url}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        await stream.writeSSE({
          data: JSON.stringify({
            error: `Ollama returned HTTP ${resp.status}: ${text.slice(0, 200)}`,
          }),
          event: 'error',
        });
        return;
      }

      const reader = resp.body?.getReader();
      if (!reader) {
        await stream.writeSSE({
          data: JSON.stringify({ error: 'No response body from Ollama' }),
          event: 'error',
        });
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed) as {
              status?: string;
              digest?: string;
              total?: number;
              completed?: number;
              error?: string;
            };
            if (obj.error) {
              await stream.writeSSE({
                data: JSON.stringify({ error: obj.error }),
                event: 'error',
              });
              return;
            }
            await stream.writeSSE({
              data: JSON.stringify({
                status: obj.status,
                digest: obj.digest,
                total: obj.total,
                completed: obj.completed,
              }),
              event: 'progress',
            });
          } catch {
            // skip malformed lines
          }
        }
      }

      await stream.writeSSE({
        data: JSON.stringify({ status: 'success', model }),
        event: 'done',
      });
    } catch (err) {
      if (controller.signal.aborted) {
        await stream.writeSSE({
          data: JSON.stringify({ status: 'cancelled' }),
          event: 'cancelled',
        });
      } else {
        await stream.writeSSE({
          data: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          event: 'error',
        });
      }
    } finally {
      activePulls.delete(pullId);
    }
  });
});

tooling.post('/cancel-pull', async (c) => {
  const body = (await c.req.json()) as { pullId?: string };
  if (!body.pullId) {
    return c.json({ ok: false, error: 'pullId required' }, 400);
  }
  const controller = activePulls.get(body.pullId);
  if (controller) {
    controller.abort();
    activePulls.delete(body.pullId);
    return c.json({ ok: true, cancelled: true });
  }
  return c.json({ ok: true, cancelled: false });
});

export { tooling as toolingRoutes };
