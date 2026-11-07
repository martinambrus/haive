import net from 'node:net';
import { CONFIG_KEYS, configService } from '../config/index.js';

export const MAX_ALLOWLIST_ENTRIES = 256;
export const MAX_ALLOWLIST_BYTES = 16 * 1024;

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DIGITS = /^\d+$/;

export interface ParsedAllowlist {
  /** Lower-case hostnames, without a trailing dot. */
  hosts: ReadonlySet<string>;
  /** True when an IP or CIDR entry covers the address. */
  matches(address: string): boolean;
  /** The entries that were skipped as malformed. */
  invalid: readonly string[];
}

export type AllowlistValidation =
  { ok: true; entries: number } | { ok: false; entry: string; reason: string };

export const EMPTY: ParsedAllowlist = {
  hosts: new Set<string>(),
  matches: () => false,
  invalid: [],
};

type Entry =
  | { kind: 'ip'; address: string; family: 'ipv4' | 'ipv6' }
  | { kind: 'cidr'; address: string; prefix: number; family: 'ipv4' | 'ipv6' }
  | { kind: 'host'; name: string };

function stripBrackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function parseEntry(entry: string): Entry | { error: string } {
  const slash = entry.indexOf('/');
  if (slash !== -1) {
    const address = stripBrackets(entry.slice(0, slash));
    const prefixText = entry.slice(slash + 1);
    const family = net.isIP(address);
    if (family === 0) return { error: 'not an IP address before the prefix' };
    if (!DIGITS.test(prefixText)) return { error: 'prefix is not a number' };
    const prefix = Number(prefixText);
    const max = family === 4 ? 32 : 128;
    if (prefix < 1 || prefix > max) return { error: `prefix must be 1-${max}` };
    return { kind: 'cidr', address, prefix, family: family === 4 ? 'ipv4' : 'ipv6' };
  }
  const bare = stripBrackets(entry);
  const family = net.isIP(bare);
  if (family !== 0) return { kind: 'ip', address: bare, family: family === 4 ? 'ipv4' : 'ipv6' };
  const name = (entry.endsWith('.') ? entry.slice(0, -1) : entry).toLowerCase();
  if (name.length === 0 || name.length > 253) return { error: 'not a valid hostname' };
  const labels = name.split('.');
  if (!labels.every((label) => HOST_LABEL.test(label))) return { error: 'not a valid hostname' };
  if (labels.every((label) => DIGITS.test(label))) return { error: 'not a valid hostname' };
  return { kind: 'host', name };
}

function tokens(raw: string): { entries: string[]; overBytes: boolean; overCount: boolean } {
  let text = raw;
  let overBytes = false;
  if (Buffer.byteLength(text) > MAX_ALLOWLIST_BYTES) {
    overBytes = true;
    const cut = Buffer.from(text).subarray(0, MAX_ALLOWLIST_BYTES).toString();
    const last = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(','));
    text = last === -1 ? '' : cut.slice(0, last);
  }
  const all = text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return {
    entries: all.slice(0, MAX_ALLOWLIST_ENTRIES),
    overBytes,
    overCount: all.length > MAX_ALLOWLIST_ENTRIES,
  };
}

let memo: { raw: string; parsed: ParsedAllowlist } | undefined;

export function parseAllowlist(raw: string | null | undefined): ParsedAllowlist {
  if (raw === null || raw === undefined || raw.trim() === '') return EMPTY;
  if (memo?.raw === raw) return memo.parsed;
  const hosts = new Set<string>();
  const invalid: string[] = [];
  const list = new net.BlockList();
  for (const entry of tokens(raw).entries) {
    const parsed = parseEntry(entry);
    if ('error' in parsed) invalid.push(entry);
    else if (parsed.kind === 'host') hosts.add(parsed.name);
    else if (parsed.kind === 'ip') list.addAddress(parsed.address, parsed.family);
    else list.addSubnet(parsed.address, parsed.prefix, parsed.family);
  }
  const result: ParsedAllowlist = {
    hosts,
    matches: (address) => {
      const family = net.isIP(address);
      return family !== 0 && list.check(address, family === 4 ? 'ipv4' : 'ipv6');
    },
    invalid,
  };
  memo = { raw, parsed: result };
  return result;
}

export function validateAllowlist(raw: string | null | undefined): AllowlistValidation {
  const text = raw ?? '';
  if (Buffer.byteLength(text) > MAX_ALLOWLIST_BYTES) {
    return { ok: false, entry: '', reason: `the list exceeds ${MAX_ALLOWLIST_BYTES} bytes` };
  }
  const { entries, overCount } = tokens(text);
  if (overCount) {
    return {
      ok: false,
      entry: '',
      reason: `the list has more than ${MAX_ALLOWLIST_ENTRIES} entries`,
    };
  }
  for (const entry of entries) {
    const parsed = parseEntry(entry);
    if ('error' in parsed) return { ok: false, entry, reason: parsed.error };
  }
  return { ok: true, entries: entries.length };
}

/** Throws what the config read throws; the guard decides what an unreadable list means. */
export async function loadAllowlist(): Promise<ParsedAllowlist> {
  return parseAllowlist(await configService.get(CONFIG_KEYS.PRIVATE_ENDPOINT_ALLOWLIST));
}
