import { describe, expect, it } from 'vitest';

import { parseByteRange } from './range';

describe('parseByteRange', () => {
  it('accepts full, open-ended and suffix byte ranges', () => {
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange(null, 100)).toBeNull();
  });

  it('clamps the end and rejects malformed or unsatisfiable ranges', () => {
    expect(parseByteRange('bytes=95-150', 100)).toEqual({ start: 95, end: 99 });
    expect(parseByteRange('bytes=100-', 100)).toBe('invalid');
    expect(parseByteRange('bytes=20-10', 100)).toBe('invalid');
    expect(parseByteRange('bytes=0-1,3-4', 100)).toBe('invalid');
    expect(parseByteRange('bytes=-0', 100)).toBe('invalid');
  });
});
