import { describe, expect, it } from 'vitest';
import { browserHostname, contentSecurityPolicy } from './content-security-policy';

describe('contentSecurityPolicy', () => {
  it('admits images and media from the page, inline data, object URLs and the api only', () => {
    expect(contentSecurityPolicy('http://localhost:3001')).toBe(
      "img-src 'self' data: blob: http://localhost:3001 https://localhost:3001; " +
        "media-src 'self' blob: http://localhost:3001 https://localhost:3001; font-src 'self' data:",
    );
  });

  it('names the api host without its path, under both schemes', () => {
    expect(contentSecurityPolicy('https://example.com/api/')).toContain(
      "img-src 'self' data: blob: http://example.com https://example.com;",
    );
  });

  it('leaves the api out rather than throwing when its URL does not parse or is not http', () => {
    const none = "img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:";
    expect(contentSecurityPolicy('not a url')).toBe(none);
    expect(contentSecurityPolicy('ftp://example.com')).toBe(none);
  });
});

describe('browserHostname', () => {
  it('reads the hostname the browser asked for, IPv6 included', () => {
    expect(browserHostname('192.168.1.10:3000', 'localhost')).toBe('192.168.1.10');
    expect(browserHostname('haive.example.test', 'localhost')).toBe('haive.example.test');
    expect(browserHostname('[::1]:3000', 'localhost')).toBe('[::1]');
  });

  it('falls back when the header is missing or does not parse', () => {
    expect(browserHostname(null, 'localhost')).toBe('localhost');
    expect(browserHostname('a b', 'localhost')).toBe('localhost');
  });
});
