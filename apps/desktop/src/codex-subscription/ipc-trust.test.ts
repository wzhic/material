import { describe, expect, it, vi } from 'vitest';

import { isTrustedMainWindowSender } from './ipc-trust';

const windowLike = (id: number, destroyed = false, contentsDestroyed = false) => ({
  isDestroyed: vi.fn(() => destroyed),
  webContents: {
    id,
    isDestroyed: vi.fn(() => contentsDestroyed),
  },
});

describe('main-window IPC trust', () => {
  it('accepts only the live product window webContents id', () => {
    expect(isTrustedMainWindowSender(windowLike(7), 7)).toBe(true);
    expect(isTrustedMainWindowSender(windowLike(7), 8)).toBe(false);
    expect(isTrustedMainWindowSender(null, 7)).toBe(false);
    expect(isTrustedMainWindowSender(windowLike(7, true), 7)).toBe(false);
    expect(isTrustedMainWindowSender(windowLike(7, false, true), 7)).toBe(false);
  });
});
