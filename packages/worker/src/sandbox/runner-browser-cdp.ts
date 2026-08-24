import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Runner's IPv4 on the shared sandbox network, or null if not attached / not found. */
export async function containerIpOnNetwork(name: string, network: string): Promise<string | null> {
  try {
    const { stdout } = await exec(
      'docker',
      ['inspect', '-f', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, name],
      { timeout: 8_000 },
    );
    const ip = stdout.trim();
    return ip.length > 0 ? ip : null;
  } catch {
    return null;
  }
}

/** Resolve the CDP url a sandboxed CLI uses to drive a runner's headed browser.
 *  Returns http://<ip>:9223 once the endpoint answers, else null so the caller
 *  self-launches a headless Chrome. Uses the runner's network IP, NOT its DNS
 *  name: Chrome's DevTools HTTP handler 500s on any Host header that is not
 *  localhost or an IP literal, so a http://<dns-name>:9223 browser-url fails at
 *  /json/version. The liveness curl targets the SAME ip the agent will use, so a
 *  pass proves the agent's exact path (no Host-header false positive). */
export async function browserCdpUrlForRunner(name: string): Promise<string | null> {
  const network = process.env.SANDBOX_NETWORK;
  if (!network) return null;
  const ip = await containerIpOnNetwork(name, network);
  if (!ip) return null;
  try {
    await exec('docker', ['exec', name, 'curl', '-fsS', `http://${ip}:9223/json/version`], {
      timeout: 8_000,
    });
    return `http://${ip}:9223`;
  } catch {
    return null;
  }
}

/** Close every tab of a runner's headed browser except the human's, and report how many
 *  went. Returns null when there was nothing to do — no runner, no desktop, or the
 *  script failed — because every caller is a best-effort barrier sweep, not a step that
 *  may fail on it.
 *
 *  `scriptPath` differs per runner kind (`/opt/...` vs `/opt/browser/...`) because that
 *  is where each image installs puppeteer-core, and node resolves the dependency from
 *  the SCRIPT's directory. Passed in rather than derived here so a wrong path is a
 *  compile-time-visible argument at the call site instead of a silent no-op.
 *
 *  See docker/ddev-runner/browser-close-extra-tabs.js for why the tab that survives is
 *  the RECORDED one (neither list order nor any page-side signal is a contract; all
 *  three were measured lying) and why this is a barrier-only operation. */
export async function closeExtraBrowserTabs(
  name: string,
  scriptPath: string,
): Promise<number | null> {
  try {
    const { stdout } = await exec('docker', ['exec', name, 'node', scriptPath], {
      timeout: 30_000,
    });
    // The script prints one JSON line; anything the runtime wrote before it is noise.
    const line = stdout.trim().split('\n').pop() ?? '';
    const parsed = JSON.parse(line) as { closed?: unknown };
    return typeof parsed.closed === 'number' ? parsed.closed : null;
  } catch {
    return null;
  }
}

/** Put a runner's headed browser window back to the full desktop and report how many
 *  windows moved. Returns null when there was nothing to do — no runner, no desktop, or
 *  the script failed — because every caller wants a correctly sized window for the human,
 *  not a step that fails when a window would not move.
 *
 *  `scriptPath` differs per runner kind for the same reason closeExtraBrowserTabs's does:
 *  node resolves puppeteer-core from the SCRIPT's directory.
 *
 *  See docker/ddev-runner/browser-restore-window.js for why the shrink outlives the agent
 *  that caused it, and why the agents cannot undo it themselves. */
export async function restoreBrowserWindow(
  name: string,
  scriptPath: string,
): Promise<number | null> {
  try {
    const { stdout } = await exec('docker', ['exec', name, 'node', scriptPath], {
      timeout: 30_000,
    });
    const line = stdout.trim().split('\n').pop() ?? '';
    const parsed = JSON.parse(line) as { restored?: unknown };
    return typeof parsed.restored === 'number' ? parsed.restored : null;
  } catch {
    return null;
  }
}
