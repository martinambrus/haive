import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProjectStateConflictBody } from '@haive/shared/project-state';
import { ProjectStateConflictsView } from './project-state-conflicts-banner';

const conflict = (over: Partial<ProjectStateConflictBody> = {}): ProjectStateConflictBody => ({
  id: '22222222-2222-4222-8222-222222222222',
  unit: 'project/render.json#acceptedAgentIds',
  key: 'acceptedAgentIds',
  base: { present: true, value: ['base-agent'] },
  local: { present: true, value: ['my-agent'] },
  incoming: { present: true, value: ['their-agent'] },
  detectedAt: '2026-10-12T08:00:00.000Z',
  resolution: null,
  resolvedAt: null,
  ...over,
});

const view = (props: Partial<Parameters<typeof ProjectStateConflictsView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ProjectStateConflictsView, {
      conflicts: [],
      notice: null,
      messages: {},
      busyId: null,
      onAnswer: () => {},
      ...props,
    }),
  );

describe('ProjectStateConflictsView', () => {
  it('renders nothing with no conflicts and no notice', () => {
    expect(view()).toBe('');
  });

  it('explains that upgrades and rollbacks are held', () => {
    const html = view({ conflicts: [conflict()] });
    expect(html).toContain('Upgrades and rollbacks are held until every question is answered');
  });

  it('shows the three values through the markdown renderer, not a bare pre', () => {
    const html = view({ conflicts: [conflict()] });
    expect(html).toContain('my-agent');
    expect(html).toContain('their-agent');
    expect(html).toContain('base-agent');
    expect(html).toContain('haive-md');
    expect(html).toContain('Accepted agents');
  });

  it('offers both answers', () => {
    const html = view({ conflicts: [conflict()] });
    expect(html).toContain('Keep mine');
    expect(html).toContain('Take theirs');
  });

  it('names the whole file for the null key', () => {
    const html = view({
      conflicts: [conflict({ unit: 'project/render.json', key: null })],
    });
    expect(html).toContain('The whole project record file');
  });

  it('disables Keep mine where this install has no value of its own', () => {
    const html = view({ conflicts: [conflict({ local: { present: false } })] });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Keep mine/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Take theirs/);
  });

  it('shows a message under its own conflict', () => {
    const c = conflict();
    const html = view({
      conflicts: [c],
      messages: { [c.id]: { tone: 'error', text: 'An upgrade is using this repository.' } },
    });
    expect(html).toContain('An upgrade is using this repository.');
  });

  it('keeps showing a notice after the last conflict is answered', () => {
    const html = view({ notice: 'Commit and push the record file.' });
    expect(html).toContain('Commit and push the record file.');
  });
});
