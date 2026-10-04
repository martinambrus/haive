/** Assignment comes from the invocation, never from its title or the current repo profiles. */
export function AgentPersonaBadges({ ids }: { ids?: string[] | null }) {
  return ids?.map((id) => (
    <span
      key={id}
      className="max-w-[20rem] truncate rounded border border-indigo-500/40 bg-indigo-500/10 px-1.5 py-0.5 text-indigo-300"
      title={`Assigned agent personality: ${id}`}
      aria-label={`Agent personality: ${id}`}
    >
      {id}
    </span>
  ));
}
