import net from 'node:net';
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
  beforeResolve?: () => Promise<void>,
): Promise<{ argv: string[]; env: Record<string, string> }> {
  if ('trustedAdminModuleSource' in owner) return { argv: [], env: {} };
  const user = await owner.db.query.users.findFirst({
    where: eq(schema.users.id, owner.userId),
    columns: { role: true },
  });
  if (user?.role === 'admin') return { argv: [], env: {} };
  await beforeResolve?.();
  const addresses = new Map<string, string[]>();
  const http = new Map<string, string>();
  const ssh = new Map<string, string>();
  let anyHttp = false;
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
    if (isSsh) ssh.set(host, address[0]!);
    else {
      anyHttp = true;
      // An IP literal is the checked address already; older libcurl rejects a bracketed IPv6 host entry.
      if (net.isIP(host) === 0) {
        const authority = `${host}:${port}`;
        const pinned = address
          .map((entry) => (entry.includes(':') ? `[${entry}]` : entry))
          .join(',');
        http.set(authority, pinned);
      }
    }
  }
  const argv: string[] = [];
  for (const [authority, address] of http) {
    argv.push('-c', `http.curloptResolve=${authority}:${address}`);
  }
  if (anyHttp) argv.push('-c', 'http.followRedirects=false', '-c', 'http.proxy=');
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
  return { argv, env: {} };
}
