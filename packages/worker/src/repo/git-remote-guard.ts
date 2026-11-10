import { schema, type Database } from '@haive/database';
import { eq } from 'drizzle-orm';
import { resolveGuardedAddress } from '@haive/shared/egress';
import { parseScpLikeGitUrl, redactGitUrl } from '@haive/shared/schemas';

export type GitRemoteOwner =
  { db: Database; userId: string } | { readonly trustedAdminModuleSource: true };

function targetFor(remote: string): { host: string; port: string; ssh: boolean } {
  if (!remote.includes('://')) {
    const scp = parseScpLikeGitUrl(remote);
    if (!scp) throw new Error('invalid git remote');
    return { host: scp.host, port: '22', ssh: true };
  }
  const url = new URL(remote);
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '22'),
    ssh: url.protocol === 'ssh:',
  };
}

function shellWord(value: string): string {
  return /^[a-zA-Z0-9._:=/-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** Return per-process pins. Admin-owned remotes keep their existing transport behavior. */
export async function gitRemoteGuardArgs(
  owner: GitRemoteOwner,
  urls: readonly string[],
): Promise<string[]> {
  if ('trustedAdminModuleSource' in owner) return [];
  const user = await owner.db.query.users.findFirst({
    where: eq(schema.users.id, owner.userId),
    columns: { role: true },
  });
  if (user?.role === 'admin') return [];
  const addresses = new Map<string, string>();
  const http = new Map<string, string>();
  const httpUrls = new Map<string, string>();
  const ssh = new Map<string, string>();
  for (const remote of urls) {
    const { host, port, ssh: isSsh } = targetFor(remote);
    let address = addresses.get(host);
    if (!address) {
      try {
        address = await resolveGuardedAddress(host);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException)?.code !== 'ENOTFOUND') throw cause;
        const message = isSsh
          ? `ssh: Could not resolve hostname ${host}: Name or service not known\nfatal: Could not read from remote repository.`
          : `fatal: unable to access '${redactGitUrl(remote)}': Could not resolve host: ${host}`;
        throw Object.assign(new Error(message, { cause }), { code: 'ENOTFOUND' });
      }
      addresses.set(host, address);
    }
    if (isSsh) ssh.set(host, address);
    else {
      const authority = `${host.includes(':') ? `[${host}]` : host}:${port}`;
      const pin = `${authority}:${address.includes(':') ? `[${address}]` : address}`;
      http.set(authority, address);
      const url = new URL(remote);
      url.password = '';
      url.search = '';
      url.hash = '';
      httpUrls.set(url.href, pin);
    }
  }
  const argv: string[] = [];
  for (const [authority, address] of http) {
    argv.push(
      '-c',
      `http.curloptResolve=${authority}:${address.includes(':') ? `[${address}]` : address}`,
    );
  }
  if (http.size) argv.push('-c', 'http.followRedirects=false');
  for (const [url, pin] of httpUrls) {
    // URL-specific repository config outranks generic -c; a proxy would resolve the host again.
    argv.push(
      '-c',
      `http.${url}.curloptResolve=`,
      '-c',
      `http.${url}.curloptResolve=${pin}`,
      '-c',
      `http.${url}.followRedirects=false`,
      '-c',
      `http.${url}.proxy=`,
    );
  }
  const sshCommands = [...ssh].map(([host, address]) => ({
    host,
    command: `ssh -o ${shellWord(`HostName=${address}`)} -o ${shellWord(`HostKeyAlias=${host}`)}`,
  }));
  if (sshCommands.length === 1) argv.push('-c', `core.sshCommand=${sshCommands[0]!.command}`);
  else if (sshCommands.length > 1) {
    // A push may visit several SSH hosts. Select the pin from the host argument git appends.
    const cases = sshCommands
      .map(({ host, command }) => `${shellWord(host)}|*@${shellWord(host)}) exec ${command} "$@";;`)
      .join(' ');
    argv.push(
      '-c',
      `core.sshCommand=sh -c ${shellWord(`for arg do case "$arg" in ${cases} esac; done; exit 128`)} --`,
    );
  }
  return argv;
}
