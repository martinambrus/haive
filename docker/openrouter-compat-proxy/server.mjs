// Request-shape compatibility proxy for OpenRouter.
//
// The claude binary appends a `role:"system"` message to the END of `messages`
// (it carries the Agent tool's agent-type listing) on top of the top-level
// `system` field. OpenRouter passes Anthropic models through natively, so that is
// fine for them. For every other vendor it must translate Anthropic -> OpenAI,
// where the trailing system message keeps its position, and vLLM-style backends
// reject it outright:
//
//   400 "System message must be at the beginning."
//
// MEASURED on qwen/qwen3.8-27b: all three of its upstreams (Chutes, Io Net,
// AkashML) returned that error, so no retry or provider fallback escapes it, and
// `--disallowedTools Agent` does not stop the binary emitting the message. The
// model is otherwise perfectly usable — hoisting the message into the top-level
// `system` field makes the exact same run succeed.
//
// Hoisting is semantically equivalent (same instructions, same order relative to
// the other system content) and is a no-op for requests that carry no in-array
// system message, so this is safe to put in front of ALL OpenRouter traffic.
// Verified unchanged behaviour on anthropic/claude-haiku-4.5 and qwen/qwen3.8-max,
// both of which already worked without it.
//
// Stateless: the caller's Authorization header is forwarded untouched, so no
// secret is stored here. Only the request body of POST /v1/messages is rewritten;
// everything else (incl. the streaming SSE response) is a passthrough.

import http from 'node:http';
import https from 'node:https';
import { hoistSystemMessages } from './hoist.mjs';

const PORT = Number(process.env.PORT || 8789);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'openrouter.ai';
// OpenRouter's Anthropic endpoint lives under /api, unlike ollama.com which serves
// /v1/messages at the root. The claude binary only ever appends `/v1/messages` to
// whatever base URL it is given, so the prefix has to be re-added here — without it
// every call lands on the marketing site and comes back as 200 text/html, which the
// binary reports as "API returned an empty or malformed response".
const UPSTREAM_BASE_PATH = process.env.UPSTREAM_BASE_PATH ?? '/api';
const REWRITE_PATH = '/v1/messages';

/** Forward an inbound request to the upstream. When `bodyOverride` is set the
 *  request body has already been buffered/rewritten (Content-Length is recomputed);
 *  otherwise the inbound stream is piped straight through. The upstream response —
 *  including a streaming stream-json (SSE) body — is piped back verbatim. */
function forward(req, res, bodyOverride) {
  const headers = { ...req.headers, host: UPSTREAM_HOST };
  if (bodyOverride !== undefined) {
    headers['content-length'] = Buffer.byteLength(bodyOverride);
    delete headers['transfer-encoding'];
  }
  const upstream = https.request(
    {
      host: UPSTREAM_HOST,
      port: 443,
      method: req.method,
      path: `${UPSTREAM_BASE_PATH}${req.url}`,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ error: { type: 'proxy_error', message: String(err?.message ?? err) } }),
    );
  });
  if (bodyOverride !== undefined) upstream.end(bodyOverride);
  else req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  const path = (req.url || '').split('?')[0];
  if (req.method === 'POST' && path === REWRITE_PATH) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => forward(req, res, hoistSystemMessages(Buffer.concat(chunks))));
    req.on('error', () => {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    });
    return;
  }

  forward(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`openrouter-compat-proxy listening on :${PORT} -> https://${UPSTREAM_HOST}`);
});
