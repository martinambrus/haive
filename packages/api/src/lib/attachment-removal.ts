import { planInputSidecarName, splitAttachmentPath } from '@haive/shared';

export interface RemovableAttachment {
  id: string;
  filename: string;
  expandedFromId: string | null;
}

export interface AttachmentRemovalPlan {
  /** Expansion directories to remove whole, relative to the uploads dir. Never `''`. */
  trees: string[];
  /** Single files to remove, relative to the uploads dir: sidecars, and the members of a tree that
   *  cannot go whole. The deleted attachments' own files are not listed — the route owns those. */
  files: string[];
}

/**
 * What else a delete has to take off the disk, besides the attachments being deleted.
 *
 * Two kinds of file carry no row of their own and outlive their original unless removed here,
 * and both stay bind-mounted into the sandbox, so an agent keeps reading them after the person
 * believes the content is gone:
 *
 *  - the worker's extracted-text SIDECAR beside a document. Every deleted row's sidecar name is
 *    listed, whatever its kind — removing an absent one is a no-op, and a kind that gains a sidecar
 *    later is covered without a change here. A name a SURVIVING row owns is left alone: sidecar
 *    names are not reserved, so it can be a real attachment someone uploaded.
 *  - an archive's EXPANSION TREE. The rows cascade on the delete; the files do not. An archive
 *    anywhere expands into one directory at the uploads ROOT, so a folder delete that takes
 *    `docs/x.zip` must also take `x/`, which is not under `docs/`.
 *
 * A tree is removed whole only when nothing that survives lives in it. The api de-dupes files but
 * not directories, so a later folder upload named like the expansion directory lands INSIDE it —
 * and removing that tree recursively would delete those files while their rows stayed. Such a tree
 * is taken apart member by member instead.
 */
export function attachmentRemovalPlan(
  doomed: ReadonlySet<string>,
  rows: readonly RemovableAttachment[],
): AttachmentRemovalPlan {
  const children = rows.filter((r) => r.expandedFromId !== null && doomed.has(r.expandedFromId));
  const childIds = new Set(children.map((r) => r.id));
  const survivors = rows.filter((r) => !doomed.has(r.id) && !childIds.has(r.id));
  const survivingNames = new Set(survivors.map((r) => r.filename));
  const sidecarOf = (filename: string): string[] => {
    const name = planInputSidecarName(filename);
    return survivingNames.has(name) ? [] : [name];
  };

  const files: string[] = [];
  const membersByTree = new Map<string, RemovableAttachment[]>();
  for (const child of children) {
    const tree = splitAttachmentPath(child.filename).dir.split('/')[0] ?? '';
    // A member always lands under its archive's directory; one that somehow did not is removed on
    // its own, because `''` as a tree would be the whole uploads dir.
    if (tree === '') {
      files.push(child.filename, ...sidecarOf(child.filename));
      continue;
    }
    membersByTree.set(tree, [...(membersByTree.get(tree) ?? []), child]);
  }

  const trees: string[] = [];
  for (const [tree, members] of membersByTree) {
    if (survivors.some((r) => r.filename.startsWith(`${tree}/`))) {
      for (const member of members) files.push(member.filename, ...sidecarOf(member.filename));
    } else {
      trees.push(tree);
    }
  }
  for (const row of rows) {
    if (doomed.has(row.id)) files.push(...sidecarOf(row.filename));
  }
  return { trees, files: [...new Set(files)] };
}
