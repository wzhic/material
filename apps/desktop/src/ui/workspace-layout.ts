export interface WorkspaceLayout {
  mediaPercent: number;
  sidebarWidth: number;
  timelineHeight: number;
}

export const WORKSPACE_LAYOUT_STORAGE_KEY = 'material.workspace-layout.v1';

export const DEFAULT_WORKSPACE_LAYOUT: Readonly<WorkspaceLayout> = Object.freeze({
  mediaPercent: 58,
  sidebarWidth: 196,
  timelineHeight: 292,
});

const LIMITS: Record<keyof WorkspaceLayout, readonly [number, number]> = {
  mediaPercent: [38, 72],
  sidebarWidth: [168, 280],
  timelineHeight: [220, 440],
};

export const clampLayoutValue = (
  key: keyof WorkspaceLayout,
  value: number,
): number => {
  const [minimum, maximum] = LIMITS[key];
  if (!Number.isFinite(value)) {
    return DEFAULT_WORKSPACE_LAYOUT[key];
  }
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
};

export const normalizeWorkspaceLayout = (value: unknown): WorkspaceLayout => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_WORKSPACE_LAYOUT };
  }
  const candidate = value as Partial<Record<keyof WorkspaceLayout, unknown>>;
  return {
    mediaPercent: clampLayoutValue(
      'mediaPercent',
      typeof candidate.mediaPercent === 'number'
        ? candidate.mediaPercent
        : DEFAULT_WORKSPACE_LAYOUT.mediaPercent,
    ),
    sidebarWidth: clampLayoutValue(
      'sidebarWidth',
      typeof candidate.sidebarWidth === 'number'
        ? candidate.sidebarWidth
        : DEFAULT_WORKSPACE_LAYOUT.sidebarWidth,
    ),
    timelineHeight: clampLayoutValue(
      'timelineHeight',
      typeof candidate.timelineHeight === 'number'
        ? candidate.timelineHeight
        : DEFAULT_WORKSPACE_LAYOUT.timelineHeight,
    ),
  };
};

export const parseWorkspaceLayout = (serialized: string | null): WorkspaceLayout => {
  if (!serialized) {
    return { ...DEFAULT_WORKSPACE_LAYOUT };
  }
  try {
    return normalizeWorkspaceLayout(JSON.parse(serialized));
  } catch {
    return { ...DEFAULT_WORKSPACE_LAYOUT };
  }
};

export const serializeWorkspaceLayout = (layout: WorkspaceLayout): string =>
  JSON.stringify(normalizeWorkspaceLayout(layout));

export const nextTimelineZoom = (
  current: number,
  direction: 'in' | 'out',
): number => {
  const levels = [100, 150, 200, 300, 400];
  const normalized = levels.includes(current) ? current : 100;
  const currentIndex = levels.indexOf(normalized);
  return direction === 'in'
    ? levels[Math.min(levels.length - 1, currentIndex + 1)]
    : levels[Math.max(0, currentIndex - 1)];
};
