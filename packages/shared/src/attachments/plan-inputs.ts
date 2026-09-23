/** Names the worker's `00-plan-inputs` step writes into a task's uploads directory, kept here
 *  because the api has to know them too: it reserves the index name at the uploads root, and a
 *  delete has to take an original's sidecar with it. The api may not import the worker. */

/** The index of a plan build's inputs, written beside the attachments. */
export const PLAN_INPUTS_INDEX_NAME = '_PLAN_INPUTS.md';

/** Appended to an original's own name, so `spec.docx` and `spec.xlsx` cannot collide on one
 *  `spec.md`. */
export const PLAN_INPUT_SIDECAR_SUFFIX = '.extracted.md';

/** Where the extracted text of an attachment lives, relative to the uploads directory. A path, not
 *  a basename: `docs/spec.docx` has its sidecar at `docs/spec.docx.extracted.md`. */
export function planInputSidecarName(filename: string): string {
  return `${filename}${PLAN_INPUT_SIDECAR_SUFFIX}`;
}
