export interface GrantedQuerySuppression {
  query: string | null;
}

export const suppressGrantedQueryAutoRun = (
  suppression: GrantedQuerySuppression,
  query: string,
): void => {
  suppression.query = query;
};

export const consumeGrantedQueryAutoRun = (
  suppression: GrantedQuerySuppression,
  query: string,
): boolean => {
  const suppressedQuery = suppression.query;
  suppression.query = null;
  return suppressedQuery === query;
};
