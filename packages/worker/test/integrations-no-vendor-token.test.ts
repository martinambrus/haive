import { describe, expect, it } from 'vitest';
import {
  VENDOR_TOKEN_FUNCTIONS,
  offendersIn,
  vendorTokenUses,
  workerSources,
} from './support/vendor-token-guard.js';

// The broker holds the vendor token; the sandbox and the worker that builds it never do.
const WORKER_NEVER_HOLDS_A_VENDOR_TOKEN =
  'the worker must not reach a vendor token: the api alone reads a connection credential';

const IMPORTS_THE_WORKER_MIGHT_WRITE: Array<[string, string]> = [
  ['a named import', "import { getConnectionCredential } from '@haive/shared/integrations';"],
  [
    'a named import beside others, over several lines',
    "import {\n  parseIntegrationBindings,\n  decryptConnectionTokens,\n  type IntegrationBinding,\n} from '@haive/shared/integrations';",
  ],
  [
    'a renamed import',
    "import { getConnectionAccessToken as vendorToken } from '@haive/shared/integrations';",
  ],
  [
    'a type-only import',
    "import type { encryptConnectionTokens } from '@haive/shared/integrations';",
  ],
  [
    'a namespace import used by name',
    "import * as integrations from '@haive/shared/integrations';\nawait integrations.getConnectionCredential(db, id);",
  ],
  [
    'a dynamic import',
    "const { decryptConnectionTokens } = await import('@haive/shared/integrations');",
  ],
  ['a re-export', "export { encryptConnectionTokens } from '@haive/shared/integrations';"],
];

describe('the worker never holds a vendor token', () => {
  it('[W7] has no file under packages/worker/src that names a function reading or writing one', () => {
    const files = workerSources();
    expect(Object.keys(files).length, 'the scan reached the worker sources').toBeGreaterThan(300);
    expect(offendersIn(files), WORKER_NEVER_HOLDS_A_VENDOR_TOKEN).toEqual([]);
  });

  it.each(IMPORTS_THE_WORKER_MIGHT_WRITE)(
    '[W7] flags %s, so the scan has teeth',
    (_label, source) => {
      expect(vendorTokenUses(source).length).toBeGreaterThan(0);
      expect(offendersIn({ 'src/fixture.ts': source })).toHaveLength(1);
    },
  );

  it('[W7] flags every one of the four functions', () => {
    for (const name of VENDOR_TOKEN_FUNCTIONS) {
      expect(vendorTokenUses(`import { ${name} } from '@haive/shared/integrations';`)).toEqual([
        name,
      ]);
    }
  });

  it('[W7] lets prose name them, and a name that only contains one', () => {
    const source = [
      '// the api calls getConnectionCredential; the worker never does',
      '/** decryptConnectionTokens stays in shared */',
      "import { parseIntegrationBindings } from '@haive/shared/integrations';",
      'const getConnectionCredentialLabel = 1;',
      'const mygetConnectionAccessToken = 2;',
    ].join('\n');
    expect(offendersIn({ 'src/fixture.ts': source })).toEqual([]);
  });

  it('[W7] fails the very assertion that guards the tree when a fixture is added to it', () => {
    const files = {
      ...workerSources(),
      'src/fixture.ts': IMPORTS_THE_WORKER_MIGHT_WRITE[0]![1],
    };
    expect(offendersIn(files)).toContain('src/fixture.ts: getConnectionCredential');
  });
});
