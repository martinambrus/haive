// The sandbox-facing boundary for the shared in-stack Ollama daemon.
// Default deny: new daemon endpoints need an explicit policy change here.
import http from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const INFERENCE_PATHS = new Set([
  '/v1/messages',
  '/v1/messages/count_tokens',
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/embeddings',
  '/api/chat',
  '/api/generate',
  '/api/embed',
  '/api/embeddings',
  '/api/show',
]);
const READ_PATHS = new Set([
  '/',
  '/api/version',
  '/api/tags',
  '/api/ps',
  '/api/hello',
  '/v1/models',
]);
const METHOD_OVERRIDE_HEADERS = ['x-http-method-override', 'x-http-method', 'x-method-override'];

/** Match the raw request target, never a decoded or normalized URL. Queries pass
 * through unchanged, but cannot change the path being authorized. */
export function isAllowed(method, rawUrl) {
  if (typeof rawUrl !== 'string') return false;
  const path = rawUrl.split('?')[0];
  if (method === 'POST') return INFERENCE_PATHS.has(path);
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (READ_PATHS.has(path)) return true;
  // A model name is one literal segment: no escapes, dot traversal, or slash.
  return /^\/v1\/models\/[^/%\\#]+$/.test(path) && !path.includes('..') && path !== '/v1/models/.';
}

function jsonError(res, status, type, message) {
  if (res.destroyed) return;
  // Once a streamed response has begun, appending JSON would corrupt it.
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { type, message } }));
}

/** Construct without listening, so tests can supply a private upstream. */
export function createGateServer({
  upstreamHost = process.env.UPSTREAM_HOST || 'ollama',
  upstreamPort = Number(process.env.UPSTREAM_PORT || 11434),
} = {}) {
  return http.createServer((req, res) => {
    if (!isAllowed(req.method, req.url)) {
      jsonError(res, 403, 'forbidden', 'This endpoint is not available.');
      req.resume();
      return;
    }
    const headers = { ...req.headers, host: `${upstreamHost}:${upstreamPort}` };
    for (const name of METHOD_OVERRIDE_HEADERS) delete headers[name];
    const upstream = http.request(
      { host: upstreamHost, port: upstreamPort, method: req.method, path: req.url, headers },
      (up) => {
        up.on('error', () => jsonError(res, 502, 'proxy_error', 'Upstream request failed.'));
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
        res.on('close', () => up.destroy());
      },
    );
    upstream.on('error', () => jsonError(res, 502, 'proxy_error', 'Upstream request failed.'));
    req.on('aborted', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  createGateServer().listen(11434, '0.0.0.0');
}
