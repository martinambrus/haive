import { describe, expect, it } from 'vitest';
import {
  injectMissingTier1Specialists,
  type AgentCandidate,
} from '../src/step-engine/steps/onboarding/06_5-agent-discovery.js';
import type { TechInventory } from '../src/step-engine/steps/onboarding/_tech-inventory.js';

function makeInventory(items: TechInventory['items']): TechInventory {
  return { items, scannedManifests: [] };
}

describe('injectMissingTier1Specialists', () => {
  it('injects gradle-specialist when inventory has gradle and LLM dropped it', () => {
    const candidates: AgentCandidate[] = [
      {
        id: 'code-reviewer',
        label: 'Code reviewer',
        hint: 'reviews code',
        count: 0,
        recommended: true,
      },
    ];
    const inv = makeInventory([
      {
        name: 'gradle',
        displayName: 'Gradle',
        category: 'build',
        manifests: ['build.gradle'],
        matchedKeys: ['org.lwjgl.lwjgl:lwjgl'],
        fileCount: 3,
      },
    ]);
    injectMissingTier1Specialists(candidates, inv);
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain('gradle-specialist');
    const gradle = candidates.find((c) => c.id === 'gradle-specialist')!;
    expect(gradle.source).toBe('llm');
    expect(gradle.recommended).toBe(true);
    expect(gradle.body).toBeDefined();
    expect(gradle.body!.title).toBe('Gradle Specialist');
    expect(gradle.body!.field).toBe('build');
  });

  it('injects every Tier 1 inventory hit (build + framework + db + graphics)', () => {
    const candidates: AgentCandidate[] = [];
    const inv = makeInventory([
      {
        name: 'gradle',
        displayName: 'Gradle',
        category: 'build',
        manifests: ['build.gradle'],
        matchedKeys: [],
        fileCount: 1,
      },
      {
        name: 'lwjgl2',
        displayName: 'LWJGL 2',
        category: 'graphics',
        manifests: ['build.gradle'],
        matchedKeys: ['org.lwjgl.lwjgl:lwjgl'],
        fileCount: 12,
      },
      {
        name: 'spring-boot',
        displayName: 'Spring Boot',
        category: 'framework',
        manifests: ['pom.xml'],
        matchedKeys: ['org.springframework.boot:spring-boot-starter'],
        fileCount: 0,
      },
      {
        name: 'postgresql',
        displayName: 'PostgreSQL',
        category: 'db',
        manifests: [],
        matchedKeys: [],
        fileCount: 9,
      },
    ]);
    injectMissingTier1Specialists(candidates, inv);
    const ids = candidates.map((c) => c.id);
    expect(ids).toEqual([
      'gradle-specialist',
      'lwjgl2-specialist',
      'spring-boot-specialist',
      'postgresql-specialist',
    ]);
  });

  it('skips Tier 1 items already present (id collision)', () => {
    const candidates: AgentCandidate[] = [
      {
        id: 'gradle-specialist',
        label: 'Custom gradle',
        hint: 'h',
        count: 0,
        recommended: true,
        source: 'llm',
      },
    ];
    const inv = makeInventory([
      {
        name: 'gradle',
        displayName: 'Gradle',
        category: 'build',
        manifests: ['build.gradle'],
        matchedKeys: [],
        fileCount: 1,
      },
    ]);
    injectMissingTier1Specialists(candidates, inv);
    /* Existing custom kept; no duplicate added. */
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.label).toBe('Custom gradle');
  });

  it('skips items in non-mandatory categories', () => {
    const candidates: AgentCandidate[] = [];
    const inv = makeInventory([
      {
        name: 'axios',
        displayName: 'axios',
        category: 'http',
        manifests: ['package.json'],
        matchedKeys: ['axios'],
        fileCount: 20,
      },
      {
        name: 'tailwindcss',
        displayName: 'Tailwind CSS',
        category: 'css',
        manifests: ['package.json'],
        matchedKeys: ['tailwindcss'],
        fileCount: 50,
      },
    ]);
    injectMissingTier1Specialists(candidates, inv);
    expect(candidates).toEqual([]);
  });

  it('also skips when bare tech name already in candidates (e.g. predefined match)', () => {
    const candidates: AgentCandidate[] = [
      { id: 'react', label: 'React', hint: 'h', count: 0, recommended: true },
    ];
    const inv = makeInventory([
      {
        name: 'react',
        displayName: 'React',
        category: 'framework',
        manifests: ['package.json'],
        matchedKeys: ['react'],
        fileCount: 30,
      },
    ]);
    injectMissingTier1Specialists(candidates, inv);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.id).toBe('react');
  });
});
