import { createHash } from 'node:crypto';
import { normalizeLspSelection } from '../sandbox/lsp-layer.js';

import {
  MAX_COMPOSED_LSP_PROVIDERS,
  type ComposedImageReference,
  type ComposedImageReferences,
} from '@haive/shared/composed-image-references';
export * from '@haive/shared/composed-image-references';

export function updateImageReferences(
  refs: ComposedImageReferences,
  providerId: string,
  ref: ComposedImageReference,
  publish: boolean,
  limit = MAX_COMPOSED_LSP_PROVIDERS,
): ComposedImageReferences {
  const entries = refs.entries.map((e) => ({ ...e }));
  let e = entries.find((e) => e.providerId === providerId);
  if (!e) {
    if (entries.length >= limit) throw new Error('Retained composed image provider limit reached');
    e = { providerId };
    entries.push(e);
  }
  if (publish) {
    if (e.effective?.imageId !== ref.imageId) e.prior = e.effective;
    e.effective = ref;
    delete e.verifying;
  } else e.verifying = ref;
  return { schemaVersion: 1, entries };
}

/** Only saved, user-requested inputs; a worker recipe/tool-cache update cannot
 * invalidate the reference used to launch an already verified immutable image. */
export function composedRequestedInputsHash(
  body: string,
  provider: { name: string; cliVersion: string | null; sandboxDockerfileExtra: string | null },
  deps: {
    lspServers?: readonly string[] | null;
    lspServerVersions?: Record<string, string | null> | null;
  },
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        body,
        provider: {
          name: provider.name,
          cliVersion: provider.cliVersion,
          extras: provider.sandboxDockerfileExtra,
        },
        selection: normalizeLspSelection(deps.lspServers, deps.lspServerVersions),
      }),
    )
    .digest('hex');
}
export class ComposedImageNotVerifiedError extends Error {}
