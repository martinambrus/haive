export interface SquidConfigInput {
  domains: string[];
  ips: string[];
  port?: number;
}

const DEFAULT_PORT = 3128;

const DOMAIN_TOKEN = /^[A-Za-z0-9*.-]+$/;
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

interface DomainClassification {
  dstdomain: string[];
  dstRegex: string | null;
}

function classifyDomain(domain: string): DomainClassification {
  if (domain.startsWith('*.')) {
    const tail = domain.slice(2);
    if (!tail || tail.includes('*') || tail.startsWith('.')) {
      return { dstdomain: [], dstRegex: null };
    }
    return { dstdomain: [`.${tail}`], dstRegex: null };
  }
  if (domain.endsWith('.*')) {
    const head = domain.slice(0, -2);
    if (!head || head.includes('*') || head.startsWith('.')) {
      return { dstdomain: [], dstRegex: null };
    }
    const escaped = head.replace(/\./g, '\\.');
    return { dstdomain: [], dstRegex: `^${escaped}\\.[^.]+$` };
  }
  if (domain.includes('*')) return { dstdomain: [], dstRegex: null };
  if (domain.startsWith('.')) return { dstdomain: [domain], dstRegex: null };
  return { dstdomain: [domain, `.${domain}`], dstRegex: null };
}

export function renderSquidConfig(input: SquidConfigInput): string {
  const port = input.port ?? DEFAULT_PORT;
  const domains = sanitizeDomains(input.domains);
  const ips = sanitizeIps(input.ips);
  const lines: string[] = [];

  const dstDomainSet = new Set<string>();
  const dstRegexSet = new Set<string>();
  for (const domain of domains) {
    const classification = classifyDomain(domain);
    for (const form of classification.dstdomain) dstDomainSet.add(form);
    if (classification.dstRegex) dstRegexSet.add(classification.dstRegex);
  }
  const dstDomainList = Array.from(dstDomainSet).sort();
  const dstRegexList = Array.from(dstRegexSet).sort();

  lines.push(`http_port ${port}`);
  lines.push('');
  lines.push('acl SSL_ports port 443');
  lines.push('acl Safe_ports port 80');
  lines.push('acl Safe_ports port 443');
  lines.push('acl Safe_ports port 8080');
  lines.push('acl Safe_ports port 8443');
  lines.push('acl CONNECT method CONNECT');
  lines.push('');

  if (dstDomainList.length > 0) {
    lines.push(`acl allowed_domains dstdomain ${dstDomainList.join(' ')}`);
  }
  if (dstRegexList.length > 0) {
    lines.push(`acl allowed_domain_regex dstdom_regex ${dstRegexList.join(' ')}`);
  }
  if (ips.length > 0) {
    lines.push(`acl allowed_ips dst ${ips.join(' ')}`);
  }
  lines.push('');

  lines.push('http_access deny !Safe_ports');
  lines.push('http_access deny CONNECT !SSL_ports');
  if (dstDomainList.length > 0) lines.push('http_access allow allowed_domains');
  if (dstRegexList.length > 0) lines.push('http_access allow allowed_domain_regex');
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
