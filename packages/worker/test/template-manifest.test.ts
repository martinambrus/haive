import { describe, expect, it, beforeEach } from 'vitest';
import { computeSetHash } from '@haive/shared';
import {
  expandManifestFor,
  getTemplateManifest,
  REFERENCE_CONTEXT,
  resetTemplateManifestCache,
  type TemplateRenderContext,
} from '../src/step-engine/template-manifest.js';

describe('template manifest', () => {
  beforeEach(() => {
    resetTemplateManifestCache();
  });

  it('produces the same set hash across independent builds', () => {
    const a = getTemplateManifest();
    resetTemplateManifestCache();
    const b = getTemplateManifest();
    expect(a.setHash).toBe(b.setHash);
    expect(a.items.length).toBe(b.items.length);
  });

  it('produces the same per-item content hashes across independent builds', () => {
    const a = getTemplateManifest();
    resetTemplateManifestCache();
    const b = getTemplateManifest();
    const aById = new Map(a.items.map((i) => [i.id, i]));
    for (const itemB of b.items) {
      const itemA = aById.get(itemB.id);
      expect(itemA, `missing ${itemB.id} in manifest a`).toBeDefined();
      expect(itemB.contentHash).toBe(itemA!.contentHash);
      expect(itemB.schemaVersion).toBe(itemA!.schemaVersion);
      expect(itemB.kind).toBe(itemA!.kind);
    }
  });

  it('recomputes setHash via computeSetHash consistently with the manifest hash', () => {
    const manifest = getTemplateManifest();
    const recomputed = computeSetHash(
      manifest.items.map((i) => ({
        id: i.id,
        schemaVersion: i.schemaVersion,
        contentHash: i.contentHash,
      })),
    );
    expect(recomputed).toBe(manifest.setHash);
  });

  it('emits at least one baseline agent, a command, and workflow-config', () => {
    const manifest = getTemplateManifest();
    const ids = new Set(manifest.items.map((i) => i.id));
    expect(ids.has('workflow-config')).toBe(true);
    expect(ids.has('agents-index')).toBe(true);
    // code-reviewer is part of BASELINE_AGENT_SPECS — if renamed, update here.
    expect(ids.has('agent.code-reviewer')).toBe(true);
  });

  it('expandManifestFor(reference) is deterministic and populates content hashes', () => {
    const r1 = expandManifestFor(REFERENCE_CONTEXT);
    const r2 = expandManifestFor(REFERENCE_CONTEXT);
    expect(r1.length).toBe(r2.length);
    const byPathA = new Map(r1.map((r) => [r.diskPath, r]));
    for (const b of r2) {
      const a = byPathA.get(b.diskPath);
      expect(a, `missing diskPath ${b.diskPath}`).toBeDefined();
      expect(b.writtenHash).toBe(a!.writtenHash);
      expect(b.templateContentHash).toBe(a!.templateContentHash);
    }
  });

  it('expansion is gated by context: drupal-lsp files only emit when lspLanguages contains php-extended', () => {
    const noLsp = expandManifestFor(REFERENCE_CONTEXT);
    const lsp: TemplateRenderContext = {
      ...REFERENCE_CONTEXT,
      lspLanguages: ['php-extended'],
    };
    const withLsp = expandManifestFor(lsp);
    const pluginPaths = (rs: ReturnType<typeof expandManifestFor>) =>
      rs.filter((r) => r.templateKind === 'plugin-file').map((r) => r.diskPath);
    expect(pluginPaths(noLsp).length).toBe(0);
    expect(pluginPaths(withLsp).length).toBeGreaterThan(0);
  });

  it('agent targets fan-out: multiple target dirs produce one rendering per target', () => {
    const singleTarget: TemplateRenderContext = {
      ...REFERENCE_CONTEXT,
      acceptedAgentIds: ['code-reviewer'],
      agentTargets: [{ dir: '.claude/agents', format: 'markdown' }],
    };
    const multiTarget: TemplateRenderContext = {
      ...REFERENCE_CONTEXT,
      acceptedAgentIds: ['code-reviewer'],
      agentTargets: [
        { dir: '.claude/agents', format: 'markdown' },
        { dir: '.codex/agents', format: 'toml' },
        { dir: '.gemini/agents', format: 'markdown' },
      ],
    };
    const singleAgent = expandManifestFor(singleTarget).filter(
      (r) => r.templateId === 'agent.code-reviewer',
    );
    const multiAgent = expandManifestFor(multiTarget).filter(
      (r) => r.templateId === 'agent.code-reviewer',
    );
    expect(singleAgent.length).toBe(1);
    expect(multiAgent.length).toBe(3);
    // Fan-out across targets must not change the template-content hash.
    const hashes = new Set(multiAgent.map((r) => r.templateContentHash));
    expect(hashes.size).toBe(1);
  });
});
