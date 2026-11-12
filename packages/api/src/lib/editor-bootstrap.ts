import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { canonicalOrigin, webOrigin } from './request-origin.js';

// Keep the exact bytes stable: the CSP authorizes only this fragment-consuming script.
const script = `(async () => {
  const secret = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  try {
    const response = await fetch('/ide/_handshake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ secret })
    });
    if (!response.ok) throw new Error();
    const body = await response.json();
    location.replace(body.next);
  } catch {
    document.getElementById('status').textContent = 'The editor could not be opened. Return to Haive and open it again.';
  }
})();`;
const hash = createHash('sha256').update(script).digest('base64');
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Open editor</title><body><p id="status">Opening editor…</p><script>${script}</script></body></html>`;

export function editorBootstrap(c: Context): Response {
  c.header(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'sha256-${hash}'; connect-src 'self'; frame-ancestors ${canonicalOrigin(webOrigin())}`,
  );
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
  return c.html(html);
}
