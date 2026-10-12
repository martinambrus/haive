import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { claimFileName, type ProjectStateConflictBody } from '@haive/shared/project-state';
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
      pendingIds: [],
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

  it('shows the RTK question under its own name, with its values as On and Off', () => {
    const html = view({
      conflicts: [
        conflict({
          unit: 'settings/rtk-enabled.json',
          key: null,
          base: { present: true, value: true },
          local: { present: true, value: true },
          incoming: { present: true, value: false },
        }),
      ],
    });
    expect(html).toContain('RTK command compression');
    expect(html).not.toContain('The whole project record file');
    expect(html).not.toContain('haive-json-tree');
    expect(html).toContain('Off');
    expect(html).toContain('Keep mine');
    expect(html).toContain('Take theirs');
  });

  it('shows a claim question under the file it is about, its sides as readable text', () => {
    const claim = (writtenHash: string) => ({
      path: 'docs/guide.md',
      templateId: 'workflow-config',
      kind: 'workflow-config',
      schemaVersion: 1,
      templateHash: 'c'.repeat(64),
      writtenHash,
      haiveVersion: '1.2.3',
    });
    const html = view({
      conflicts: [
        conflict({
          unit: claimFileName('docs/guide.md'),
          key: null,
          base: { present: true, value: claim('1'.repeat(64)) },
          local: { present: true, value: claim('2'.repeat(64)) },
          incoming: { present: false },
        }),
      ],
    });
    expect(html).toContain('the claim for docs/guide.md');
    expect(html).toContain('workflow-config');
    expect(html).toContain('222222222222');
    expect(html).toContain('Not set.');
    expect(html).toContain('haive-md');
    expect(html).not.toContain('The whole project record file');
    expect(html).toContain('Keep mine');
    expect(html).toContain('Take theirs');
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
      messages: { [c.id]: { tone: 'error', text: 'An upgrade is using `this repository`.' } },
    });
    expect(html).toContain('An upgrade is using <code>this repository</code>.');
  });

  it('keeps showing a notice after the last conflict is answered', () => {
    const html = view({ notice: 'Commit and push `render.json`.' });
    expect(html).toContain('Commit and push');
    expect(html).toContain('<code>render.json</code>');
  });

  it('keeps both answers disabled while an answer to that conflict is still being applied', () => {
    const c = conflict();
    const other = conflict({ id: '33333333-3333-4333-8333-333333333333' });
    const html = view({ conflicts: [c, other], pendingIds: [c.id] });
    expect(html.match(/<button[^>]*disabled=""[^>]*>(Keep mine|Take theirs)/g)).toHaveLength(2);
    expect(html.match(/<button[^>]*>(Keep mine|Take theirs)/g)).toHaveLength(4);
  });
});
