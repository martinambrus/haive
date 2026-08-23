import { describe, expect, it } from 'vitest';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';
import {
  isTransientCliFailure,
  MCP_SERVER_FAILED_HEADLINE,
} from '../src/queues/cli-exec/failure-class.js';

const line = (o: unknown): string => JSON.stringify(o) + '\n';

/** Verbatim shape from the run that motivated this: two npx-fetched servers lost a race with
 *  a cold npm cache while both locally-mounted ones connected. */
const init = (servers: { name: string; status: string }[]) =>
  line({ type: 'system', subtype: 'init', model: 'claude-opus-4-6', mcp_servers: servers });

describe('failed MCP servers', () => {
  it('names the servers that did not start', () => {
    const c = createStreamJsonCollector();
    c.onChunk(
      init([
        { name: 'chrome-devtools', status: 'failed' },
        { name: 'filesystem', status: 'failed' },
        { name: 'haive-rag', status: 'connected' },
        { name: 'ddev-control', status: 'connected' },
      ]),
    );
    expect(c.getFailedMcpServers().sort()).toEqual(['chrome-devtools', 'filesystem']);
  });

  it('is empty when every declared server connected', () => {
    const c = createStreamJsonCollector();
    c.onChunk(init([{ name: 'haive-rag', status: 'connected' }]));
    expect(c.getFailedMcpServers()).toEqual([]);
  });

  it('is empty for a CLI whose init reports no servers at all', () => {
    // Absence is not evidence of failure — a provider that never lists them must not have
    // every one of its runs re-dispatched.
    const c = createStreamJsonCollector();
    c.onChunk(line({ type: 'system', subtype: 'init', model: 'x' }));
    expect(c.getFailedMcpServers()).toEqual([]);
  });

  it('ignores a status it has not seen rather than treating it as a fault', () => {
    // Only 'failed' is matched. A future 'pending' must not re-run the work on a guess; a
    // miss falls through to today's behaviour, which is the safe direction here.
    const c = createStreamJsonCollector();
    c.onChunk(init([{ name: 'a', status: 'pending' }]));
    expect(c.getFailedMcpServers()).toEqual([]);
  });

  it('drops a malformed entry instead of throwing', () => {
    const c = createStreamJsonCollector();
    c.onChunk(
      line({
        type: 'system',
        subtype: 'init',
        mcp_servers: [null, { status: 'failed' }, { name: '', status: 'failed' }],
      }),
    );
    expect(c.getFailedMcpServers()).toEqual([]);
  });

  it('classifies the headline as transient so the run is re-dispatched', () => {
    // The whole point: a package fetch that lost a race is warm seconds later, so re-running
    // usually just works. The orphan cap converges a persistently broken server to a failure.
    const message = `${MCP_SERVER_FAILED_HEADLINE}: chrome-devtools. The run had no access.`;
    expect(isTransientCliFailure({ exitCode: 0, errorMessage: message })).toBe(true);
  });
});
