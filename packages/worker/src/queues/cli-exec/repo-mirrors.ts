import { lstatNoFollow, readdirNoFollow, readFileNoFollow } from '@haive/shared/fs-safe';
import type { CliCommandSpec } from '../../cli-adapters/types.js';
import { splitRepoSubpath } from '../../repo/worktree-paths.js';
import type { DockerVolumeMount } from '../../sandbox/docker-runner.js';
import type { SandboxExtraFile } from '../../sandbox/sandbox-runner.js';
import { readFrontmatterFields, yamlScalar } from '../../step-engine/steps/_yaml-scalar.js';
import { WORKER_REPO_STORAGE_ROOT } from './resolvers.js';

/** Far above any agent definition Haive writes (~4-7 KB); a file past it is skipped, not cut. */
const AGENT_FILE_MAX_BYTES = 256 * 1024;
/** A file stem that is safe as one path segment of the container target. */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface RepoMirrorResolution {
  mounts: DockerVolumeMount[];
  files: SandboxExtraFile[];
}

/**
 * The mounts and files that carry a spec's `repoMirrors` into the sandbox, taken from the same
 * tree the invocation mounts at the workdir (`repoMount.subpath`: the worktree when there is one),
 * in the shape `resolveTaskUploadsMount` uses. Existence is checked first — docker refuses to
 * start on a missing subpath — with the lookup anchored at the repository root and walked a
 * component at a time, so a directory reached through a link is skipped rather than mounted.
 */
export async function resolveRepoMirrors(
  mirrors: CliCommandSpec['repoMirrors'],
  repoMount: DockerVolumeMount | null,
  storageRoot: string = WORKER_REPO_STORAGE_ROOT,
  opts: { maskAgentDefinitions?: boolean } = {},
): Promise<RepoMirrorResolution> {
  const out: RepoMirrorResolution = { mounts: [], files: [] };
  if (!mirrors?.length || !repoMount?.subpath) return out;
  const { anchor, rel } = splitRepoSubpath(storageRoot, repoMount.subpath);
  for (const mirror of mirrors) {
    // An isolated invocation gets NO agent mirror. agy ignores the workspace `.agents/` in a
    // headless run and loads definitions from `~/.gemini/config` instead, so mirroring them there
    // hands it every persona the workspace mask hides and leaves isolation inert for that provider.
    // The skills mirror stays: skills are not what isolation withholds.
    if (opts.maskAgentDefinitions === true && mirror.layout === 'agentMdDirs') continue;
    const dirRel = rel ? `${rel}/${mirror.repoDir}` : mirror.repoDir;
    const dir = await lstatNoFollow(anchor, dirRel);
    if (dir?.kind !== 'directory') continue;
    if (mirror.layout === 'agentMdDirs') {
      out.files.push(...(await agentMdFiles(anchor, dirRel, mirror.containerDir)));
      continue;
    }
    out.mounts.push({
      source: repoMount.source,
      target: mirror.containerDir,
      subpath: `${repoMount.subpath}/${mirror.repoDir}`,
      readOnly: true,
    });
  }
  return out;
}

async function agentMdFiles(
  anchor: string,
  dirRel: string,
  containerDir: string,
): Promise<SandboxExtraFile[]> {
  const entries = await readdirNoFollow(anchor, dirRel);
  if (!entries) return [];
  const files: SandboxExtraFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const id = entry.name.slice(0, -'.md'.length);
    if (id.toLowerCase() === 'readme' || !AGENT_ID.test(id)) continue;
    const read = await readFileNoFollow(anchor, `${dirRel}/${entry.name}`, {
      maxBytes: AGENT_FILE_MAX_BYTES,
    });
    if (!read || read.truncated) continue;
    const content = agentMdForAgy(id, read.data.toString('utf8'));
    if (content) files.push({ containerPath: `${containerDir}/${id}/agent.md`, content });
  }
  return files;
}

/**
 * An agent definition in the only shape agy loads: frontmatter reduced to `name` (the file stem,
 * which is also the directory it sits in) and `description`, body unchanged. MEASURED on agy
 * 1.2.2: the same file carrying Haive's claude keys (`model: opus`, `allowed-tools`, …) was not
 * loaded. A file without a description is skipped.
 */
export function agentMdForAgy(id: string, text: string): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!frontmatter) return null;
  const description = readFrontmatterFields(frontmatter[1]!).description?.trim();
  if (!description) return null;
  const body = text.slice(frontmatter[0].length);
  return `---\nname: ${yamlScalar(id)}\ndescription: ${yamlScalar(description)}\n---\n${body}`;
}
