import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const script = readFileSync(new URL('../../install/install.sh', import.meta.url), 'utf8');
const portInUse = script.match(/^port_in_use\(\) \{\n[\s\S]*?\n\}\n/m)?.[0];

// Docker Desktop publishes container ports from its engine VM, so the host's listener table
// (ss) lists nothing while docker reports the port taken.
function probe(port) {
  assert.ok(portInUse, 'port_in_use not found in install.sh');
  const bin = mkdtempSync(join(tmpdir(), 'install-ports-'));
  try {
    writeFileSync(join(bin, 'ss'), '#!/bin/sh\nexit 0\n');
    writeFileSync(
      join(bin, 'docker'),
      "#!/bin/sh\nprintf '%s\\n' '0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp' ''\n",
    );
    chmodSync(join(bin, 'ss'), 0o755);
    chmodSync(join(bin, 'docker'), 0o755);
    const r = spawnSync('/bin/sh', ['-c', `${portInUse}port_in_use ${port}`], {
      env: { PATH: `${bin}:/usr/bin:/bin` },
    });
    return r.status;
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

test('a port docker publishes counts as taken even when ss lists no listener', () => {
  assert.equal(probe(3000), 0);
});

test('a port neither ss nor docker reports stays free', () => {
  assert.equal(probe(3002), 1);
});
