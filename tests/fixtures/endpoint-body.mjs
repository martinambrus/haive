import { createServer } from 'node:http';

/** A throwaway endpoint: at most 512 bytes, chunked, optionally held open.
 * Tests observe real fetch cancellation while cleanup always closes every socket. */
export async function endpointBody(status, text, holdOpen = false) {
  let cancelled = false;
  let closed = false;
  let resolveClosed;
  const upstreamClosed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const server = createServer((_req, res) => {
    res.on('close', () => {
      closed = true;
      resolveClosed();
    });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.write(text.slice(0, 64));
    setImmediate(() => {
      if (res.destroyed) return;
      res.write(text.slice(64));
      if (!holdOpen) res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const fetchFn = async (input, init) => {
    const response = await fetch(input, init);
    const body = response.body;
    const cancel = body.cancel.bind(body);
    body.cancel = (...args) => {
      cancelled = true;
      return cancel(...args);
    };
    const getReader = body.getReader.bind(body);
    body.getReader = () => {
      const reader = getReader();
      const readerCancel = reader.cancel.bind(reader);
      reader.cancel = (...args) => {
        cancelled = true;
        return readerCancel(...args);
      };
      return reader;
    };
    return response;
  };
  return {
    url,
    fetchFn,
    get cancelled() {
      return cancelled;
    },
    get closed() {
      return closed;
    },
    upstreamClosed,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export const oversizedJson = (body) => JSON.stringify({ ...body, padding: 'x'.repeat(256) });
