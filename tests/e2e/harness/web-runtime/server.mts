import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { contentSecurityPolicy } from '../../../../packages/web/src/lib/content-security-policy.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
let imageRequests = 0;
const images = createHttpServer((request, response) => {
  if (request.url === '/count') {
    response.end(String(imageRequests));
    return;
  }
  imageRequests++;
  response.setHeader('content-type', 'image/svg+xml');
  response.end('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>');
});
const vite = await createServer({
  root,
  configFile: false,
  server: {
    host: '127.0.0.1',
    port: 46112,
    strictPort: true,
    headers: { 'Content-Security-Policy': contentSecurityPolicy('http://127.0.0.1:46113') },
  },
});
await new Promise<void>((resolve, reject) => {
  images.once('error', reject);
  images.listen(46113, '127.0.0.1', resolve);
});
await vite.listen();
async function close() {
  await vite.close();
  images.closeAllConnections();
  await new Promise<void>((resolve) => images.close(() => resolve()));
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void close().then(() => process.exit(0)));
}
