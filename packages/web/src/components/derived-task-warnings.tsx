import type { DerivedTaskWarning } from '@/lib/derived-diagnostics';
import { describeDerivedWarning } from '@/lib/derived-diagnostics';
import { InlineMarkdown } from './markdown/inline-markdown';

export function DerivedTaskWarnings({ warnings }: { warnings?: readonly DerivedTaskWarning[] }) {
  if (!warnings?.length) return null;
  return (
    <section
      aria-label="Task type warnings"
      className="rounded border border-amber-700 bg-amber-950/30 p-3"
    >
      <h3 className="text-sm font-semibold text-amber-200">Task type warnings</h3>
      {warnings.map((warning, index) => (
        <InlineMarkdown
          key={index}
          body={describeDerivedWarning(warning)}
          className="mt-1 text-sm text-amber-200"
        />
      ))}
    </section>
  );
}
