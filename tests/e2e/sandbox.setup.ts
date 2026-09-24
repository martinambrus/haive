import { writeFile } from 'node:fs/promises';
import { expect, test as setup } from '@playwright/test';
import { API_BASE, registerUser } from './helpers/auth.js';
import { getSql, waitForProviderImage } from './helpers/db.js';
import { warmupRecordPath } from './helpers/warmup.js';

const VERSION_BUDGET_MS = 60_000;
const BUILD_BUDGET_MS = 5 * 60_000;

// Builds the image every default claude-code provider shares, so the specs' builds are cache hits.
setup(
  'the default Claude Code sandbox image is built before the specs run',
  async ({ request }) => {
    setup.setTimeout(VERSION_BUDGET_MS + BUILD_BUDGET_MS + 60_000);
    const sql = getSql();
    try {
      // The api stamps a new provider with the refreshed CLI version, and the version is part of the
      // tag, so a provider made before the refresh answers would warm a tag no spec uses.
      const versionDeadline = Date.now() + VERSION_BUDGET_MS;
      let versionRows = 0;
      while (versionRows === 0 && Date.now() < versionDeadline) {
        const rows = await sql<{ n: number }[]>`
        select count(*)::int as n from cli_package_versions where name = 'claude-code'
      `;
        versionRows = rows[0]?.n ?? 0;
        if (versionRows === 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      if (versionRows === 0) {
        setup.info().annotations.push({
          type: 'warning',
          description:
            'the version refresh had not answered for claude-code; the warmed tag may differ',
        });
      }

      const { userId } = await registerUser(sql, request, { prefix: 'sandbox-warmup' });
      await writeFile(warmupRecordPath(setup.info()), JSON.stringify({ userId }));

      // Deleted by the teardown project, not here: once no provider references the shared tag, a
      // spec's rebuild off it deletes the image.
      const res = await request.post(`${API_BASE}/cli-providers`, {
        data: { name: 'claude-code', label: 'E2E sandbox warm-up', authMode: 'subscription' },
      });
      expect(res.status(), await res.text()).toBe(201);
      const { provider } = (await res.json()) as { provider: { id: string } };

      // Recorded rather than thrown: the specs that need the image fail on their own, and a failed
      // build must not skip the rest of the suite.
      const image = await waitForProviderImage(sql, provider.id, BUILD_BUDGET_MS);
      if (image.status !== 'ready') {
        setup.info().annotations.push({
          type: 'warning',
          description: `the warm-up image ended ${image.status ?? 'missing'}: ${image.error ?? 'no error recorded'}`,
        });
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
);
