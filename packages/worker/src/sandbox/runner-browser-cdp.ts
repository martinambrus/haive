import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Runner's IPv4 on the shared sandbox network, or null if not attached / not found. */
async function containerIpOnNetwork(name: string, network: string): Promise<string | null> {
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
