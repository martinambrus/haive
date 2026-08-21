import { HAIVE_DATA_DIR } from './types/index.js';

/* ------------------------------------------------------------------ */
/* Canonical on-disk locations for project knowledge                   */
/*                                                                     */
/* Knowledge rides the committed, clone-restored `.haive-data/` mirror */
/* dir rather than a vendor dir. Haive is model-agnostic — a Codex      */
/* user's agents live in `.codex/`, a Gemini user's in `.gemini/` — so  */
/* filing their project knowledge under `.claude/` was a wart. Note     */
/* `.haive-data/` is the COMMITTED dir; `.haive/` is the git-excluded   */
/* one (per-task worktrees) and never holds knowledge.                  */
/*                                                                     */
/* Dependency-free leaf: imported by the web bundle via the            */
/* `@haive/shared/knowledge-paths` subpath, never through the barrel   */
/* (which drags ioredis -> dns into the browser build).                */
/* ------------------------------------------------------------------ */

export const KB_DIR = `${HAIVE_DATA_DIR}/knowledge_base`;
export const LEARNINGS_DIR = `${HAIVE_DATA_DIR}/learnings`;
export const INVESTIGATIONS_DIR = `${KB_DIR}/investigations`;

/** Path prefixes the RAG collectors walk to pick knowledge markdown out of a
 *  repo. Trailing slash so the test is an anchored directory-prefix match. */
export const KNOWLEDGE_SOURCE_PREFIXES = [`${KB_DIR}/`, `${LEARNINGS_DIR}/`] as const;
