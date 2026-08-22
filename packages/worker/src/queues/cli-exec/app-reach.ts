import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { appRunnerName, ddevRunnerName, logger } from '@haive/shared';
import type { DockerVolumeMount } from '../../sandbox/docker-runner.js';
import {
  ddevCaVolumeName,
  ddevPrimaryUrl,
  runnerExec,
  runnerHandleForTask,
} from '../../sandbox/ddev-runner.js';
import { appRunnerExec, appRunnerHandleForTask } from '../../sandbox/app-runner.js';
import { containerIpOnNetwork } from '../../sandbox/runner-browser-cdp.js';
import {
  loadAppBootOutput,
  resolveDdevWorkspace,
} from '../../step-engine/steps/workflow/_task-meta.js';

const log = logger.child({ module: 'app-reach' });

/* ------------------------------------------------------------------ */
/* Can a sandboxed CLI issue an HTTP request to the task's own app?    */
/*                                                                     */
/* It could not, and nothing said so. Agents were handed the app URL   */
/* "for runtime attacks" and then found `curl` could not resolve       */
/* `*.ddev.site`, the sandbox loopback was not the DDEV host, and the  */
/* published ports were unreachable — so they fell back to reading     */
/* source. Two independent causes, both fixed elsewhere and MEASURED   */
/* here rather than assumed:                                           */
/*                                                                     */
/*  - No DNS. The runtime answers to a hostname no resolver the        */
/*    container can see knows about, hence `addHosts`.                 */
/*  - The DDEV router used to bind the runner's loopback only, so even */
/*    the right IP was refused. ddev-runner now binds all interfaces   */
/*    at cold boot — but a runner warm-recovered from before that      */
/*    change still has the old binding, which is exactly why the probe */
/*    below dials the runner's OWN sandbox-network address instead of  */
/*    trusting the config.                                             */
/*                                                                     */
/* ONE decision, TWO consumers — the same split mcp-surface.ts uses:   */
/* the dispatcher renders `mode`/`url` into the prompt at enqueue, and */
/* exec-core materializes the mounts, hosts and env at container       */
/* start. Resolved separately by each, because a runner can be         */
/* recreated (new IP) between the two.                                 */
/* ------------------------------------------------------------------ */

export type AppReachMode =
  /** The sandbox can issue plain HTTP(S) requests at `url`. */
  | 'sandbox_http'
  /** Something serves, but only the runner's own browser can reach it. */
  | 'browser_only'
  /** No runtime for this task at all. */
  | 'none';

export interface AppReach {
  mode: AppReachMode;
  /** The address that WORKS from inside the sandbox, which is not always the one the browser
   *  uses: the DDEV arm keeps the canonical `https://<name>.ddev.site` (add-host makes it
   *  resolve), while the app-runner arm must swap the host-side `http://localhost:<port>`
   *  for the container's own name on the sandbox network. Null when `mode` is 'none'. */
  url: string | null;
  /** `hostname:ip` entries for `--add-host`. */
  addHosts: string[];
  /** The shared DDEV CA, so https verifies without `-k`. Empty when the CA is not ready (the
   *  runner then serves a throwaway cert nothing here can verify) or on the plain-http arm. */
  mounts: DockerVolumeMount[];
  /** CA env for the tools an agent actually reaches for. */
  env: Record<string, string>;
  /** Hostnames the squid egress proxy must not be asked for. */
  noProxyHosts: string[];
}

/** Where the CA lands in the sandbox. `/etc/ssl/certs` already exists in the image, and a
 *  file dropped there needs no root — installing it properly with `update-ca-certificates`
 *  would, and the sandbox runs as `node`. Hence the env vars rather than the trust store. */
const SANDBOX_CA_PATH = '/etc/ssl/certs/haive-ddev-rootCA.pem';

const NO_REACH: AppReach = {
  mode: 'none',
  url: null,
  addHosts: [],
  mounts: [],
  env: {},
  noProxyHosts: [],
};

/** How the sandbox reaches this task's running app, or a 'none' reach when nothing serves.
 *
 *  Never throws: every arm degrades to a narrower mode. A wrong "you can curl this" costs an
 *  agent a wasted attempt and a confused report; a failure here costing the whole invocation
 *  would be far worse, since most steps do not need the app at all. */
