import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GameEnrichmentConsentStore } from './consent-store';
import { GAME_ENRICHMENT_PROVIDER } from './types';

describe('game enrichment persistent consent store', () => {
  const directories: string[] = [];

  afterEach(() => {
    directories.splice(0).forEach((directory) => rmSync(directory, { force: true, recursive: true }));
  });

  const createPath = (): string => {
    const directory = mkdtempSync(path.join(tmpdir(), 'material-game-enrichment-'));
    directories.push(directory);
    return path.join(directory, 'consent.json');
  };

  it('persists a bounded non-secret contract and can clear it', async () => {
    const filePath = createPath();
    const store = new GameEnrichmentConsentStore(
      filePath,
      () => new Date('2026-08-29T00:00:00.000Z'),
    );

    await store.grant(GAME_ENRICHMENT_PROVIDER);

    expect(await new GameEnrichmentConsentStore(filePath).has(GAME_ENRICHMENT_PROVIDER)).toBe(true);
    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('bangumi-public-v0');
    expect(content).toContain('gameName');
    expect(content).not.toMatch(/api[_-]?key|authorization|token/i);

    await store.clear();
    expect(await new GameEnrichmentConsentStore(filePath).has(GAME_ENRICHMENT_PROVIDER)).toBe(false);
  });

  it('invalidates consent when the provider version or sent fields contract changes', async () => {
    const filePath = createPath();
    const store = new GameEnrichmentConsentStore(filePath);
    await store.grant(GAME_ENRICHMENT_PROVIDER);

    expect(await store.has({ ...GAME_ENRICHMENT_PROVIDER, version: 'future-version' })).toBe(false);
    expect(await store.has({
      ...GAME_ENRICHMENT_PROVIDER,
      sentFields: ['gameName'],
      version: GAME_ENRICHMENT_PROVIDER.version,
    })).toBe(true);
  });
});
