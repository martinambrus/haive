import { inspect } from 'node:util';
import { z } from 'zod';
import type { ApiModuleEntry } from '../../src/modules/loader.js';

export const FX_MODULE_ID = 'fx';
export const FX_PACKAGE = `@haive/module-${FX_MODULE_ID}`;
export const FX_HOST = 'docs.example.test';
export const FX_BASE = `https://${FX_HOST}`;
export const GONE_MODULE_ID = 'gone';
export const providerOf = (moduleId: string): string => `module.${moduleId}.docs`;
export const categoryOf = (moduleId: string): string => `module.${moduleId}.documents`;
export const FX_PROVIDER = providerOf(FX_MODULE_ID);
export const FX_CATEGORY = categoryOf(FX_MODULE_ID);
export const GONE_PROVIDER = providerOf(GONE_MODULE_ID);
export const GONE_CATEGORY = categoryOf(GONE_MODULE_ID);

export const READ_OPS = ['big', 'fetch_url', 'get_doc', 'leak'];
export const ALL_OPS = [...READ_OPS, 'append_doc'].sort();

export interface FixtureAccount {
  label: string | null;
  externalAccountId: string | null;
}
export interface FixtureVendorRequest {
  method: string;
  url: string;
  query?: Record<string, string>;
  json?: unknown;
  headers?: Record<string, string>;
}
export interface FixtureVendorClient {
  request(options: FixtureVendorRequest): Promise<{ status: number; body: unknown }>;
}
export interface FixtureCall<A = unknown> {
  args: A;
  vendor: FixtureVendorClient;
  signal: AbortSignal;
  account: FixtureAccount;
}
export interface FixtureExecutor {
  args: z.ZodType;
  run(call: FixtureCall<any>): Promise<unknown>;
}
export type FixtureExecutors = Record<string, Record<string, FixtureExecutor>>;

export interface RecordedCall {
  opId: string;
  call: FixtureCall;
}

/** What the executors saw. Reset it before every test. */
export const state = {
  calls: [] as RecordedCall[],
  entered: 0,
  gate: null as Promise<void> | null,
  onEntered: null as (() => void) | null,
  leakText: '',
  secrets: [] as string[],
};

export function resetFixture(): void {
  state.calls = [];
  state.entered = 0;
  state.gate = null;
  state.onEntered = null;
  state.leakText = '';
  state.secrets = [];
}

/** Holds the next get_doc run after it has started; release() lets it go. */
export function holdExecutor(): { entered: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    state.onEntered = resolve;
  });
  state.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, release };
}

function enter(opId: string, call: FixtureCall): void {
  state.entered += 1;
  state.calls.push({ opId, call });
}

const SIZED_OVERHEAD = '{"pad":""}'.length;

/** A result whose JSON text is exactly `bytes` UTF-8 bytes long; a multibyte pad is made of 3-byte characters. */
export function sizedResult(bytes: number, multibyte = false): { pad: string } {
  const room = bytes - SIZED_OVERHEAD;
  if (multibyte) {
    if (room % 3 !== 0) throw new Error(`${bytes} bytes cannot be filled with 3-byte characters`);
    return { pad: '€'.repeat(room / 3) };
  }
  return { pad: 'x'.repeat(room) };
}

const docId = z.string().min(1).max(64);