export async function resolveAppReach(db: Database, taskId: string): Promise<AppReach> {
  const network = process.env.SANDBOX_NETWORK;
  // The only guard needed. resolveApiConnectNetworks attaches this network under every
  // policy except a gateway-less 'none' run, where resolveDockerNetwork makes it the sole
  // primary instead — so the NIC is there whenever the variable is set, and when it is not
  // the container has no network at all and nothing below could work.
  if (!network) return NO_REACH;

  try {
    const ddev = await resolveDdevReach(db, taskId, network);
    if (ddev) return ddev;
    return (await resolveAppRunnerReach(db, taskId, network)) ?? NO_REACH;
  } catch (err) {
    log.warn({ err, taskId }, 'app reach resolution failed; treating the app as unreachable');
    return NO_REACH;
  }
}

async function resolveDdevReach(
  db: Database,
  taskId: string,
  network: string,
): Promise<AppReach | null> {
  const repoPath = await resolveRepoPath(db, taskId);
  if (!repoPath) return null;
  const ws = await resolveDdevWorkspace(db, taskId, repoPath);
  if (!ws) return null;

  const handle = runnerHandleForTask(taskId, ws.repoSubpath);
  const primaryUrl = await ddevPrimaryUrl(handle);
  if (!primaryUrl) return null; // Not a DDEV task, or its runner is not up.

  let hostname: string;
  let port: string;
  try {
    const parsed = new URL(primaryUrl);
    hostname = parsed.hostname;
    port = parsed.port || (parsed.protocol === 'http:' ? '80' : '443');
  } catch {
    return null;
  }

  const ip = await containerIpOnNetwork(ddevRunnerName(taskId), network);
  if (!ip) return { ...NO_REACH, mode: 'browser_only', url: primaryUrl };

  const caVolume = ddevCaVolumeName();
  const reachable = await probeFromRunner(() =>
    runnerExec(
      handle,
      // --resolve, not a plain dial: the request must carry the Host header the router
      // matches on, and the ADDRESS must be the runner's external IP. Aiming at 127.0.0.1
      // would pass on a loopback-only bind, which is the failure this exists to catch.
      // -k because what is under test is the bind, not the chain; the sandbox verifies
      // properly against the mounted CA.
      `curl -sS -k -o /dev/null -w '%{http_code}' --max-time 8 --resolve ${hostname}:${port}:${ip} ${primaryUrl}`,
      { timeoutMs: 20_000 },
    ),
  );

  if (!reachable) return { ...NO_REACH, mode: 'browser_only', url: primaryUrl };

  return {
    mode: 'sandbox_http',
    url: primaryUrl,
    addHosts: [`${hostname}:${ip}`],
    // Only the cert. The volume root also holds rootCA-key.pem, and mounting it whole would
    // hand every agent the key that signs every task's certs.
    mounts: caVolume
      ? [{ source: caVolume, subpath: 'rootCA.pem', target: SANDBOX_CA_PATH, readOnly: true }]
      : [],
    env: caVolume ? { CURL_CA_BUNDLE: SANDBOX_CA_PATH, NODE_EXTRA_CA_CERTS: SANDBOX_CA_PATH } : {},
    noProxyHosts: [hostname],
  };
}

async function resolveAppRunnerReach(
  db: Database,
  taskId: string,
  network: string,
): Promise<AppReach | null> {
  const boot = await loadAppBootOutput(db, taskId);
  if (!boot?.booted || boot.skipped || boot.containerized !== true || !boot.port) return null;

  const repoPath = await resolveRepoPath(db, taskId);
  if (!repoPath) return null;
  const ws = await resolveDdevWorkspace(db, taskId, repoPath);
  if (!ws) return null;

  const container = appRunnerName(taskId);
  // The recorded appUrl is `http://localhost:<port>` — a HOST-side string, meaningless in
  // the sandbox. The container's own name resolves on the sandbox network, so no add-host is
  // needed here; the port is the in-container one, which is what that name reaches.
  const url = `http://${container}:${boot.port}`;

  const ip = await containerIpOnNetwork(container, network);
  if (!ip) return { ...NO_REACH, mode: 'browser_only', url };

  const handle = appRunnerHandleForTask(taskId, ws.repoSubpath);
  const reachable = await probeFromRunner(() =>
    // Same reasoning as the DDEV arm: dial the container's EXTERNAL address, so an app bound
    // to its own loopback is reported as browser-only rather than as reachable.
    appRunnerExec(
      handle,
      `curl -sS -o /dev/null -w '%{http_code}' --max-time 8 http://${ip}:${boot.port}/`,
      {
        timeoutMs: 20_000,
      },
    ),
  );

  return reachable
    ? { mode: 'sandbox_http', url, addHosts: [], mounts: [], env: {}, noProxyHosts: [container] }
    : { ...NO_REACH, mode: 'browser_only', url };
}

