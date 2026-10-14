import type { ModuleDiffRow, SkippedSeed } from '@haive/shared/modularity';

function Reason({ seed }: { seed: SkippedSeed }) {
  if (seed.reason === 'conflict') {
    return (
      <>
        the slug is held by another row (source <code>{seed.heldBy}</code>).
      </>
    );
  }
  const kinds = seed.issues.length > 0 ? `: ${seed.issues.join(', ')}` : '';
  return <>it fails the checks an admin task type gets{kinds}.</>;
}

export function ModuleSkippedSeeds({
  rows,
}: {
  rows: Pick<ModuleDiffRow, 'id' | 'skippedSeeds'>[];
}) {
  const skipped = rows.flatMap((row) =>
    row.skippedSeeds.map((seed) => ({ moduleId: row.id, seed })),
  );
  if (skipped.length === 0) return null;
  return (
    <section
      aria-labelledby="module-skipped-seeds-title"
      data-testid="skipped-seeds"
      className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-200 [&_code]:font-mono [&_code]:text-amber-100"
    >
      <h2 id="module-skipped-seeds-title" className="font-medium">
        Task type seeds the worker skipped
      </h2>
      <p className="mt-1 text-amber-300/80">
        The worker did not store these at its last boot, so the task types do not exist on this
        install as the modules declare them. The worker log has the details.
      </p>
      <ul className="mt-2 flex flex-col gap-1 [overflow-wrap:anywhere]">
        {skipped.map(({ moduleId, seed }) => (
          <li key={`${moduleId}:${seed.slug}`}>
            <code>{seed.slug}</code> of module <code>{moduleId}</code>: <Reason seed={seed} />
          </li>
        ))}
      </ul>
    </section>
  );
}
