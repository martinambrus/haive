import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const agentsMd = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'AGENTS.md');

// Codex CLI reads at most `project_doc_max_bytes` of AGENTS.md (32 KiB by default) and cuts the
// rest, so a rule past that point reaches Claude Code only.
const LIMIT = 32 * 1024;

it('AGENTS.md fits the 32 KiB Codex CLI reads', () => {
  const bytes = readFileSync(agentsMd).length;
  assert.ok(
    bytes <= LIMIT,
    `AGENTS.md is ${bytes} bytes, ${bytes - LIMIT} over ${LIMIT}: move material into its docs/architecture/ topic`,
  );
});
