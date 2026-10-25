/** Killed by the opt-in T266 PostgreSQL regression after files and SQL, before COMMIT. */
import { createDatabase, type Database } from '@haive/database';
import { writeProjectStateRecord } from '../../src/project-state/write.js';

const url = process.env.T266_DATABASE_URL;
const repositoryId = process.env.T266_CRASH_REPOSITORY_ID;
const repoPath = process.env.T266_CRASH_REPO_PATH;
if (
  !url ||
  !repositoryId ||
  !repoPath ||
  !/^\/(?:codex|test)_t266_[a-z0-9_]+$/.test(new URL(url).pathname) ||
  ['', '5432', '6379'].includes(new URL(url).port)
) {
  throw new Error('The crash child requires the explicitly assigned T266 fixture');
}
const database = createDatabase(url);
const wrapped = new Proxy(database, {
  get(target, prop) {
    if (prop !== 'transaction') return Reflect.get(target, prop);
    return (fn: Parameters<Database['transaction']>[0]) =>
      target.transaction(async (tx) => {
        const result = await fn(tx);
        // Preparation returns its intent. The filesystem/semantic transaction returns nothing.
        if (result === undefined) {
          process.stdout.write('T266_BEFORE_COMMIT\n');
          await new Promise<void>(() => {});
        }
        return result;
      });
  },
}) as Database;
try {
  await writeProjectStateRecord(wrapped, {
    repositoryId,
    repoPath,
    rtkChoiceRecorded: false,
    context: {
      projectInfo: { name: 'killed attempt' },
      framework: null,
      acceptedAgentIds: [],
      customAgentSpecs: [],
      lspLanguages: [],
    } as never,
  });
} finally {
  await database.$client.end({ timeout: 5 });
}
