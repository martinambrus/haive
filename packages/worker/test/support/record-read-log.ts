/** Classify the git shim's "$*" log. Record reads must stay outside set-aside transactions. */
export function isRecordReadLog(line: string): boolean {
  if (/cat-file blob [0-9a-f]{40,}$/.test(line)) return true;
  const args = line.split(' ');
  const command = args.indexOf('ls-tree');
  if (command < 0 || !args.slice(command + 1).includes('-r')) return false;
  const paths = args.slice(args.indexOf('--', command) + 1);
  // These metadata listings are permitted inside transactions; a state-only listing
  // is a record read regardless of which ref or flag order the caller chose.
  return paths.join(' ') !== '.haive-data/state .haive-data/plan.json .haive-data/plan.md';
}
