import { describe, expect, it } from 'vitest';
import { renderSquidConfig } from '../src/sandbox/squid-config.js';

describe('renderSquidConfig', () => {
  it('emits default port and deny-all when no allowlist', () => {
    const cfg = renderSquidConfig({ domains: [], ips: [] });
    expect(cfg).toContain('http_port 3128');
    expect(cfg).toContain('http_access deny all');
    expect(cfg).not.toContain('allowed_domains');
    expect(cfg).not.toContain('allowed_ips');
  });

  it('emits dstdomain ACL with both bare and leading-dot forms', () => {
    const cfg = renderSquidConfig({ domains: ['api.anthropic.com'], ips: [] });
    expect(cfg).toContain('acl allowed_domains dstdomain .api.anthropic.com api.anthropic.com');
    expect(cfg).toContain('http_access allow allowed_domains');
  });

  it('preserves leading-dot domains as-is without duplication', () => {
    const cfg = renderSquidConfig({ domains: ['.internal.example'], ips: [] });
    expect(cfg).toContain('acl allowed_domains dstdomain .internal.example');
    expect(cfg).not.toContain('.internal.example .internal.example');
  });

  it('emits dst ACL for IPs and CIDRs', () => {
    const cfg = renderSquidConfig({
      domains: [],
      ips: ['10.0.0.0/8', '192.168.1.42'],
    });
    expect(cfg).toContain('acl allowed_ips dst 10.0.0.0/8 192.168.1.42');
    expect(cfg).toContain('http_access allow allowed_ips');
  });

  it('rejects junk tokens silently without emitting an ACL', () => {
    const cfg = renderSquidConfig({
      domains: ['not a domain', 'good.example'],
      ips: ['garbage here', '10.0.0.1'],
    });
    expect(cfg).toContain('good.example');
    expect(cfg).toContain('10.0.0.1');
    expect(cfg).not.toContain('not a domain');
    expect(cfg).not.toContain('garbage here');
  });

  it('deduplicates and sorts entries', () => {
    const cfg = renderSquidConfig({
      domains: ['b.com', 'a.com', 'a.com'],
      ips: ['10.0.0.2', '10.0.0.1', '10.0.0.1'],
    });
    const domainLine = cfg.split('\n').find((l) => l.startsWith('acl allowed_domains'));
    expect(domainLine).toBe('acl allowed_domains dstdomain .a.com .b.com a.com b.com');
    const ipLine = cfg.split('\n').find((l) => l.startsWith('acl allowed_ips'));
    expect(ipLine).toBe('acl allowed_ips dst 10.0.0.1 10.0.0.2');
  });

  it('disables cache and lets the squid entrypoint own log routing', () => {
    // The image entrypoint tails /var/log/squid/*.log to docker stdout, so the
    // generated config must NOT redirect logs to /dev/stdout itself — that path
    // bypasses the entrypoint perm setup and squid dies with FATAL on boot.
    const cfg = renderSquidConfig({ domains: [], ips: [] });
    expect(cfg).toContain('cache deny all');
    expect(cfg).not.toContain('access_log stdio:');
    expect(cfg).not.toContain('cache_log stdio:');
  });

  it('honors custom port', () => {
    const cfg = renderSquidConfig({ domains: [], ips: [], port: 8888 });
    expect(cfg).toContain('http_port 8888');
  });

  it('translates *.example.com into the leading-dot dstdomain form', () => {
    const cfg = renderSquidConfig({ domains: ['*.example.com'], ips: [] });
    expect(cfg).toContain('acl allowed_domains dstdomain .example.com');
    expect(cfg).toContain('http_access allow allowed_domains');
    expect(cfg).not.toContain('dstdom_regex');
  });

  it('translates example.* into a dstdom_regex ACL', () => {
    const cfg = renderSquidConfig({ domains: ['example.*'], ips: [] });
    expect(cfg).toContain('acl allowed_domain_regex dstdom_regex ^example\\.[^.]+$');
    expect(cfg).toContain('http_access allow allowed_domain_regex');
    expect(cfg).not.toContain('acl allowed_domains dstdomain');
  });

  it('emits both dstdomain and dstdom_regex ACLs when both kinds are present', () => {
    const cfg = renderSquidConfig({
      domains: ['api.anthropic.com', '*.npmjs.org', 'example.*'],
      ips: [],
    });
    const dstLine = cfg.split('\n').find((l) => l.startsWith('acl allowed_domains'));
    expect(dstLine).toBe(
      'acl allowed_domains dstdomain .api.anthropic.com .npmjs.org api.anthropic.com',
    );
    const regexLine = cfg.split('\n').find((l) => l.startsWith('acl allowed_domain_regex'));
    expect(regexLine).toBe('acl allowed_domain_regex dstdom_regex ^example\\.[^.]+$');
    expect(cfg).toContain('http_access allow allowed_domains');
    expect(cfg).toContain('http_access allow allowed_domain_regex');
  });

  it('escapes dots in the prefix of a trailing-wildcard domain', () => {
    const cfg = renderSquidConfig({ domains: ['foo.bar.*'], ips: [] });
    expect(cfg).toContain('^foo\\.bar\\.[^.]+$');
  });

  it('silently drops pathological wildcard patterns', () => {
    const cfg = renderSquidConfig({
      domains: ['*', '*.*', '**.example.com', '*.example.*', '.example.*', '*..com'],
      ips: [],
    });
    expect(cfg).not.toContain('allowed_domains');
    expect(cfg).not.toContain('allowed_domain_regex');
  });

  it('does not duplicate the dstdomain form when *.example.com and example.com are both listed', () => {
    const cfg = renderSquidConfig({ domains: ['example.com', '*.example.com'], ips: [] });
    const dstLine = cfg.split('\n').find((l) => l.startsWith('acl allowed_domains'));
    expect(dstLine).toBe('acl allowed_domains dstdomain .example.com example.com');
  });
});
