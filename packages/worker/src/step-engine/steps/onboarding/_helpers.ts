import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

export async function loadPreviousStepOutput(
  db: Database,
  taskId: string,
  stepId: string,
): Promise<{ detect: unknown; output: unknown } | null> {
  const rows = await db
    .select()
    .from(schema.taskSteps)
    .where(and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepId, stepId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { detect: row.detectOutput, output: row.output };
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function countFilesMatching(
  root: string,
  predicate: (relPath: string, isDir: boolean) => boolean,
  maxDepth = 3,
): Promise<number> {
  let total = 0;
  await walk(root, '', 0, maxDepth, (rel, isDir) => {
    if (predicate(rel, isDir)) total += 1;
  });
  return total;
}

export async function listFilesMatching(
  root: string,
  predicate: (relPath: string, isDir: boolean) => boolean,
  maxDepth = 3,
): Promise<string[]> {
  const out: string[] = [];
  await walk(root, '', 0, maxDepth, (rel, isDir) => {
    if (predicate(rel, isDir)) out.push(rel);
  });
  return out;
}

type Visitor = (relPath: string, isDir: boolean) => void;

async function walk(
  root: string,
  rel: string,
  depth: number,
  maxDepth: number,
  visit: Visitor,
): Promise<void> {
  if (depth > maxDepth) return;
  const dir = path.join(root, rel);
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      visit(childRel, true);
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'vendor') {
        continue;
      }
      await walk(root, childRel, depth + 1, maxDepth, visit);
    } else if (entry.isFile()) {
      visit(childRel, false);
    }
  }
}
