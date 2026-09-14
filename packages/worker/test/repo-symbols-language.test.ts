import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectRepoSymbols } from '../src/step-engine/steps/onboarding/08-knowledge-acquisition.js';

// The citation scrub asks for an anchor repo's symbols with NO language, and the old fallback
// was ['.php','.js','.ts','.py'] — which misses Drupal's own .module/.inc/.theme, the exact
// shape the scrub exists for (the entry that motivated it cited `activit.module:534`).
describe('collectRepoSymbols with an unknown language', () => {
  async function repoWith(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'symbols-'));
    for (const [name, body] of Object.entries(files)) {
      await writeFile(path.join(dir, name), body, 'utf8');
    }
    return dir;
  }

  it('finds symbols in extensions the four-entry default missed', async () => {
    const dir = await repoWith({
      'activit.module': 'function activit_menu_alter($items) {}',
      'helper.inc': 'function activit_render_icon($name) {}',
      'main.go': 'func ProcessInvoiceBatch() {}\ntype InvoiceWriter interface {}',
      'lib.rb': 'class InvoiceSerializer\nend',
    });
    const symbols = await collectRepoSymbols(dir, null);
    expect(symbols.has('activit_menu_alter')).toBe(true);
    expect(symbols.has('activit_render_icon')).toBe(true);
    expect(symbols.has('InvoiceSerializer')).toBe(true);
  });

  it('still scans only the named language when one is given', async () => {
    const dir = await repoWith({
      'activit.module': 'function activit_menu_alter($items) {}',
      'lib.rb': 'class InvoiceSerializer\nend',
    });
    const symbols = await collectRepoSymbols(dir, 'ruby');
    expect(symbols.has('InvoiceSerializer')).toBe(true);
    expect(symbols.has('activit_menu_alter')).toBe(false);
  });
});
