import { describe, expect, it } from 'vitest';
import { parseCftMilestones } from '../src/cli-versions/browser-versions.js';

/** The picker is fed from Chrome for Testing's per-milestone feed. The build-granularity feed
 *  is deliberately not used: MEASURED, 2478 entries against 42 here, and a dropdown cannot
 *  show 2478 builds. */
describe('parseCftMilestones', () => {
  const feed = {
    milestones: {
      '140': {
        milestone: '140',
        version: '140.0.7339.207',
        downloads: {
          chrome: [
            { platform: 'win64', url: 'https://example.invalid/win.zip' },
            { platform: 'linux64', url: 'https://example.invalid/linux.zip' },
          ],
        },
      },
      '154': {
        milestone: '154',
        version: '154.0.8016.0',
        downloads: { chrome: [{ platform: 'linux64', url: 'https://example.invalid/linux.zip' }] },
      },
    },
  };

  it('returns newest first, since that is the order a picker wants', () => {
    expect(parseCftMilestones(feed)).toEqual([
      { version: '154.0.8016.0', label: 'Chrome 154' },
      { version: '140.0.7339.207', label: 'Chrome 140' },
    ]);
  });

  it('drops a milestone with no linux64 build rather than offering one that cannot install', () => {
    const winOnly = {
      milestones: {
        '99': {
          milestone: '99',
          version: '99.0.0.0',
          downloads: { chrome: [{ platform: 'win64', url: 'https://example.invalid/w.zip' }] },
        },
      },
    };
    expect(parseCftMilestones(winOnly)).toEqual([]);
  });

  it('sorts numerically, so 9 does not outrank 140', () => {
    const mixed = {
      milestones: {
        '9': {
          milestone: '9',
          version: '9.0.0.0',
          downloads: { chrome: [{ platform: 'linux64', url: 'u' }] },
        },
        '140': {
          milestone: '140',
          version: '140.0.0.0',
          downloads: { chrome: [{ platform: 'linux64', url: 'u' }] },
        },
      },
    };
    expect(parseCftMilestones(mixed).map((v) => v.label)).toEqual(['Chrome 140', 'Chrome 9']);
  });

  // A malformed payload must yield nothing, which the refresher turns into a recorded error
  // rather than overwriting a good cache with an empty list.
  it('yields nothing for a payload it does not recognise', () => {
    expect(parseCftMilestones(null)).toEqual([]);
    expect(parseCftMilestones({})).toEqual([]);
    expect(parseCftMilestones({ milestones: 'nope' })).toEqual([]);
    expect(parseCftMilestones({ milestones: { '1': { version: '' } } })).toEqual([]);
  });
});
