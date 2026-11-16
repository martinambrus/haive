import type { CliCommandSpec } from '../cli-adapters/types.js';
import { defaultDockerRunner, type DockerRunner } from './docker-runner.js';
import { ensureSandboxCoreImage } from './sandbox-core-image.js';
import { SANDBOX_CORE_IMAGE } from './image-composer.js';
import { IMMUTABLE_IMAGE_ID, type SandboxToolchainFact } from './toolchain-probe.js';

export const SANDBOX_TOOLCHAIN_MARKER = '<haive_sandbox_toolchain>';
const CLOSE = '</haive_sandbox_toolchain>';
export interface SandboxToolchainStamp {
  imageId: string;
  block?: string;
  /** Read-only compatibility with jobs queued before block-only stamps. Never write these fields. */
  prompt?: string;
  /** A native sub-agent invocation embeds several independently adapted prompts. */
  segments?: string[];
}

/** Provider wrappers and shell startup/PATH overrides can change discovery after an image probe. */
export function toolchainEnvironmentMatches(
  wrapper?: string | null,
  env?: Record<string, string> | null,
): boolean {
  return (
    !wrapper?.trim() && !['PATH', 'ENV', 'BASH_ENV'].some((key) => Object.hasOwn(env ?? {}, key))
  );
}

/** Only remove Haive's block within the leading block sequence. A quoted marker stays data. */
function findSandboxToolchain(prompt: string): { at: number; after: number; block: string } | null {
  const opener = /<haive_\w+>/y;
  let at = 0;
  for (;;) {
    opener.lastIndex = at;
    const open = opener.exec(prompt)?.[0];
    if (!open) return null;
    const close = `\n</${open.slice(1)}`;
    let end = prompt.indexOf(close, at + open.length);
    while (
      end !== -1 &&
      end + close.length < prompt.length &&
      prompt[end + close.length] !== '\n'
    ) {
      end = prompt.indexOf(close, end + 1);
    }
    if (end === -1) return null;
    let after = end + close.length;
    if (prompt.startsWith('\n\n', after)) after += 2;
    else if (prompt[after] === '\n') after++;
    if (open === SANDBOX_TOOLCHAIN_MARKER) {
      return { at, after, block: prompt.slice(at, end + close.length) };
    }
    at = after;
  }
}

/** Remove just the owned advisory and its separator; preserve task-leading blank lines. */
export function stripSandboxToolchain(prompt: string): string {
  const found = findSandboxToolchain(prompt);
  return found
    ? stripSandboxToolchain(prompt.slice(0, found.at) + prompt.slice(found.after))
    : prompt;
}

export function sandboxToolchainBlock(prompt: string): string | null {
  return findSandboxToolchain(prompt)?.block ?? null;
}

export function withSandboxToolchain(
  prompt: string,
  fact: SandboxToolchainFact | null | undefined,
): string {
  const clean = stripSandboxToolchain(prompt);
  if (!fact || !IMMUTABLE_IMAGE_ID.test(fact.imageId)) return clean;
  const line =
    fact.php === 'absent'
      ? "PHP is absent from this sandbox image's PATH. Avoid bare `php` checks; report checks you cannot run."
      : `PHP is found on this sandbox image's PATH${fact.version && /^\d{1,2}\.\d{1,2}\.\d{1,2}(?:[a-zA-Z0-9.+-]{0,24})?$/.test(fact.version) ? ` (version ${fact.version})` : ''}.`;
  return `${SANDBOX_TOOLCHAIN_MARKER}\n${line}\nProject-local tools and the project runtime may differ.\n${CLOSE}\n\n${clean}`;
}

/** Recheck at the final spawn choke point, including sub-agent and app-server fallback paths.
 * Pin the launch to the inspected ID so a tag rebuilt AFTER inspect cannot invalidate the fact.
 * A different/unknown image or changed environment strips the advisory, never guesses a replacement.
 * This only shortens a queued prompt, retaining its original delivery, flags and credentials. */
export async function recheckSandboxToolchain(
  spec: CliCommandSpec,
  image: string | null,
  runner: DockerRunner = defaultDockerRunner,
  wrapper?: string | null,
  extraEnv?: Record<string, string>,
): Promise<{ spec: CliCommandSpec; image: string | null; strippedBlock?: string }> {
  const stamp = spec.sandboxToolchain;
  if (!stamp) return { spec, image };
  const selected = image ?? process.env.SANDBOX_IMAGE ?? SANDBOX_CORE_IMAGE;
  // Preserve runInSandbox's base self-heal before turning its mutable tag into an ID.
  // A failed ensure leaves no claim and lets the ordinary runner report its own error.
  const inspected = await ensureSandboxCoreImage(selected, runner)
    .then(() => runner.inspect(selected))
    .catch(() => null);
  const pinned =
    inspected?.exists && inspected.imageId && IMMUTABLE_IMAGE_ID.test(inspected.imageId)
      ? inspected.imageId
      : null;
  if (
    pinned === stamp.imageId &&
    toolchainEnvironmentMatches(wrapper, { ...spec.env, ...extraEnv })
  )
    return { spec, image: pinned };
  const block = stamp.block ?? sandboxToolchainBlock(stamp.segments?.[0] ?? stamp.prompt ?? '');
  const separator = block ? block + '\n\n' : '';
  const replace = (text: string) => (separator ? text.replaceAll(separator, '') : text);
  const replaceJson = (text: string) =>
    separator ? text.replaceAll(JSON.stringify(separator).slice(1, -1), '') : text;
  const { sandboxToolchain: _stamp, ...clean } = spec;
  return {
    image: pinned ?? image,
    ...(block ? { strippedBlock: block } : {}),
    spec: {
      ...clean,
      args: spec.args.map(replace),
      ...(spec.stdinPrompt !== undefined
        ? { stdinPrompt: replaceJson(replace(spec.stdinPrompt)) }
        : {}),
      ...(spec.stdinInitial !== undefined ? { stdinInitial: replaceJson(spec.stdinInitial) } : {}),
      ...(spec.promptFile
        ? { promptFile: { ...spec.promptFile, content: replace(spec.promptFile.content) } }
        : {}),
      ...(spec.codexAppServer
        ? {
            codexAppServer: { ...spec.codexAppServer, prompt: replace(spec.codexAppServer.prompt) },
          }
        : {}),
    },
  };
}
