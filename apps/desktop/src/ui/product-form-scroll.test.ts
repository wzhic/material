import { describe, expect, it, vi } from 'vitest';

import { resetProductPageScroll } from './product-form-scroll';

describe('product page scroll reset', () => {
  it('returns the shared content viewport to the top', () => {
    const scrollTo = vi.fn();

    expect(resetProductPageScroll((selector) => {
      expect(selector).toBe('.app-content');
      return { scrollTo };
    })).toBe(true);
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenCalledWith({ behavior: 'auto', left: 0, top: 0 });
  });

  it('is safe while the shared viewport is unavailable', () => {
    expect(resetProductPageScroll(() => null)).toBe(false);
  });
});
