import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTechInventory,
  renderTechInventoryTable,
} from '../src/step-engine/steps/onboarding/_tech-inventory.js';

let tmpDir: string;

async function writeFileAt(rel: string, content: string): Promise<void> {
  const full = path.join(tmpDir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tech-inventory-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('buildTechInventory — Java + Gradle + LWJGL 2 (RDApi case)', () => {
  it('detects lwjgl2 + gradle from build.gradle and source imports', async () => {
    await writeFileAt(
      'build.gradle',
      [
        "apply plugin: 'java'",
        '',
        'dependencies {',
        "    implementation 'org.lwjgl.lwjgl:lwjgl:2.9.3'",
        "    implementation 'org.lwjgl.lwjgl:lwjgl_util:2.9.3'",
        "    testImplementation 'junit:junit:4.13'",
        '}',
      ].join('\n'),
    );

    /* Six Java files referencing org.lwjgl, above the threshold of 5. */
    for (let i = 0; i < 6; i += 1) {
      await writeFileAt(
        `src/main/java/com/example/Renderer${i}.java`,
        [
          'package com.example;',
          '',
          'import org.lwjgl.opengl.GL11;',
          'import org.lwjgl.LWJGLException;',
          '',
          `public class Renderer${i} {}`,
        ].join('\n'),
      );
    }

    const inv = await buildTechInventory(tmpDir);
    const names = inv.items.map((it) => it.name);
    expect(names).toContain('lwjgl2');
    expect(names).toContain('gradle');
    /* JUnit had no source-side usage, threshold filter drops it. */
    expect(names).not.toContain('junit');

    const lwjgl = inv.items.find((it) => it.name === 'lwjgl2')!;
    expect(lwjgl.fileCount).toBeGreaterThanOrEqual(5);
    expect(lwjgl.category).toBe('graphics');
    expect(lwjgl.manifests).toContain('build.gradle');
  });
});

describe('buildTechInventory — Drupal 7 + TCPDF + PostgreSQL', () => {
  it('detects tcpdf and postgresql with PHP source counts', async () => {
    await writeFileAt(
      'composer.json',
      JSON.stringify(
        {
          name: 'acme/legacy-site',
          require: {
            'drupal/drupal': '7.x',
            'tecnickcom/tcpdf': '6.5.0',
          },
        },
        null,
        2,
      ),
    );

    /* Six TCPDF call sites */
    for (let i = 0; i < 6; i += 1) {
      await writeFileAt(
        `sites/all/modules/custom/report${i}.module`,
        [
          '<?php',
          '',
          `function report${i}_pdf() {`,
          '  $pdf = new TCPDF();',
          '  return $pdf;',
          '}',
        ].join('\n'),
      );
    }

    /* Five PostgreSQL call sites */
    for (let i = 0; i < 5; i += 1) {
      await writeFileAt(
        `sites/all/modules/custom/db${i}.inc`,
        [
          '<?php',
          '',
          `function db${i}_run() {`,
          '  pg_connect("host=localhost");',
          '  pg_query("SELECT 1");',
          '}',
        ].join('\n'),
      );
    }

    const inv = await buildTechInventory(tmpDir);
    const names = inv.items.map((it) => it.name);
    expect(names).toContain('tcpdf');
    expect(names).toContain('postgresql');
    expect(names).toContain('drupal-7');

    const tcpdf = inv.items.find((it) => it.name === 'tcpdf')!;
    expect(tcpdf.category).toBe('pdf');
    expect(tcpdf.fileCount).toBeGreaterThanOrEqual(5);

    const pg = inv.items.find((it) => it.name === 'postgresql')!;
    expect(pg.category).toBe('db');
    expect(pg.fileCount).toBeGreaterThanOrEqual(5);
  });
});

describe('buildTechInventory — threshold filtering', () => {
  it('drops non-framework deps with usage below threshold', async () => {
    await writeFileAt(
      'package.json',
      JSON.stringify({
        name: 'demo',
        dependencies: { axios: '1.0.0', three: '0.150.0' },
      }),
    );
    /* Only one file using axios — below threshold of 5. */
    await writeFileAt('src/api.ts', "import axios from 'axios';\nexport const api = axios;");

    const inv = await buildTechInventory(tmpDir);
    const names = inv.items.map((it) => it.name);
    expect(names).not.toContain('axios');
    /* three has zero source usage, also dropped. */
    expect(names).not.toContain('three');
  });

  it('keeps framework deps even with low usage', async () => {
    await writeFileAt(
      'package.json',
      JSON.stringify({
        name: 'demo',
        dependencies: { next: '15.0.0', react: '19.0.0' },
      }),
    );
    /* No source files. Framework category still surfaces from manifest alone. */
    const inv = await buildTechInventory(tmpDir);
    const names = inv.items.map((it) => it.name);
    expect(names).toContain('next');
    expect(names).toContain('react');
  });
});

describe('buildTechInventory — gradle wildcard matching', () => {
  it('matches Spring Boot via org.springframework.boot:* wildcard', async () => {
    await writeFileAt(
      'build.gradle',
      [
        'dependencies {',
        "    implementation 'org.springframework.boot:spring-boot-starter-web:3.2.0'",
        "    implementation 'org.springframework.boot:spring-boot-starter-data-jpa:3.2.0'",
        '}',
      ].join('\n'),
    );

    const inv = await buildTechInventory(tmpDir);
    const names = inv.items.map((it) => it.name);
    expect(names).toContain('spring-boot');
    expect(names).toContain('gradle');
  });

  it('matches map-syntax gradle deps', async () => {
    await writeFileAt(
      'build.gradle',
      [
        'dependencies {',
        "    implementation group: 'org.lwjgl.lwjgl', name: 'lwjgl', version: '2.9.3'",
        '}',
      ].join('\n'),
    );
    /* lwjgl2 is the `graphics` category — needs source-side usage to clear
       the threshold even though the manifest match exists. */
    for (let i = 0; i < 5; i += 1) {
      await writeFileAt(
        `src/main/java/com/example/Render${i}.java`,
        [
          'package com.example;',
          '',
          'import org.lwjgl.opengl.GL11;',
          `public class Render${i} {}`,
        ].join('\n'),
      );
    }

    const inv = await buildTechInventory(tmpDir);
    expect(inv.items.map((it) => it.name)).toContain('lwjgl2');
  });
});

describe('renderTechInventoryTable', () => {
  it('renders an empty placeholder when inventory is empty', () => {
    const out = renderTechInventoryTable({ items: [], scannedManifests: [] });
    expect(out).toContain('no significant secondary technologies');
  });

  it('renders a markdown table with suggested agent ids', () => {
    const out = renderTechInventoryTable({
      items: [
        {
          name: 'lwjgl2',
          displayName: 'LWJGL 2',
          category: 'graphics',
          manifests: ['build.gradle'],
          matchedKeys: ['org.lwjgl.lwjgl:lwjgl'],
          fileCount: 12,
        },
      ],
      scannedManifests: ['build.gradle'],
    });
    expect(out).toContain('| LWJGL 2 | graphics | 12 | build.gradle | lwjgl2-specialist |');
    expect(out).toMatch(/Technology \| Category \| Files/);
  });
});

describe('buildTechInventory — empty repo', () => {
  it('returns empty inventory when no manifests are present', async () => {
    const inv = await buildTechInventory(tmpDir);
    expect(inv.items).toEqual([]);
    expect(inv.scannedManifests).toEqual([]);
  });
});
