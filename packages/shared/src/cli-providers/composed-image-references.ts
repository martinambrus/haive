/** Inputs resolved at verification, distinct from the user's explicit RTK pin. */
export interface ComposedImageInputs {
  rtkVersion: string;
  baseImageId: string | null;
  rtkPin: string | null;
  requestedHash: string;
}
export const MAX_COMPOSED_LSP_PROVIDERS = 16;
export const COMPOSED_IMAGE_REFS_KEY = 'composedLspImageRefs';

export interface ComposedImageReference {
  tag: string;
  imageId: string;
  identityHash: string;
  inputs: ComposedImageInputs;
}
interface ProviderReferences {
  providerId: string;
  effective?: ComposedImageReference;
  prior?: ComposedImageReference;
  verifying?: ComposedImageReference;
}
export interface ComposedImageReferences {
  schemaVersion: 1;
  entries: ProviderReferences[];
}

export function parseImageReferences(
  metadata: unknown,
  limit = MAX_COMPOSED_LSP_PROVIDERS,
): ComposedImageReferences {
  const raw = (metadata as Record<string, unknown> | null)?.[COMPOSED_IMAGE_REFS_KEY] as
    ComposedImageReferences | undefined;
  if (!raw) return { schemaVersion: 1, entries: [] };
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.entries) || raw.entries.length > limit)
    throw new Error('Invalid retained composed image references');
  for (const e of raw.entries) {
    if (typeof e.providerId !== 'string')
      throw new Error('Invalid composed image provider reference');
    for (const ref of [e.effective, e.prior, e.verifying])
      if (
        ref &&
        (typeof ref.tag !== 'string' ||
          typeof ref.imageId !== 'string' ||
          typeof ref.identityHash !== 'string' ||
          !ref.inputs ||
          typeof ref.inputs.rtkVersion !== 'string' ||
          typeof ref.inputs.requestedHash !== 'string' ||
          !(ref.inputs.baseImageId === null || typeof ref.inputs.baseImageId === 'string') ||
          !(ref.inputs.rtkPin === null || typeof ref.inputs.rtkPin === 'string'))
      )
        throw new Error('Invalid retained composed image reference');
  }
  return raw;
}
