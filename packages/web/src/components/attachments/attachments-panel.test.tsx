import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentsPanel } from './attachments-panel';
import { createRenderer, findAll, textOf, type Renderer } from '../../../test/render-tree';
import type { TaskAttachment } from '@/lib/api-client';

// No DOM in this package: the panel runs through test/render-tree.ts, and the network is a stub of fetch.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../../test/render-tree')).reactHooks,
}));
vi.mock('lucide-react', () => ({ ChevronDown: () => null, ChevronRight: () => null }));

const TASK = 'task-1';
const LIST = `GET /tasks/${TASK}/attachments`;
const UPLOAD = `POST /tasks/${TASK}/attachments`;
const FILES = 0;
const FOLDER = 1;

const reply = (code: number, body: unknown) => ({
  ok: code < 400,
  status: code,
  json: async () => structuredClone(body),
});

const sent: string[] = [];
const uploaded: string[] = [];
let failUploads: Record<string, string> = {};
let hold: { name: string; settle?: (code: number, body: unknown) => void } | null = null;
let listed: TaskAttachment[] = [];

async function fakeFetch(input: unknown, init?: { method?: string }) {
  const url = new URL(String(input), 'http://localhost');
  const call = `${init?.method ?? 'GET'} ${url.pathname}`;
  sent.push(call);
  if (call === LIST) return reply(200, { attachments: listed });
  if (call.startsWith(`DELETE /tasks/${TASK}/attachments`)) return reply(500, { error: 'locked' });
  if (call === UPLOAD) {
    const name = url.searchParams.get('filename') ?? '';
    uploaded.push(name);
    const held = hold?.name === name ? hold : null;
    if (held) {
      return new Promise((resolve) => {
        held.settle = (code, body) => resolve(reply(code, body));
      });
    }
    return Object.hasOwn(failUploads, name)
      ? reply(500, { error: failUploads[name] })
      : reply(201, { attachment: { id: name } });
  }
  return reply(404, { error: `not stubbed: ${call}` });
}

beforeAll(() => {
  vi.stubGlobal('fetch', fakeFetch);
  vi.stubGlobal('confirm', () => true);
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  sent.length = 0;
  uploaded.length = 0;
  failUploads = {};
  hold = null;
  listed = [];
});

async function mount(): Promise<Renderer> {
  const view = createRenderer(() => <AttachmentsPanel taskId={TASK} />);
  for (let i = 0; i < 3; i += 1) await view.flush();
  return view;
}

function pick(view: Renderer, picker: number, files: File[]) {
  const inputs = findAll(view.tree(), (h) => h.tag === 'input' && h.props.type === 'file');
  (inputs[picker]!.props.onChange as (e: unknown) => void)({ target: { files } });
  view.draw();
}

const inFolder = (path: string) => {
  const file = new File(['x'], path.split('/').pop()!);
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
};
const loose = (...names: string[]) => names.map((name) => new File(['x'], name));
const folder = () => ['docs/a.md', 'docs/b.md', 'docs/c.md'].map(inFolder);

const page = (view: Renderer) => textOf(view.tree());
const listings = () => sent.filter((call) => call === LIST).length;
const failedList = (view: Renderer) =>
  findAll(
    view.tree(),
    (h) => h.tag === 'ul' && h.props['aria-label'] === 'Attachments that failed to upload',
  )[0];
const failedFiles = (view: Renderer) => {
  const list = failedList(view);
  return list ? findAll(list, (h) => h.tag === 'li').map((li) => textOf(li)) : [];
};