export function fxExecutors(providerId: string = FX_PROVIDER): FixtureExecutors {
  return {
    [providerId]: {
      get_doc: {
        args: z.object({ docId, view: z.enum(['summary', 'full']).default('summary') }).strict(),
        async run(call: FixtureCall<{ docId: string; view: string }>) {
          enter('get_doc', call);
          state.onEntered?.();
          if (state.gate) await state.gate;
          const res = await call.vendor.request({
            method: 'GET',
            url: `${FX_BASE}/v1/docs/${encodeURIComponent(call.args.docId)}`,
            query: { view: call.args.view },
            headers: { accept: 'application/json' },
          });
          return {
            id: call.args.docId,
            view: call.args.view,
            title: (res.body as { title?: string }).title ?? null,
            status: res.status,
          };
        },
      },
      append_doc: {
        args: z.object({ docId, text: z.string().min(1).max(2000) }).strict(),
        async run(call: FixtureCall<{ docId: string; text: string }>) {
          enter('append_doc', call);
          const res = await call.vendor.request({
            method: 'POST',
            url: `${FX_BASE}/v1/docs/${encodeURIComponent(call.args.docId)}/append`,
            json: { text: call.args.text },
          });
          const body = res.body as { appended?: boolean; length?: number };
          return {
            id: call.args.docId,
            appended: body.appended ?? false,
            length: body.length ?? 0,
          };
        },
      },
      fetch_url: {
        args: z
          .object({
            url: z.string().min(1).max(2048),
            headers: z.record(z.string(), z.string()).optional(),
          })
          .strict(),
        async run(call: FixtureCall<{ url: string; headers?: Record<string, string> }>) {
          enter('fetch_url', call);
          const res = await call.vendor.request({
            method: 'GET',
            url: call.args.url,
            ...(call.args.headers === undefined ? {} : { headers: call.args.headers }),
          });
          return { status: res.status, body: res.body };
        },
      },
      big: {
        args: z
          .object({
            bytes: z.number().int().min(SIZED_OVERHEAD).max(1_000_000).default(200_000),
            multibyte: z.boolean().default(false),
          })
          .strict(),
        async run(call: FixtureCall<{ bytes: number; multibyte: boolean }>) {
          enter('big', call);
          return sizedResult(call.args.bytes, call.args.multibyte);
        },
      },
      leak: {
        args: z.object({}).strict(),
        async run(call: FixtureCall) {
          enter('leak', call);
          const found = findInValue(call, state.secrets);
          throw new Error(
            `the vendor refused the credential ${state.leakText} (found in the call: ${found.length === 0 ? 'nothing' : found.join(' | ')})`,
          );
        },
      },
    },
  };
}

const objectSchema = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});

export const FX_OPERATIONS = [
  {
    opId: 'get_doc',
    description: 'Read a document',
    inputSchema: objectSchema(
      {
        docId: { type: 'string', minLength: 1, maxLength: 64 },
        view: { type: 'string', enum: ['summary', 'full'] },
      },
      ['docId'],
    ),
    access: 'read',
  },
  {
    opId: 'append_doc',
    description: 'Append text to a document',
    inputSchema: objectSchema(
      {
        docId: { type: 'string', minLength: 1, maxLength: 64 },
        text: { type: 'string', minLength: 1, maxLength: 2000 },
      },
      ['docId', 'text'],
    ),
    access: 'write',
  },
  {
    opId: 'fetch_url',
    description: 'Fetch a url of the document service',
    inputSchema: objectSchema(
      { url: { type: 'string', maxLength: 2048 }, headers: { type: 'object' } },
      ['url'],
    ),
    access: 'read',
  },
  {
    opId: 'big',
    description: 'Return a large result',
    inputSchema: objectSchema({ bytes: { type: 'integer' }, multibyte: { type: 'boolean' } }, []),
    access: 'read',
  },
  {
    opId: 'leak',
    description: 'Fail with a message that holds a credential',
    inputSchema: objectSchema({}, []),
    access: 'read',
  },
] as const;

export function fxManifest(moduleId: string = FX_MODULE_ID): Record<string, unknown> {
  return {
    id: moduleId,
    name: `Module ${moduleId}`,
    version: '1.0.0',
    schemaVersion: 1,
    categories: [{ id: categoryOf(moduleId), label: 'Documents' }],
    integrations: [
      {
        id: providerOf(moduleId),
        displayName: `Documents of ${moduleId}`,
        categories: [categoryOf(moduleId)],
        selfHosted: false,
        auth: [
          {
            kind: 'device',
            deviceCodeUrl: `https://login.${FX_HOST}/device/code`,
            tokenUrl: `https://login.${FX_HOST}/token`,
            scopes: { read: ['docs.read'], write: ['docs.write'] },
            userInfo: { url: `${FX_BASE}/v1/me`, idPointer: '/id', labelPointer: '/name' },
          },
        ],
        operations: FX_OPERATIONS.map((op) => ({ ...op })),
        apiHosts: [FX_HOST],
      },
    ],
  };
}

