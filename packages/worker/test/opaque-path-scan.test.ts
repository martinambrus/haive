import { describe, it, expect } from 'vitest';
import {
  looksGenerated,
  scanTextForOpaquePaths,
} from '../src/step-engine/steps/onboarding/_opaque-path-scan.js';

// The sweep's recall depended on a tool the run may not have. MEASURED across three
// onboarding runs of one repo: the two whose prompt wired `rag_search` found the secret
// route segments; the `ragMode: 'none'` task, told to "discover with grep / ripgrep
// instead", missed them TWICE — before and after the class was named in the prompt.
// These carry no keyword to grep for.
describe('looksGenerated', () => {
  // The three real segments from a live Drupal 7 repo.
  it('flags the segments that were actually missed', () => {
    for (const s of ['lfewjngfsda47wq', '19dd78sa09dsa', 'ps03cxmasa']) {
      expect(looksGenerated(s), s).toBe(true);
    }
  });

  // The ordinary segments sitting beside them in the same file.
  it('leaves human-named segments alone', () => {
    for (const s of [
      'cron-notifications',
      'cron-trash-cleanup',
      'webhook',
      'admin',
      'node',
      'user',
      'activit',
      'inspections',
      'notifications',
      'dashboard',
    ]) {
      expect(looksGenerated(s), s).toBe(false);
    }
  });

  it('ignores anything shorter than a token', () => {
    for (const s of ['v2', 'api', 'sk', 'x1y2']) expect(looksGenerated(s), s).toBe(false);
  });

  // Generated but NOT secret — these appear in paths constantly.
  it('ignores uuids, hashes and plain numbers', () => {
    for (const s of [
      '550e8400-e29b-41d4-a716-446655440000',
      'd41d8cd98f00b204e9800998ecf8427e',
      'da39a3ee5e6b4b0d3255bfef95601890afd80709',
      '1234567890',
    ]) {
      expect(looksGenerated(s), s).toBe(false);
    }
  });

  it('ignores a name with a version suffix', () => {
    for (const s of ['bootstrap3', 'jquery-3', 'drupal7']) expect(looksGenerated(s), s).toBe(false);
  });
});

describe('scanTextForOpaquePaths', () => {
  it('finds a secret route segment in a hook_menu registration', () => {
    const hits = scanTextForOpaquePaths(
      'activit.module',
      [
        '<?php',
        "  $items['cron-trash-cleanup/19dd78sa09dsa'] = array(",
        "    'access callback' => TRUE,",
      ].join('\n'),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: 'activit.module', line: 2, segment: '19dd78sa09dsa' });
    expect(hits[0]!.literal).toBe('cron-trash-cleanup/19dd78sa09dsa');
  });

  // Framework-agnostic on purpose: the shape is a quoted path, not a Drupal call.
  it('finds the same shape in a non-Drupal route', () => {
    const hits = scanTextForOpaquePaths(
      'routes.js',
      "app.post('/hooks/ps03cxmasa-cxlkad', handler)",
    );
    expect(hits.map((h) => h.segment)).toEqual(['ps03cxmasa-cxlkad']);
  });

  it('leaves an ordinary route alone', () => {
    expect(scanTextForOpaquePaths('routes.js', "app.get('/admin/inspections/list', h)")).toEqual(
      [],
    );
  });

  it('skips urls and data uris', () => {
    const text =
      "const a='https://cdn.example.com/xk39dkfj20x/a.js'; const b='data:image/png;base64,iVBORw0KGgoAAAANS';";
    expect(scanTextForOpaquePaths('a.js', text)).toEqual([]);
  });

  // A minified bundle is one enormous line of quoted fragments; judging it wastes the
  // budget and tells the reader nothing.
  it('skips a minified line', () => {
    const long = `var x='${'a/b9x8k2m4p/c'.repeat(200)}';`;
    expect(scanTextForOpaquePaths('bundle.min.js', long)).toEqual([]);
  });
});
