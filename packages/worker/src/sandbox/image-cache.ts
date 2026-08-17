import { createHash } from 'node:crypto';
import { CLI_INSTALL_METADATA, type CliProviderName } from '@haive/shared';
import { buildProviderInstallLines } from '../cli-versions/codegen.js';

export interface ImageTagResolution {
  tag: string;
  shared: boolean;
  dockerfileLines: string[];
}

const BASE_IMAGE = 'haive-cli-sandbox:latest';

export function resolveImageTag(params: {
  name: CliProviderName;
  cliVersion: string | null;
  providerId: string;
  sandboxDockerfileExtra: string | null;
}): ImageTagResolution | null {
  const extra = (params.sandboxDockerfileExtra ?? '').trim();
  const meta = CLI_INSTALL_METADATA[params.name];
  const codegen = buildProviderInstallLines(params.name, params.cliVersion);

  const hasInstall = codegen.supported && codegen.lines.length > 0;
  const hasExtras = extra.length > 0;

  if (!hasInstall && !hasExtras) return null;

  const blocks = [`FROM ${BASE_IMAGE}`];
  if (hasInstall) blocks.push(codegen.lines.join('\n'));
  if (hasExtras) blocks.push(extra);
  const dockerfileLines = [blocks.join('\n\n')];

  // Identity of what the image CONTAINS, for both flavours below.
  const contentHash = createHash('sha256')
    .update(`${dockerfileLines.join('\n\n')}\n`, 'utf8')
    .digest('hex')
    .slice(0, 16);

  if (hasInstall && !hasExtras) {
    const effectiveName = meta.install.kind === 'piggyback' ? meta.install.uses : params.name;
    const versionSegment =
      meta.versionPinnable && params.cliVersion ? params.cliVersion : 'installer';
    // The hash is what makes this tag SAFE TO CACHE. Keyed on name+version alone it carried
    // no content identity, so editing a provider's install lines produced a tag that already
    // existed and docker served the stale image — with NO build error anywhere, because the
    // build never ran. The breakage then surfaced at RUN time and looked unrelated to the
    // change. Observed on grok: an image built before its installer gained HOME=/opt/grok
    // kept being reused, and every run died as the sandbox user with
    // `exec: grok: Permission denied` while the source was already correct.
    //
    // Sharing is preserved, which is the whole point of this branch: providers whose rendered
    // Dockerfile is byte-identical hash identically, so claude-code and its piggybacks
    // (zai / ollama / muse) still collapse onto ONE tag and one build. Only a real change to
    // the rendered content moves the tag — including changes name+version cannot see, such as
    // a new BASE_IMAGE or a different autoUpdateDisable knob.
    //
    // The version segment stays for legibility (the tag says which CLI build it is); the hash
    // is what correctness rests on. Nothing parses this string — every consumer stores it,
    // compares it for equality, or hands it to docker — so appending a segment is safe.
    return {
      tag: `haive-cli-sandbox:${effectiveName}-${versionSegment}-${contentHash}`,
      shared: true,
      dockerfileLines,
    };
  }

  return {
    tag: `haive-cli-sandbox:provider-${params.providerId}-${contentHash}`,
    shared: false,
    dockerfileLines,
  };
}

export function renderDockerfile(resolution: ImageTagResolution): string {
  return `${resolution.dockerfileLines.join('\n\n')}\n`;
}
