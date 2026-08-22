/** Container path where the chrome-devtools body-diversion proxy is bind-mounted, and
 *  the source of that file.
 *
 *  WHY THIS EXISTS. `--redact-network-headers` (see mcp-config.ts) closes the header
 *  half of the credential channel, but upstream redacts headers ONLY: in
 *  formatters/NetworkFormatter.js, `toJSONDetailed()` returns `requestBody` and
 *  `responseBody` verbatim, and `toStringDetailed()` renders them straight into the
 *  text content block the model reads. There is no server-side switch for it —
 *  `BODY_CONTEXT_SIZE_LIMIT` is a hard-coded 10000, and the only lever is a pair of
 *  PER-CALL tool arguments the agent supplies.
 *
 *  WHAT IT DOES. It rewrites exactly one thing: a `tools/call` for
 *  `get_network_request` that did not set `requestFilePath` / `responseFilePath` gets
 *  them filled in. Upstream then writes each body to that file and renders
 *  `Saved to <path>.` in place of the body (measured in the same renderer, the
 *  `else if (data.requestBodyFilePath)` branches). So the body stops arriving in the
 *  model's context — and in `cli_invocations` — unless an agent deliberately reads the
 *  file back.
 *
 *  WHY THE REQUEST SIDE. Redacting the RESPONSE would mean matching the rendered text
 *  (`### Request Body` headings), which is exactly the ephemeral-value trap: a reworded
 *  heading would stop redacting silently. The two parameter names are part of the tool
 *  SCHEMA, a documented contract, so this keys on the stable half.
 *
 *  WHAT IT IS NOT. Not a containment boundary. The agent can `cat` the file, and it is
 *  already authorised to see the app's data on screen. The point is narrower: a body is
 *  no longer swept into a third-party model provider's context as a side effect of
 *  asking about a request.
 *
 *  FAILURE MODE IS OPEN, ON PURPOSE. Anything that is not parseable JSON, or is not this
 *  one method, is forwarded byte-for-byte. This proxy sits in front of every browser
 *  tool call, and browser verification (08a, Gate 2, the fix loop) is worth more than
 *  the marginal redaction — so a parse it does not understand must never break the
 *  session. It is a leak reducer, not a control that may fail closed. */
export const CHROME_MCP_PROXY_PATH = '/haive/haive-chrome-mcp-proxy.mjs';

export const CHROME_MCP_PROXY_JS = String.raw`#!/usr/bin/env node
// Haive chrome-devtools MCP body-diversion proxy (auto-generated, do not edit).
// Dependency-free stdio passthrough. Spawns the real server from argv and forwards
// both directions unchanged, except that a get_network_request call with no body
// file paths gets them injected so the bodies land on disk instead of in the model's
// context. See sandbox/chrome-mcp-proxy.ts for the reasoning.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv.length === 0) {
  process.stderr.write('haive-chrome-mcp-proxy: no command given\n');
  process.exit(1);
}

const child = spawn(argv[0], argv.slice(1), {
  stdio: ['pipe', 'inherit', 'inherit'],
  env: process.env,
});

child.on('error', (err) => {
  process.stderr.write('haive-chrome-mcp-proxy: spawn failed: ' + (err && err.message) + '\n');
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});

// os.tmpdir() rather than a path in the worktree: it keeps captured bodies out of the
// repo (and out of any commit), and it is the one directory upstream allows even when
// the client negotiates no MCP roots and --allow-unrestricted-paths is absent.
const BODY_DIR = os.tmpdir();
let seq = 0;

// Upstream appends its own extension (.network-request / .network-response), so these
// are base paths. Unique per call so a later request cannot clobber an earlier body.
function bodyPath(kind) {
  seq += 1;
  return path.join(BODY_DIR, 'haive-net-' + process.pid + '-' + seq + '-' + kind);
}

function rewrite(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return line; // not JSON we understand -- forward untouched
  }
  if (!msg || msg.method !== 'tools/call') return line;
  const params = msg.params;
  if (!params || params.name !== 'get_network_request') return line;
  const args = params.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return line;
  // Never override an explicit choice by the agent.
  let changed = false;
  if (args.requestFilePath === undefined) {
    args.requestFilePath = bodyPath('request');
    changed = true;
  }
  if (args.responseFilePath === undefined) {
    args.responseFilePath = bodyPath('response');
    changed = true;
  }
  if (!changed) return line;
  try {
    return JSON.stringify(msg);
  } catch {
    return line;
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  child.stdin.write(rewrite(line) + '\n');
});
rl.on('close', () => {
  child.stdin.end();
});
`;
