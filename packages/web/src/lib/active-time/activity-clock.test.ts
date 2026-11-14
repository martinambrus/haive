import { describe, expect, it } from 'vitest';
import {
  ActivityClock,
  readingAllowanceMs,
  READING_WPM,
  MIN_READING_IDLE_MS,
  MAX_READING_IDLE_MS,
  PENDING_WORK_IDLE_MS,
  IFRAME_IDLE_MS,
} from './activity-clock';

describe('activity clock', () => {
  it('pins the reading rate, clamps and extended allowances', () => {
    expect([
      READING_WPM,
      MIN_READING_IDLE_MS,
      MAX_READING_IDLE_MS,
      PENDING_WORK_IDLE_MS,
      IFRAME_IDLE_MS,
    ]).toEqual([150, 60000, 300000, 900000, 900000]);
    expect([0, 150, 300, 750, 1000].map(readingAllowanceMs)).toEqual([
      60000, 60000, 120000, 300000, 300000,
    ]);
  });
  it('counts the overlap of a late interval, then nothing further in absence', () => {
    const c = new ActivityClock(0);
    expect(c.sample(59500, true)).toBe(59500);
    expect(c.sample(62000, true)).toBe(500);
    expect(c.sample(90000, true)).toBe(0);
    expect(c.isPresent(90000)).toBe(false);
  });
  it('input resumes without retro-counting an absence', () => {
    const c = new ActivityClock(0);
    c.input(90000);
    expect(c.sample(91000, true)).toBe(1000);
  });
  it('freezes deferred measurement to an epoch and accepts it only once', () => {
    const c = new ActivityClock(0);
    const epoch = c.epoch;
    c.setReadingWords(epoch, 300, 2000);
    c.setReadingWords(epoch, 750, 3000);
    expect(c.isPresent(120000)).toBe(false);
    c.input(130000);
    c.setReadingWords(epoch, 750, 130001);
    expect(c.isPresent(190000)).toBe(false);
  });
  it('restarts content only with recent real input, not chained content', () => {
    const c = new ActivityClock(0);
    expect(c.content(120000)).toBe(true);
    expect(c.sample(121000, true)).toBe(1000);
    expect(c.content(900001)).toBe(false);
    expect(c.isPresent(900001)).toBe(false);
  });
  it.each(['pending', 'iframe'] as const)(
    '%s extends only a present epoch and exit restores its reading deadline',
    (mode) => {
      const c = new ActivityClock(0);
      c.setModes(30000, mode === 'pending', mode === 'iframe');
      expect(c.isPresent(899999)).toBe(true);
      expect(c.isPresent(900000)).toBe(false);
      c.setModes(900001, false, false);
      c.setModes(900002, mode === 'pending', mode === 'iframe');
      expect(c.isPresent(900002)).toBe(false);
      c.input(910000);
      expect(c.isPresent(1809999)).toBe(true);
      c.setModes(920000, false, false);
      expect(c.isPresent(970000)).toBe(false);
    },
  );
  it('losing visibility ends the interval and returning cannot backfill it', () => {
    const c = new ActivityClock(0);
    expect(c.sample(500, true)).toBe(500);
    expect(c.sample(10000, false)).toBe(0);
    c.input(10000);
    expect(c.sample(11000, true)).toBe(1000);
  });
  it('a delayed measurement cannot smuggle in an extension that was refused while idle', () => {
    const c = new ActivityClock(0);
    c.setModes(61000, true, false);
    c.setReadingWords(c.epoch, 750, 61000);
    expect(c.isPresent(62000)).toBe(false);
    c.input(63000);
    expect(c.isPresent(900000)).toBe(true);
  });
});
