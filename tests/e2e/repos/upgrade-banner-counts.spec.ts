import type { Page } from '@playwright/test';
import { seedRepoFixture } from '../helpers/db.js';
import { expect, test } from '../helpers/fixtures.js';

// What the repository card's upgrade banner says the upgrade will do, at phone, tablet and desktop
// width: the templates it updates and the files it removes, never one "changed" count for both.
const WIDTHS = [375, 768, 1280];

interface Scenario {
  name: string;
  changed: string[];
  /** Absent from the answer, as it is from an older api. */
  obsolete?: string[];
  /** Absent from the answer, as it is from an older api. */
  retired?: string[];
  says: string;
  /** What the banner must not say, since only one of the two applies. */
  silentOn?: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'one template to update and one file to remove',
    changed: ['agent.code-reviewer', 'agent.retired'],
    obsolete: ['agent.retired'],
    says: '1 to update, 1 to remove',
  },
  {
    name: 'templates to update only',
    changed: ['agent.code-reviewer', 'command.review', 'workflow-config'],
    obsolete: [],
    says: '3 to update',
    silentOn: 'to remove',
  },
  {
    name: 'files to remove only',
    changed: ['agent.retired', 'command.retired'],
    obsolete: ['agent.retired', 'command.retired'],
    says: '2 to remove',
    silentOn: 'to update',
  },
  {
    name: 'a retired template whose file was edited, which 02 keeps or stops tracking',
    changed: ['agent.code-reviewer', 'agent.retired-edited'],
    obsolete: [],
    retired: ['agent.retired-edited'],
    says: '1 to update, 1 to keep or untrack',
    silentOn: '2 to update',
  },
  {
    name: 'templates to update, files to remove and files to keep or untrack',
    changed: ['agent.code-reviewer', 'agent.retired', 'agent.retired-edited'],
    obsolete: ['agent.retired'],
    retired: ['agent.retired', 'agent.retired-edited'],
    says: '1 to update, 1 to remove, 1 to keep or untrack',
  },
  {
    name: 'an api that does not say which are obsolete',
    changed: ['agent.code-reviewer', 'agent.retired'],
    says: '2 to update',
    silentOn: 'to remove',
  },
];

/** The api's own answer for the card with its body replaced, so its headers stay the api's. */
async function answerUpgradeStatus(
  page: Page,
  repositoryId: string,
  body: () => Record<string, unknown>,
): Promise<void> {
  await page.route(
    (url) => url.pathname === `/repositories/${repositoryId}/upgrade-status`,
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: body() });
    },
  );
}

test('the upgrade banner says what the upgrade will update and what it will remove', async ({
  page,
  sql,
  users,
}) => {
  const { userId } = await users.register(page.request, { prefix: 'banner-counts' });
  const { repoId } = await seedRepoFixture(sql, userId, 'banner-counts');
  let scenario: Scenario = SCENARIOS[0]!;
  await answerUpgradeStatus(page, repoId, () => ({
    repositoryId: repoId,
    hasUpgradeAvailable: true,
    installedTemplateSetHash: 'installed',
    currentTemplateSetHash: 'current',
    changedTemplateIds: scenario.changed,
    ...(scenario.obsolete ? { obsoleteTemplateIds: scenario.obsolete } : {}),
    ...(scenario.retired ? { retiredTemplateIds: scenario.retired } : {}),
    isOnboarded: true,
    installedHaiveVersion: null,
    currentHaiveVersion: '0.1.0',
    hasInProgressUpgradeSession: false,
    hasPriorUpgrade: false,
  }));

  for (const next of SCENARIOS) {
    scenario = next;
    for (const width of WIDTHS) {
      await test.step(`${next.name} at ${width}px`, async () => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/repos');
        const main = page.getByRole('main');
        await expect(main.getByText('Upgrade available', { exact: true })).toBeVisible();
        await expect(main.getByText(next.says, { exact: false })).toBeVisible();
        await expect(main).not.toContainText('template(s) changed');
        if (next.silentOn) await expect(main).not.toContainText(next.silentOn);
        const [scrollWidth, clientWidth] = await main.evaluate((el) => [
          el.scrollWidth,
          el.clientWidth,
        ]);
        expect(scrollWidth, 'the page does not scroll sideways').toBeLessThanOrEqual(clientWidth);
      });
    }
  }
});
