import { describe, expect, it } from 'vitest';

import {
  consumeGrantedQueryAutoRun,
  GrantedQuerySuppression,
  suppressGrantedQueryAutoRun,
} from './query-scheduling';

describe('granted query automatic scheduling', () => {
  it('suppresses exactly one automatic run for the query already started by consent', () => {
    const suppression: GrantedQuerySuppression = { query: null };

    suppressGrantedQueryAutoRun(suppression, '原神');

    expect(consumeGrantedQueryAutoRun(suppression, '原神')).toBe(true);
    expect(consumeGrantedQueryAutoRun(suppression, '原神')).toBe(false);
  });

  it('does not suppress a different name and clears the stale grant marker', () => {
    const suppression: GrantedQuerySuppression = { query: null };

    suppressGrantedQueryAutoRun(suppression, '原神');

    expect(consumeGrantedQueryAutoRun(suppression, '崩坏：星穹铁道')).toBe(false);
    expect(consumeGrantedQueryAutoRun(suppression, '原神')).toBe(false);
  });
});
