// noVNC logs `console.error("Failed when connecting: Connection closed (code: 1006)")` whenever
// its WebSocket closes abnormally (RFC 6455 code 1006) — the api gating the bridge during a
// runtime cold-boot, or the desktop VNC blipping. BrowserVncPanel handles that reconnect itself
// (it shows "Starting…" and keeps retrying, or surfaces a Retry button), so the line is benign
// churn — but the Next.js dev overlay surfaces every console.error as a page-level "Console
// Error", making a handled reconnect look like a crash.
//
// Drop ONLY that specific noVNC close log, keyed on the STABLE RFC-6455 close code `1006` plus
// noVNC's "Connection closed" text, so no other console.error is ever hidden. Fail-safe: if the
// message shape ever changes, the guard simply stops matching and the log reappears (it never
// swallows an unrelated error). Installed once and idempotent; runs in the browser only.
let installed = false;

export function suppressNovncCloseLog(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    const first = args[0];
    if (
      typeof first === 'string' &&
      first.includes('Connection closed') &&
      first.includes('1006')
    ) {
      return; // noVNC WS reconnect churn — the VNC panel already handles it
    }
    original(...args);
  };
}
