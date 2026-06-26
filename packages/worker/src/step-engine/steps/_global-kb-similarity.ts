import { cosineSimilarity, ollamaEmbed } from '@haive/shared/rag';

// Embedding similarity gate for global-KB supersession. The coarse topic key
// (category:tech) only narrows the CANDIDATE SET; whether a new article actually
// REPLACES an existing one is decided here by real embedding cosine, so two
// different articles that share a tech (e.g. two DDEV tech_patterns) never falsely
// supersede each other. Shared by the promote path (_global-kb-promote) and the
// kb_author enrich path (kb-author/01-enrich).

/** Minimum cosine for a new article to be judged the SAME article as an existing
 *  one (and thus supersede it). Calibrated on qwen3-embedding:4b: a reworded
 *  same-topic article scores ~0.96 while the nearest DISTINCT curated article
 *  scores ~0.30, so 0.72 sits ~2.4x above the distinct ceiling with wide margin.
 *  Biased high on purpose: a missed match becomes a harmless duplicate the user
 *  can dedup, never a wrong-topic clobber. */
export const SUPERSEDE_SIMILARITY_THRESHOLD = 0.72;

/** Max same-key entries compared per promotion (bounds the embed batch). */
export const SUPERSEDE_CANDIDATE_LIMIT = 20;

/** Each title+body is clipped to this many chars before embedding — topic identity
 *  lives in the title + first section, and it bounds embed latency on long bodies. */
export const SUPERSEDE_EMBED_CHARS = 4000;

export interface SupersedeCandidate {
  id: string;
  status: string;
  /** Identity text (typically `title\n\nbody`) compared against the new article. */
  text: string;
}

interface ScoredCandidate {
  id: string;
  status: string;
  sim: number;
}

/** Pure: choose the entry a new article should supersede. Eligible = sim >=
 *  threshold; among those prefer an `active` entry (the canonical live article),
 *  then the highest similarity. Null when nothing clears the bar — the caller then
 *  inserts an independent new entry instead of replacing one. */
export function pickBestSupersedeMatch(
  scored: ScoredCandidate[],
  threshold = SUPERSEDE_SIMILARITY_THRESHOLD,
): string | null {
  const eligible = scored.filter((s) => s.sim >= threshold);
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    const aActive = a.status === 'active' ? 0 : 1;
    const bActive = b.status === 'active' ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return b.sim - a.sim;
  });
  return eligible[0]!.id;
}

interface EmbedSettings {
  ollamaUrl: string | null;
  embedModel: string | null;
}

/** Confirm, via real embeddings, which existing entry (if any) the new article
 *  genuinely duplicates — so a supersede fires only for the SAME article, never for
 *  a different one that merely shares the coarse topic key. Embeds the candidate +
 *  every candidate body in ONE ollama call and scores cosine. Returns the chosen id,
 *  or null when ollama is unconfigured, the embed call fails, or nothing clears the
 *  threshold. Null is the SAFE default — the caller adds a new entry rather than
 *  replacing one. Uses ollamaEmbed directly (NO hash fallback), so a degraded embed
 *  can never produce a false match. */
export async function confirmSupersedeByEmbedding(
  settings: EmbedSettings,
  candidateText: string,
  candidates: SupersedeCandidate[],
  threshold = SUPERSEDE_SIMILARITY_THRESHOLD,
): Promise<string | null> {
  if (!settings.ollamaUrl || !settings.embedModel) return null;
  if (candidates.length === 0) return null;
  const clip = (t: string): string => t.slice(0, SUPERSEDE_EMBED_CHARS);
  try {
    const inputs = [clip(candidateText), ...candidates.map((c) => clip(c.text))];
    const vecs = await ollamaEmbed(settings.ollamaUrl, settings.embedModel, inputs);
    const [candVec, ...candidateVecs] = vecs;
    if (!candVec || candidateVecs.length !== candidates.length) return null;
    const scored: ScoredCandidate[] = candidates.map((c, i) => ({
      id: c.id,
      status: c.status,
      sim: cosineSimilarity(candVec, candidateVecs[i]!),
    }));
    return pickBestSupersedeMatch(scored, threshold);
  } catch {
    return null;
  }
}
