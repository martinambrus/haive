import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  declareDepsStep,
  scanRepoForDeps,
} from '../../src/step-engine/steps/env-replicate/01-declare-deps.js';

/** Exercise repo detection and the actual form default before rendering. */
export async function detectedRuntimeDefault(
  language: string,
  version: string,
): Promise<string | null> {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'runtime-default-'));
  const manifests: Record<string, [string, string]> = {
    node: ['package.json', JSON.stringify({ engines: { node: version } })],
    php: ['composer.json', JSON.stringify({ require: { php: version } })],
    java: ['pom.xml', `<maven.compiler.source>${version}</maven.compiler.source>`],
    go: ['go.mod', `module example\ngo ${version}\n`],
    rust: ['Cargo.toml', `[package]\nrust-version = "${version}"\n`],
    ruby: ['Gemfile', `ruby "${version}"\n`],
  };
  try {
    const [file, body] = manifests[language]!;
    await writeFile(path.join(repo, file), body);
    const detected = await scanRepoForDeps(repo);
    const form = declareDepsStep.form!({} as never, detected)!;
    const field = form.fields.find((f) => f.id === `${language}Version`);
    return field && 'default' in field ? (field.default as string) || null : null;
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}
