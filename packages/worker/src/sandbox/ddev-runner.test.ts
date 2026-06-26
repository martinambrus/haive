import { describe, it, expect } from 'vitest';
import { decideDdevRecovery, isHostPortCollision } from './ddev-runner.js';

// Pure recovery-path decision for ensureDdevStartedInner. The orchestrator gathers
// the three booleans by shelling out (ddev describe / docker info) and then routes
// on this result; the docker-shelling itself is left untested by design (no docker
// mocking in this package — mirrors how 07c extracts + tests `classifyDrift`).
describe('decideDdevRecovery', () => {
  it('serving project (describe ok + primary_url) -> reuse, regardless of dockerd probe', () => {
    expect(decideDdevRecovery({ describeOk: true, hasPrimaryUrl: true, dockerdUp: true })).toBe(
      'reuse',
    );
    expect(decideDdevRecovery({ describeOk: true, hasPrimaryUrl: true, dockerdUp: false })).toBe(
      'reuse',
    );
  });

  it('describe returned but no primary_url, nested dockerd alive -> warm-start', () => {
    expect(decideDdevRecovery({ describeOk: true, hasPrimaryUrl: false, dockerdUp: true })).toBe(
      'warm-start',
    );
  });

  it('project down (describe failed) but runner + dockerd alive -> warm-start', () => {
    expect(decideDdevRecovery({ describeOk: false, hasPrimaryUrl: false, dockerdUp: true })).toBe(
      'warm-start',
    );
  });

  it('runner / nested dockerd gone -> cold-boot', () => {
    expect(decideDdevRecovery({ describeOk: false, hasPrimaryUrl: false, dockerdUp: false })).toBe(
      'cold-boot',
    );
  });

  it('reuse requires BOTH describeOk and primary_url: stale primary_url without a live describe falls to the dockerd probe', () => {
    // describe failed but its (stale) output still contained the primary_url
    // token — not trusted: with no live dockerd this must rebuild, not reuse.
    expect(decideDdevRecovery({ describeOk: false, hasPrimaryUrl: true, dockerdUp: false })).toBe(
      'cold-boot',
    );
    expect(decideDdevRecovery({ describeOk: false, hasPrimaryUrl: true, dockerdUp: true })).toBe(
      'warm-start',
    );
  });
});

describe('isHostPortCollision', () => {
  it('matches the known docker host-port-bind error forms', () => {
    // These strings come from the docker daemon and are ephemeral upstream wording;
    // the collision-retry loop keys on them, so this test pins the forms we handle.
    expect(isHostPortCollision('Bind for 127.0.0.1:49215 failed: port is already allocated')).toBe(
      true,
    );
    expect(isHostPortCollision('listen tcp 0.0.0.0:8080: bind: address already in use')).toBe(true);
    expect(isHostPortCollision('Error: ports are not available: exposing port TCP')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isHostPortCollision('PORT IS ALREADY ALLOCATED')).toBe(true);
  });

  it('does not match unrelated docker errors (those should surface, not retry)', () => {
    expect(isHostPortCollision('no such image: ddev-runner:latest')).toBe(false);
    expect(isHostPortCollision('Cannot connect to the Docker daemon')).toBe(false);
    expect(isHostPortCollision('')).toBe(false);
  });
});
