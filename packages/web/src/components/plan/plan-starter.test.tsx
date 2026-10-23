import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanStarter } from './plan-starter';
import {
  buttons,
  createRenderer,
  findAll,
  fire,
  textOf,
  type Renderer,
} from '../../../test/render-tree';

// No DOM in this package: the starter runs through test/render-tree.ts, and the network is a stub of fetch.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../../test/render-tree')).reactHooks,
}));
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ href, children }: { href: string; children?: unknown }) =>
      createElement('a', { href }, children as never),
  };
});
vi.mock('lucide-react', () => ({ FolderUp: () => null, Paperclip: () => null, X: () => null }));

const BUSY = 'The repository is busy, try again';
const sent: string[] = [];
let startAnswers: Array<{ code: number; body: unknown }> = [];
let drafts = 0;

const reply = (code: number, body: unknown) => ({
  ok: code < 400,
  status: code,
  json: async () => structuredClone(body),
});

async function fakeFetch(input: unknown, init?: { method?: string }) {
  const url = new URL(String(input), 'http://localhost');
  const call = `${init?.method ?? 'GET'} ${url.pathname}`;
  sent.push(call);
  if (call === 'GET /cli-providers') return reply(200, { providers: [] });
  if (call.endsWith('/build/clis')) return reply(200, {});
  if (call.endsWith('/build')) {
    drafts += 1;
    return reply(200, { taskId: `draft-${drafts}`, deferred: true });
  }
  if (call.endsWith('/attachments')) return reply(201, { attachment: { id: 'a' } });
  if (call.endsWith('/action')) {
    const next = startAnswers.shift() ?? { code: 200, body: { ok: true, started: true } };
    return reply(next.code, next.body);
  }
  return reply(404, { error: `not stubbed: ${call}` });
}

beforeAll(() => vi.stubGlobal('fetch', fakeFetch));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  sent.length = 0;
  startAnswers = [];
  drafts = 0;
});

describe('PlanStarter start failure after the uploads', () => {
  it('retries the start on the same draft instead of creating a second one', async () => {
    const navigated: string[] = [];
    startAnswers = [{ code: 409, body: { error: BUSY } }];
    const view: Renderer = createRenderer(() => (
      <PlanStarter
        repositoryId="repo-1"
        onboarded
        onNavigate={(id) => navigated.push(id)}
        onCreateRoot={async () => {}}
      />
    ));
    for (let i = 0; i < 3; i += 1) await view.flush();

    const picker = findAll(view.tree(), (h) => h.tag === 'input' && h.props.type === 'file')[0]!;
    const file = new File(['x'], 'brief.md');
    (picker.props.onChange as (e: unknown) => void)({ target: { files: [file], value: '' } });
    view.draw();

    fire.click(buttons(view.tree(), 'draft a plan from this')[0]!);
    for (let i = 0; i < 4; i += 1) await view.flush();
    expect(textOf(view.tree())).toContain(BUSY);
    expect(navigated).toEqual([]);

    fire.click(buttons(view.tree(), /^(draft a plan from this|retry)/)[0]!);
    for (let i = 0; i < 4; i += 1) await view.flush();

    expect(sent.filter((c) => c.endsWith('/build'))).toHaveLength(1);
    expect(sent.filter((c) => c.endsWith('/attachments'))).toHaveLength(1);
    expect(sent.filter((c) => c.endsWith('/action'))).toEqual([
      'POST /tasks/draft-1/action',
      'POST /tasks/draft-1/action',
    ]);
    expect(navigated).toEqual(['/tasks/draft-1']);
  });
});
