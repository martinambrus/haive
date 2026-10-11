import { describe, expect, it } from 'vitest';
import { changedFields } from './config-diff';

const loaded = {
  enabled: true,
  mode: 'internal',
  namespace: 'default',
  embedDimensions: 2560,
};

describe('changedFields', () => {
  it('is empty for an unchanged config', () => {
    expect(changedFields(loaded, { ...loaded })).toEqual({});
  });

  it('holds one key for one changed field', () => {
    expect(changedFields(loaded, { ...loaded, namespace: 'team' })).toEqual({ namespace: 'team' });
  });

  it('holds only the changed keys when several differ', () => {
    expect(changedFields(loaded, { ...loaded, enabled: false, embedDimensions: 1024 })).toEqual({
      enabled: false,
      embedDimensions: 1024,
    });
  });
});
