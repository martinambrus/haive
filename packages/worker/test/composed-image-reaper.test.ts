import { describe, expect, it } from 'vitest';
import {
  selectStaleComposedImages,
  type ComposedImageInfo,
} from '../src/sandbox/composed-image-reaper.js';

const NOW = 1_000_000_000_000; // fixed clock (ms)
const DAY = 24 * 60 * 60 * 1000;
const MAX_AGE = 14 * DAY;

function img(ref: string, id: string, ageDays: number): ComposedImageInfo {
  return { ref, id, createdAtMs: NOW - ageDays * DAY };
}

describe('selectStaleComposedImages', () => {
  it('evicts images older than maxAge that no running container uses', () => {
    const images = [img('haive-sandbox:old', 'sha256:a', 20)];
    expect(selectStaleComposedImages(images, new Set(), NOW, MAX_AGE)).toEqual([
      'haive-sandbox:old',
    ]);
  });

  it('keeps images younger than maxAge', () => {
    const images = [img('haive-sandbox:fresh', 'sha256:b', 3)];
    expect(selectStaleComposedImages(images, new Set(), NOW, MAX_AGE)).toEqual([]);
  });

  it('keeps a stale image that backs a running container (matched by tag)', () => {
    const images = [img('haive-sandbox:used', 'sha256:c', 30)];
    const running = new Set(['haive-sandbox:used']);
    expect(selectStaleComposedImages(images, running, NOW, MAX_AGE)).toEqual([]);
  });

  it('keeps a stale image that backs a running container (matched by image id)', () => {
    const images = [img('haive-sandbox:used', 'sha256:c', 30)];
    const running = new Set(['sha256:c']);
    expect(selectStaleComposedImages(images, running, NOW, MAX_AGE)).toEqual([]);
  });

  it('treats exactly maxAge as stale (>=)', () => {
    const images = [img('haive-sandbox:edge', 'sha256:d', 14)];
    expect(selectStaleComposedImages(images, new Set(), NOW, MAX_AGE)).toEqual([
      'haive-sandbox:edge',
    ]);
  });

  it('never reaps an image with an unparseable creation time (NaN)', () => {
    const images: ComposedImageInfo[] = [
      { ref: 'haive-sandbox:bad', id: 'sha256:e', createdAtMs: NaN },
    ];
    expect(selectStaleComposedImages(images, new Set(), NOW, MAX_AGE)).toEqual([]);
  });

  it('partitions a mixed set correctly', () => {
    const images = [
      img('haive-sandbox:a', 'sha256:1', 30), // stale -> reap
      img('haive-sandbox:b', 'sha256:2', 1), // fresh -> keep
      img('haive-sandbox:c', 'sha256:3', 40), // stale but running -> keep
    ];
    const running = new Set(['haive-sandbox:c']);
    expect(selectStaleComposedImages(images, running, NOW, MAX_AGE)).toEqual(['haive-sandbox:a']);
  });
});
