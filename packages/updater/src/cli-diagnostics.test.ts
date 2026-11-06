import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ error: new Error('unused') }));
vi.mock('./images.js', async (original) => ({
  ...(await original<typeof import('./images.js')>()),
  readImageSettings: async () => {
    throw h.error;
  },
}));

const argv = process.argv;
afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
});

it.each(['filesystem', 'bound-query'])(
  'keeps safe %s diagnostics at the actual CLI catch boundary',
  async (kind) => {
    const message = "cannot open '/private/install/.env'";
    h.error =
      kind === 'filesystem'
        ? new Error(message)
        : Object.assign(new Error('secret'), {
            query: 'SELECT $1',
            params: ['secret'],
          });
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    process.argv = ['node', fileURLToPath(new URL('./cli.ts', import.meta.url)), '--dry-plan'];
    vi.resetModules();
    await import('./cli.js');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(logs).toHaveBeenCalledWith(expect.any(String));
    const event = JSON.parse(logs.mock.calls.at(-1)![0] as string);
    expect(event).toMatchObject({
      event: 'error',
      message: kind === 'filesystem' ? message : 'Database operation failed',
    });
  },
);
