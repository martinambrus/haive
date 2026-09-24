import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PHONE_MEDIA_QUERY,
  SIDEBAR_DEFAULT_PX,
  SIDEBAR_DIVIDER_PX,
  SIDEBAR_RAIL_PX,
  SIDEBAR_MAX_PX,
  SIDEBAR_MIN_PX,
  clampSidebarWidth,
  sidebarOffsetPx,
  widthFromPointer,
} from './sidebar-geometry';

describe('clampSidebarWidth', () => {
  it('keeps a width inside the band', () => {
    expect(clampSidebarWidth(300)).toBe(300);
  });

  it('floors and caps out-of-band widths', () => {
    expect(clampSidebarWidth(40)).toBe(SIDEBAR_MIN_PX);
    expect(clampSidebarWidth(4000)).toBe(SIDEBAR_MAX_PX);
  });

  it('rounds, so a fractional pointer position never reaches the style attribute', () => {
    expect(clampSidebarWidth(301.6)).toBe(302);
  });

  it('falls back to the default for a non-finite width', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_PX);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_PX);
  });
});

describe('widthFromPointer', () => {
  it('reads the pointer x as the width when the aside is at the viewport edge', () => {
    expect(widthFromPointer(320)).toBe(320);
  });

  it('subtracts the aside offset', () => {
    expect(widthFromPointer(320, 40)).toBe(280);
  });

  it('clamps a drag past either end', () => {
    expect(widthFromPointer(-100)).toBe(SIDEBAR_MIN_PX);
    expect(widthFromPointer(9999)).toBe(SIDEBAR_MAX_PX);
  });
});

describe('sidebarOffsetPx', () => {
  it('counts the divider, which sits beside the column', () => {
    expect(sidebarOffsetPx(false, 300)).toBe(300 + SIDEBAR_DIVIDER_PX);
  });

  // The divider is not rendered on the rail, so counting it would push fixed headers 4px
  // past the edge of a collapsed sidebar.
  it('is the bare rail when collapsed', () => {
    expect(sidebarOffsetPx(true, 300)).toBe(SIDEBAR_RAIL_PX);
  });

  it('clamps the width it is given rather than trusting a stored value', () => {
    expect(sidebarOffsetPx(false, 99999)).toBe(SIDEBAR_MAX_PX + SIDEBAR_DIVIDER_PX);
    expect(sidebarOffsetPx(false, Number.NaN)).toBe(SIDEBAR_DEFAULT_PX + SIDEBAR_DIVIDER_PX);
  });
});

describe('the phone breakpoint', () => {
  // The first paint happens before any script, so globals.css carries its own copy of both values.
  it('is the query and the rail width globals.css paints the first frame with', () => {
    const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
    expect(css).toContain(`@media ${PHONE_MEDIA_QUERY} {`);
    expect(css).toContain(`--haive-sidebar-w: ${SIDEBAR_RAIL_PX}px !important`);
    expect(css).toContain(`{ width: ${SIDEBAR_RAIL_PX}px !important; }`);
  });
});
