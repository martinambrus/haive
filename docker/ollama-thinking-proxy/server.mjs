// Thinking-disable proxy for Ollama Cloud reasoning models.
//
// Some Ollama Cloud reasoning models (e.g. deepseek-v4-pro:cloud), reached through
// Ollama's Anthropic-compatible /v1/messages endpoint, route their entire answer
// into the `thinking` channel and return result="" — a visible empty response.
// Injecting thinking:{type:"disabled"} into the request makes them answer with
// visible text. The claude binary that drives these calls never sets that field,
// so this proxy injects it: the worker points a provider's ANTHROPIC_BASE_URL here
// (gated by the per-provider "Disable model thinking" toggle), and we forward to
// ollama.com with the field added.
//
// Stateless: the caller's Authorization header is forwarded untouched, so no
// secret is stored here. Only the request body of POST /v1/messages is rewritten;
// everything else (incl. the streaming SSE response) is a passthrough.

import http from 'node:http';
import https from 'node:https';

const PORT = Number(process.env.PORT || 8788);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'ollama.com';
const INJECT_PATH = '/v1/messages';

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
    { host: UPSTREAM_HOST, port: 443, method: req.method, path: req.url, headers },
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

/** Add thinking:{type:"disabled"} to a /v1/messages JSON body. Returns the raw
 *  bytes unchanged if the body is not parseable JSON (forward as-is, never break
 *  the request). Exported shape kept simple for unit testing. */
export function injectThinkingDisabled(rawBody) {
  try {
    const body = JSON.parse(rawBody.toString('utf8'));
    body.thinking = { type: 'disabled' };
    return Buffer.from(JSON.stringify(body));
  } catch {
    return rawBody;
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  const path = (req.url || '').split('?')[0];
  if (req.method === 'POST' && path === INJECT_PATH) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => forward(req, res, injectThinkingDisabled(Buffer.concat(chunks))));
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
  console.log(`ollama-thinking-proxy listening on :${PORT} -> https://${UPSTREAM_HOST}`);
});
