const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const replaceUnsafeControlCharacters = (value: string): string =>
  [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    const unsafe = code <= 0x1f
      || (code >= 0x7f && code <= 0x9f)
      || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x2069);
    return unsafe ? ' ' : character;
  }).join('');

export const normalizeGameName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = replaceUnsafeControlCharacters(value.normalize('NFKC'))
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length >= 2 && normalized.length <= 100 ? normalized : null;
};

export const validRequestId = (value: unknown): value is string =>
  typeof value === 'string' && REQUEST_ID_PATTERN.test(value);

export const sanitizeExternalText = (
  value: unknown,
  maximum: number,
): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = replaceUnsafeControlCharacters(value.normalize('NFKC'))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  return normalized.slice(0, maximum);
};
