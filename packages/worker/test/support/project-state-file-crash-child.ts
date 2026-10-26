import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const url = process.env.T266_DATABASE_URL;
const repositoryId = process.env.T266_CRASH_REPOSITORY_ID;
const repoPath = process.env.T266_CRASH_REPO_PATH;
const action = process.env.T266_FILE_ACTION ?? 'write';
const boundary = process.env.T266_FILE_BOUNDARY ?? 'park';
const leaf = process.env.T266_FILE_LEAF ?? 'render.json';
if (
  !url ||
  !repositoryId ||
  !repoPath ||
  !/^\/(?:codex|test)_t266_[a-z0-9_]+$/.test(new URL(url).pathname) ||
  ['', '5432', '6379'].includes(new URL(url).port)
)
  throw new Error('File crash child requires exclusive T266 fixture');
const stop = async (phase: string): Promise<never> => {
  await new Promise<void>((resolve) =>
    process.stdout.write(`T266_FILE_${phase}\n`, () => resolve()),
  );
  return new Promise<never>(() => {});
};
let didPark = false;
const originalRename = fs.rename;
fs.rename = async (...args: Parameters<typeof fs.rename>) => {
  await originalRename(...args);
  if (String(args[0]).endsWith(`/${leaf}`)) didPark = true;
  if (String(args[0]).endsWith(`/${leaf}`) && boundary === 'park') {
    await new Promise<void>((resolve) =>
      process.stdout.write('T266_RENDER_PARKED\n', () => resolve()),
    );
    await stop('PARKED');
  }
};
const originalLink = fs.link;
fs.link = async (...args: Parameters<typeof fs.link>) => {
  await originalLink(...args);
  if (
    String(args[1]).endsWith(`/${leaf}`) &&
    boundary === 'publish' &&
    /\.(before|after)$/.test(String(args[0]))
  )
    await stop('PUBLISHED');
  if (
    String(args[1]).endsWith(`/${leaf}`) &&
    boundary === 'restore' &&
    /\.(forward|undo)$/.test(String(args[0]))
  )
    await stop('RESTORE_LINKED');
};
const originalOpen = fs.open;
let failedRead = false;
fs.open = async (...args: Parameters<typeof fs.open>) => {
  if (
    boundary === 'restore' &&
    didPark &&
    !failedRead &&
    /\.(forward|undo)$/.test(String(args[0]))
  ) {
    failedRead = true;
    throw Object.assign(new Error('injected read EIO before exclusive restore'), { code: 'EIO' });
  }
  const fh = await originalOpen(...args);
  if (boundary === 'prepare' && String(args[0]).endsWith('/0.after')) {
    const write = fh.write.bind(fh);
    fh.write = (async (buffer: Buffer, offset: number, length: number, position: number) => {
      await write(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
      return stop('PREPARE_PARTIAL');
    }) as unknown as typeof fh.write;
  }
  return fh;
};
syncBuiltinESMExports();
const { createDatabase } = await import('@haive/database');
const { writeProjectStateColumn, recoverProjectStateWrite } =
  await import('../../src/project-state/write.js');
const db = createDatabase(url);
try {
  if (action === 'recover') await recoverProjectStateWrite(db, repositoryId, repoPath);
  else
    await writeProjectStateColumn(db, {
      repositoryId,
      repoPath,
      column: {
        projectInfo: { name: process.env.T266_FILE_NAME ?? 'file crash target' },
        framework: null,
        acceptedAgentIds: [],
        customAgentSpecs: [],
        lspLanguages: [],
        rtkChoiceRecorded: false,
      } as never,
      keepColumnOnFailure: true,
    });
} finally {
  await db.$client.end({ timeout: 5 });
}
