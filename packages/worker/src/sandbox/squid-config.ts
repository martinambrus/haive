export interface SquidConfigInput {
  domains: string[];
  ips: string[];
  port?: number;
}

const DEFAULT_PORT = 3128;

const DOMAIN_TOKEN = /^[A-Za-z0-9.-]+$/;
const IP_TOKEN = /^[0-9a-fA-F:./]+$/;

function sanitizeDomains(input: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of input) {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) continue;
    if (!DOMAIN_TOKEN.test(trimmed)) continue;
    seen.add(trimmed);
  }
  return Array.from(seen).sort();
}

function sanitizeIps(input: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of input) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (!IP_TOKEN.test(trimmed)) continue;
    seen.add(trimmed);
  }
  return Array.from(seen).sort();
}

function expandDomainForms(domain: string): string[] {
  if (domain.startsWith('.')) return [domain];
  return [domain, `.${domain}`];
}

export function renderSquidConfig(input: SquidConfigInput): string {
  const port = input.port ?? DEFAULT_PORT;
  const domains = sanitizeDomains(input.domains);
  const ips = sanitizeIps(input.ips);
  const lines: string[] = [];

  lines.push(`http_port ${port}`);
  lines.push('');
  lines.push('acl SSL_ports port 443');
  lines.push('acl Safe_ports port 80');
  lines.push('acl Safe_ports port 443');
  lines.push('acl Safe_ports port 8080');
  lines.push('acl Safe_ports port 8443');
  lines.push('acl CONNECT method CONNECT');
  lines.push('');

  if (domains.length > 0) {
    const expanded = domains.flatMap(expandDomainForms);
    lines.push(`acl allowed_domains dstdomain ${expanded.join(' ')}`);
  }
  if (ips.length > 0) {
    lines.push(`acl allowed_ips dst ${ips.join(' ')}`);
  }
  lines.push('');

  lines.push('http_access deny !Safe_ports');
  lines.push('http_access deny CONNECT !SSL_ports');
  if (domains.length > 0) lines.push('http_access allow allowed_domains');
  if (ips.length > 0) lines.push('http_access allow allowed_ips');
  lines.push('http_access deny all');
  lines.push('');

  lines.push('cache deny all');
  lines.push('access_log stdio:/dev/stdout squid');
  lines.push('cache_log stdio:/dev/stderr');
  lines.push('pid_filename none');
  lines.push('coredump_dir /tmp');
  lines.push('');

  return lines.join('\n');
}