export interface EntryOptions {
  moduleId?: string;
  /** The executor map the entry carries; null leaves the field out. */
  executors?: FixtureExecutors | null;
  /** Operations of the module's provider to leave without an executor. */
  omit?: readonly string[];
}

export function fxEntry(options: EntryOptions = {}): ApiModuleEntry {
  const moduleId = options.moduleId ?? FX_MODULE_ID;
  const executors =
    options.executors === undefined ? fxExecutors(providerOf(moduleId)) : options.executors;
  if (executors !== null && options.omit !== undefined) {
    for (const ops of Object.values(executors)) for (const opId of options.omit) delete ops[opId];
  }
  return {
    packageName: `@haive/module-${moduleId}`,
    manifest: fxManifest(moduleId),
    ...(executors === null ? {} : { integrations: executors }),
  } as unknown as ApiModuleEntry;
}

/** Every place a string holding one of the needles sits in the value: own keys of every kind, accessors, prototypes,
 *  maps, sets, buffers and an inspect of the whole. Empty when the value holds none. */
export function findInValue(root: unknown, needles: readonly string[]): string[] {
  const wanted = needles.filter((needle) => needle.length > 0);
  const found: string[] = [];
  const seen = new WeakSet<object>();
  const hit = (value: string) => wanted.some((needle) => value.includes(needle));
  const plain = new Set<unknown>([
    Object.prototype,
    Function.prototype,
    Array.prototype,
    Map.prototype,
    Set.prototype,
    Promise.prototype,
    EventTarget.prototype,
    AbortSignal.prototype,
  ]);
  let budget = 50_000;

  const visit = (value: unknown, path: string, depth: number): void => {
    budget -= 1;
    if (budget < 0 || depth > 14) return;
    if (typeof value === 'string') {
      if (hit(value)) found.push(`${path}: ${value.slice(0, 80)}`);
      return;
    }
    if (typeof value === 'symbol') {
      if (value.description !== undefined && hit(value.description))
        found.push(`${path}: a symbol`);
      return;
    }
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
    if (seen.has(value)) return;
    seen.add(value);
    if (ArrayBuffer.isView(value)) {
      const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      for (const encoding of ['utf8', 'latin1', 'utf16le'] as const) {
        if (hit(bytes.toString(encoding))) found.push(`${path}: bytes (${encoding})`);
      }
      return;
    }
    if (value instanceof ArrayBuffer) {
      visit(new Uint8Array(value), path, depth + 1);
      return;
    }
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        visit(key, `${path}.<key>`, depth + 1);
        visit(entry, `${path}.<${String(key)}>`, depth + 1);
      }
    }
    if (value instanceof Set)
      for (const entry of value) visit(entry, `${path}.<member>`, depth + 1);
    if (value instanceof Headers) {
      for (const [name, entry] of value) visit(entry, `${path}.<${name}>`, depth + 1);
    }
    if (value instanceof AbortSignal) visit(value.reason, `${path}.reason`, depth + 1);
    for (const key of Reflect.ownKeys(value)) {
      const label = typeof key === 'symbol' ? `[${key.description ?? 'symbol'}]` : key;
      if (hit(label)) found.push(`${path}: a key named ${label.slice(0, 40)}`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      if ('value' in descriptor) visit(descriptor.value, `${path}.${label}`, depth + 1);
      else if (descriptor.get !== undefined) {
        try {
          visit(descriptor.get.call(value), `${path}.${label}`, depth + 1);
        } catch {
          // An accessor that throws holds nothing to read.
        }
      }
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== null && !plain.has(prototype))
      visit(prototype, `${path}.<prototype>`, depth + 1);
  };

  visit(root, '$', 0);
  const shown = inspect(root, {
    showHidden: true,
    depth: 8,
    maxStringLength: null,
    maxArrayLength: null,
    breakLength: Infinity,
    getters: true,
  });
  if (hit(shown)) found.push('$: util.inspect of the value');
  return found;
}
