import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';

const server = spawn(
  process.execPath,
  [fileURLToPath(new URL('./git-http-server.mjs', import.meta.url))],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
const address = await new Promise<string>((resolve, reject) => {
  server.once('error', reject);
  server.once('exit', (code) => reject(new Error(`git HTTP fixture exited ${code}`)));
  server.stdout!.once('data', (data: Buffer) => resolve(data.toString().trim()));
});
afterAll(async () => {
  const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
  server.kill();
  await exited;
});
export function httpOrigin(dir: string): string {
  return `${address}${dir}`;
}

/** Only fixture clone/remote addresses are mapped; a production helper still validates real URLs. */
export function networkGitArgs(args: string[]): string[] {
  const out = [...args];
  let at = -1;
  if (args[0] === 'remote' && ['add', 'set-url'].includes(args[1]!)) at = 3;
  if (args[0] === 'clone') {
    for (let i = 1; i < args.length; i++) {
      if (['-b', '--branch', '--depth', '--origin', '-o'].includes(args[i]!)) {
        i++;
        continue;
      }
      if (!args[i]!.startsWith('-')) {
        at = i;
        break;
      }
    }
  }
  const arg = out[at];
  if (arg?.startsWith('file://')) out[at] = httpOrigin(arg.slice(7));
  else if (arg?.startsWith('/tmp/')) out[at] = httpOrigin(arg);
  return out;
}
