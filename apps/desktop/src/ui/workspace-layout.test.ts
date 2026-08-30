import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKSPACE_LAYOUT,
  nextTimelineZoom,
  normalizeWorkspaceLayout,
  parseWorkspaceLayout,
  serializeWorkspaceLayout,
} from './workspace-layout';

describe('workspace layout preferences', () => {
  it('restores bounded values and rounds pointer-derived fractions', () => {
    expect(normalizeWorkspaceLayout({
      mediaPercent: 64.6,
      sidebarWidth: 244.4,
      timelineHeight: 356.7,
    })).toEqual({
      mediaPercent: 65,
      sidebarWidth: 244,
      timelineHeight: 357,
    });
  });

  it('clamps out-of-range values and repairs malformed persisted data', () => {
    expect(normalizeWorkspaceLayout({
      mediaPercent: 2,
      sidebarWidth: 9_000,
      timelineHeight: Number.NaN,
    })).toEqual({
      mediaPercent: 38,
      sidebarWidth: 280,
      timelineHeight: DEFAULT_WORKSPACE_LAYOUT.timelineHeight,
    });
    expect(parseWorkspaceLayout('{not-json')).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it('serializes only the three versioned numeric preferences', () => {
    expect(JSON.parse(serializeWorkspaceLayout({
      mediaPercent: 58,
      sidebarWidth: 196,
      timelineHeight: 292,
    }))).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it('moves through explicit timeline zoom levels without exceeding bounds', () => {
    expect(nextTimelineZoom(100, 'out')).toBe(100);
    expect(nextTimelineZoom(100, 'in')).toBe(150);
    expect(nextTimelineZoom(150, 'in')).toBe(200);
    expect(nextTimelineZoom(400, 'in')).toBe(400);
    expect(nextTimelineZoom(300, 'out')).toBe(200);
  });
});
