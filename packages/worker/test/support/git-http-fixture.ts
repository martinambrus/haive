import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** A smart HTTP server restricted to one fixture directory, with no Vitest dependency. */
export async function startGitHttpServer(base: string) {
  const server = spawn(
    process.execPath,
    [fileURLToPath(new URL('./git-http-server.mjs', import.meta.url)), base],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
  const address = await new Promise<string>((resolve, reject) => {
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`git HTTP fixture exited ${code}`)));
    server.stdout!.once('data', (data: Buffer) => resolve(data.toString().trim()));
  });
  function httpOrigin(dir: string): string {
    const rel = path.relative(base, dir);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`git HTTP fixture outside base: ${dir}`);
    }
    return `${address}/${rel.split(path.sep).map(encodeURIComponent).join('/')}`;
  }
  /** Only fixture clone/remote addresses are mapped; production helpers validate real URLs. */
  function networkGitArgs(args: string[]): string[] {
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
    if (arg?.startsWith('file://')) out[at] = httpOrigin(fileURLToPath(arg));
    else if (arg && path.isAbsolute(arg)) out[at] = httpOrigin(arg);
    return out;
  }
  return {
    httpOrigin,
    networkGitArgs,
    async close() {
      server.kill();
      await exited;
    },
  };
}