/** True when the probe produced an HTTP status of any kind.
 *
 *  ANY status counts, including a 500 or a 403: what is under test is whether a request
 *  REACHES the server, not whether the app is healthy — an app that answers 500 is one an
 *  agent can still attack. curl writes the literal `000` when it never connected, and that
 *  is the case this has to separate out. Split from the exec so it is unit-testable without
 *  a container. */
export function probeIndicatesReachable(exitCode: number, output: string): boolean {
  if (exitCode !== 0) return false;
  const status = /\b(\d{3})\b\s*$/.exec(output.trim())?.[1];
  return status !== undefined && status !== '000';
}

async function probeFromRunner(
  run: () => Promise<{ exitCode: number; output: string }>,
): Promise<boolean> {
  const res = await run().catch(() => null);
  return res !== null && probeIndicatesReachable(res.exitCode, res.output);
}

async function resolveRepoPath(db: Database, taskId: string): Promise<string | null> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { repositoryId: true },
  });
  if (!task?.repositoryId) return null;
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, task.repositoryId),
    columns: { storagePath: true, localPath: true },
  });
  return repo?.storagePath ?? repo?.localPath ?? null;
}

const APP_REACH_MARKER = '<haive_app_reach>';

/** A reach that actually has an app behind it, so `url` is a string rather than maybe-null.
 *  Narrowing here is what lets the prompt builder interpolate the URL without a fallback that
 *  would print "null" into an agent's instructions. */
type ReachableApp = AppReach & { mode: 'sandbox_http' | 'browser_only'; url: string };

export function isReachableApp(reach: AppReach): reach is ReachableApp {
  return reach.mode !== 'none' && reach.url !== null;
}

/** What the agent can actually do with the running app, stated rather than implied.
 *
 *  The old prompt line was `Running app URL (for runtime attacks): <url>` and nothing else,
 *  which asserts a capability the sandbox may not have. An agent that believes it then
 *  reaches for curl, fails, and — measured on a live run — falls back to its PROVIDER's
 *  built-in web tool, which is worse than useless: it runs on the provider's host, cannot
 *  reach a private hostname by construction, and ships the task's URLs to a third party. */
export function appReachPrompt(reach: ReachableApp): string {
  const lines: string[] = [APP_REACH_MARKER];

  if (reach.mode === 'sandbox_http') {
    lines.push(
      `The running app is at ${reach.url} and this sandbox can reach it directly — \`curl\` and`,
      'any HTTP client work, with full control of method, path, headers and body. Its TLS',
      'certificate verifies against the trust store, so no `-k` is needed; if you find yourself',
      'wanting it, something is wrong and worth reporting rather than working around.',
    );
  } else {
    lines.push(
      `The running app is at ${reach.url}, but this sandbox has NO network path to it —`,
      '`curl` will fail and that is the environment, not a finding. The browser CAN reach it:',
      'drive it with chrome-devtools and use `evaluate_script` with `fetch()` from a page on the',
      "app's own origin as your HTTP client. That gives you method, path, body and most headers,",
      'and it carries the session this task already logged in with.',
      '  `Host`, `Cookie` and `Referer` are forbidden fetch headers and cannot be set that way,',
      '  so attacks that turn on them are OUT OF SCOPE for this run — say so plainly instead of',
      '  reporting them as tested and clean.',
    );
  }

  lines.push(
    "Your own model provider's built-in web tools (web_reader, WebFetch and the like) are NOT",
    "an oracle here: they run on the provider's servers, cannot reach this task's private",
    'hostnames at all, and send its URLs to a third party. Do not fall back to them.',
    '</haive_app_reach>',
  );
  return lines.join('\n');
}

/** Prepend the block once. Marker-guarded like withMcpSurface, so nested prompt builders and
 *  retry paths applying the same reach cannot stack it.
 *
 *  A task with no runtime gets NOTHING, on the same rule withMcpSurface follows for an empty
 *  surface: the block exists to describe an app, and with no app there is no address to give
 *  and no limit worth the prompt tokens — a code-only task would carry a paragraph about
 *  something that was never on the table. The one thing worth saying there ("do not plan
 *  verification that needs to execute the app") the MCP surface block already says, from the
 *  absence of the browser and container tools that would run it. */
export function withAppReach(prompt: string, reach: AppReach | null): string {
  if (!reach || !isReachableApp(reach) || prompt.includes(APP_REACH_MARKER)) return prompt;
  return `${appReachPrompt(reach)}\n\n${prompt}`;
}
