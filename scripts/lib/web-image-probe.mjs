import { setTimeout as sleep } from 'node:timers/promises';

export const WEB_IMAGE_LIMITS = Object.freeze({
  readinessMs: 60_000,
  requestMs: 2000,
  dashboardMs: 5000,
  pollMs: 250,
});

// Keep a referenced timer alive until both headers and body have settled. An
// AbortSignal.timeout timer is unref'ed and can leave a top-level await unsettled
// when fetch has no active socket. The race also bounds a body that stops reading.
export async function fetchWebPage(url, { timeoutMs, fetchImpl = fetch }) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Request ${url} timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { redirect: 'manual', signal: controller.signal });
        const text = await response.text();
        return { status: response.status, headers: response.headers, text };
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForWebLogin(
  base,
  {
    timeoutMs = WEB_IMAGE_LIMITS.readinessMs,
    requestTimeoutMs = WEB_IMAGE_LIMITS.requestMs,
    pollMs = WEB_IMAGE_LIMITS.pollMs,
    fetchImpl = fetch,
    isRunning = () => true,
    now = () => Date.now(),
    wait = sleep,
  } = {},
) {
  const deadline = now() + timeoutMs;
  let lastError = 'no response';
  while (now() < deadline) {
    try {
      const login = await fetchWebPage(`${base}/login`, {
        timeoutMs: Math.min(requestTimeoutMs, deadline - now()),
        fetchImpl,
      });
      if (login.status === 200) return login;
      lastError = `HTTP ${login.status}`;
    } catch (error) {
      lastError = error.message;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    if (!isRunning(remaining)) {
      throw new Error(`/login not ready: container stopped; last failure: ${lastError}`);
    }
    const beforeWait = deadline - now();
    if (beforeWait <= 0) break;
    await wait(Math.min(pollMs, beforeWait));
  }
  throw new Error(`/login not ready within ${timeoutMs}ms; last failure: ${lastError}`);
}
