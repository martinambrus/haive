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
  /** Zero-based Unicode character offset in the stored prompt, for replay-safe audit removal. */
  offset?: number;
  /** Number of independently adapted leading advisories (one when omitted). */
  copies?: number;
  /** One-based match ordinals when task quotes occur between native prompts. */
  occurrences?: number[];
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
    while (prompt[at] === '\n') at++;
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

export function sandboxToolchainOffset(prompt: string): number | undefined {
  const found = findSandboxToolchain(prompt);
  // PostgreSQL text positions count Unicode characters, not JavaScript UTF-16 code units.
  return found ? [...prompt.slice(0, found.at)].length : undefined;
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

/** Each prompt owns only its leading advisory, even when its body quotes the same block.
 * If any block cannot be located, rebuild every prompt without the optional fact. */
export function prepareSandboxToolchainPrompts(prompts: string[], imageId?: string) {
  if (!imageId) return { prompts };
  const blocks = prompts.map(sandboxToolchainBlock);
  const block = blocks[0];
  if (!block || blocks.some((candidate) => candidate !== block))
    return { prompts: prompts.map(stripSandboxToolchain) };
  const separator = block + '\n\n';
  let matches = 0;
  // Production code builds neither native nor sequential sub-agent kinds today. If wired,
  // their ordinals must come from the assembled text, whose joins can complete quoted separators.
  const occurrences = prompts.map((prompt) => {
    const owned = matches + 1;
    matches += prompt.split(separator).length - 1;
    return owned;
  });
  return {
    prompts,
    stamp: {
      imageId,
      block,
      copies: prompts.length,
      ...(occurrences.some((n, i) => n !== i + 1) ? { occurrences } : {}),
    } satisfies SandboxToolchainStamp,
  };
}

function sandboxToolchainOccurrences(stamp: SandboxToolchainStamp): number[] {
  if (stamp.occurrences) return stamp.occurrences;
  // Old native stamps carried the original segments rather than a count.
  if (stamp.segments) {
    return (
      prepareSandboxToolchainPrompts(stamp.segments, stamp.imageId).stamp?.occurrences ??
      Array.from({ length: stamp.segments.length }, (_, i) => i + 1)
    );
  }
  return Array.from({ length: stamp.copies ?? 1 }, (_, i) => i + 1);
}

function removeStampedCopies(text: string, separator: string, occurrences: number[]): string {
  if (!separator) return text;
  if (occurrences.length === 1 && occurrences[0] === 1) return text.replace(separator, () => '');
  let match = 0;
  const owned = new Set(occurrences);
  return text.replaceAll(separator, () => (owned.has(++match) ? '' : separator));
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
): Promise<{
  spec: CliCommandSpec;
  image: string | null;
  strippedBlock?: string;
  strippedOccurrences?: number[];
}> {
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
  const occurrences = sandboxToolchainOccurrences(stamp);
  const replace = (text: string) => removeStampedCopies(text, separator, occurrences);
  const replaceJson = (text: string) =>
    removeStampedCopies(text, JSON.stringify(separator).slice(1, -1), occurrences);
  const { sandboxToolchain: _stamp, ...clean } = spec;
  return {
    image: pinned ?? image,
    ...(block ? { strippedBlock: block, strippedOccurrences: occurrences } : {}),
    spec: {
      ...clean,
      args: spec.args.map(replace),
      ...(spec.stdinPrompt !== undefined
        ? {
            stdinPrompt:
              separator && spec.stdinPrompt.includes(separator)
                ? replace(spec.stdinPrompt)
                : replaceJson(spec.stdinPrompt),
          }
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
