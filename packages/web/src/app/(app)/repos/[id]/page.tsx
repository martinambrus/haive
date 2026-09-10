import { redirect } from 'next/navigation';

/**
 * A bare repository URL has no page — only the five sub-routes do — so it 404s, which is what a
 * bookmark, a pasted link or a hand-typed path gets.
 *
 * Plan is the destination because it is the repository's own primary action in the repos list,
 * ahead of estimates and the terminal. `params` is awaited because Next 16 hands it over as a
 * promise.
 */
export default async function RepoIndexPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/repos/${id}/plan`);
}