describe('uploading from the attachments panel', () => {
  it('tries every picked file when one fails, reloads once, and names the failed file by its folder path', async () => {
    failUploads = { 'docs/b.md': 'too large' };
    const view = await mount();
    expect(listings()).toBe(1);
    pick(view, FOLDER, folder());
    await view.flush();
    expect(uploaded).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md']);
    expect(listings()).toBe(2);
    expect(failedFiles(view)).toEqual(['docs/b.md: too large']);
    expect(page(view)).toContain('1 of 3 attachment(s) could not be uploaded:');
  });

  it('keeps the message of a failed upload on screen after the list has reloaded', async () => {
    failUploads = { 'a.md': 'too large' };
    const view = await mount();
    pick(view, FILES, loose('a.md'));
    await view.flush();
    expect(listings()).toBe(2);
    expect(page(view)).toContain('too large');
    expect(failedFiles(view)).toEqual(['a.md: too large']);
  });

  it('names every file that failed with its own message, and drops them on the next pick', async () => {
    failUploads = { 'a.md': 'too large', 'c.md': 'type not allowed' };
    const view = await mount();
    pick(view, FILES, loose('a.md', 'b.md', 'c.md'));
    await view.flush();
    expect(failedFiles(view)).toEqual(['a.md: too large', 'c.md: type not allowed']);
    expect(page(view)).toContain('2 of 3 attachment(s) could not be uploaded:');
    failUploads = {};
    pick(view, FILES, loose('d.md'));
    await view.flush();
    expect(failedList(view)).toBeUndefined();
  });

  it('shows no failure list when every upload lands', async () => {
    const view = await mount();
    pick(view, FOLDER, folder());
    await view.flush();
    expect(uploaded).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md']);
    expect(listings()).toBe(2);
    expect(failedList(view)).toBeUndefined();
  });

  it('names the file being uploaded, and its place in the pick, while it uploads', async () => {
    hold = { name: 'docs/b.md' };
    const view = await mount();
    pick(view, FOLDER, folder());
    await view.flush();
    expect(page(view)).toContain('Uploading docs/b.md (2 of 3)…');
    hold.settle!(201, { attachment: { id: 'docs/b.md' } });
    await view.flush();
    expect(page(view)).not.toContain('Uploading');
    expect(uploaded).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md']);
  });
});

describe('removing from the attachments panel', () => {
  const row = (filename: string, extra: Partial<TaskAttachment> = {}): TaskAttachment => ({
    id: filename,
    taskId: TASK,
    filename,
    sizeBytes: 1,
    contentType: null,
    description: null,
    createdAt: '2026-10-17T10:00:00.000Z',
    expandedAt: null,
    expandedFromId: null,
    ...extra,
  });
  const clickButton = (view: Renderer, text: string) =>
    (
      findAll(view.tree(), (h) => h.tag === 'button' && textOf(h) === text)[0]!.props
        .onClick as () => void
    )();

  afterEach(() => vi.useRealTimers());

  it("keeps a failed delete on screen through the expansion poll's reload", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    listed = [row('a.md'), row('bundle.zip')];
    const view = await mount();
    clickButton(view, 'Remove');
    await view.flush();
    await view.flush();
    expect(page(view)).toContain('locked');
    vi.advanceTimersByTime(5000);
    for (let i = 0; i < 3; i += 1) await view.flush();
    expect(listings()).toBe(2);
    expect(page(view)).toContain('locked');
  });

  it("keeps a failed folder delete on screen through the expansion poll's reload", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    listed = [row('docs/x.md'), row('bundle.zip')];
    const view = await mount();
    clickButton(view, 'Remove folder');
    await view.flush();
    await view.flush();
    expect(page(view)).toContain('locked');
    vi.advanceTimersByTime(5000);
    for (let i = 0; i < 3; i += 1) await view.flush();
    expect(listings()).toBe(2);
    expect(page(view)).toContain('locked');
  });

  it('drops a failed delete on the next upload', async () => {
    listed = [row('a.md')];
    const view = await mount();
    clickButton(view, 'Remove');
    await view.flush();
    expect(page(view)).toContain('locked');
    pick(view, FILES, loose('b.md'));
    await view.flush();
    expect(page(view)).not.toContain('locked');
  });
});
