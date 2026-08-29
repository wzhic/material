export type ScrollTarget = Pick<HTMLElement, 'scrollTo'>;

export type ScrollTargetLookup = (selector: string) => ScrollTarget | null;

export const resetProductPageScroll = (lookup: ScrollTargetLookup): boolean => {
  const target = lookup('.app-content');
  if (!target) return false;
  target.scrollTo({ behavior: 'auto', left: 0, top: 0 });
  return true;
};
