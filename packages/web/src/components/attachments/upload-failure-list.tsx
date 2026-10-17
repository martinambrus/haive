export function UploadFailureList({
  total,
  failed,
}: {
  total: number;
  failed: readonly { name: string; message: string }[];
}) {
  return (
    <>
      <p>
        {failed.length} of {total} attachment(s) could not be uploaded:
      </p>
      <ul
        aria-label="Attachments that failed to upload"
        className="max-h-48 list-disc overflow-auto pl-5 [overflow-wrap:anywhere]"
      >
        {failed.map((f, i) => (
          <li key={i}>
            <span className="font-mono">{f.name}</span>: {f.message}
          </li>
        ))}
      </ul>
    </>
  );
}
