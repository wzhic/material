import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RecordRepository } from './repository';
import { ConfirmedRecordInput } from './types';

const percentile95 = (samples: number[]): number => {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)];
};

const measure = (runs: number, operation: (index: number) => void): number[] =>
  Array.from({ length: runs }, (_, index) => {
    const startedAt = performance.now();
    operation(index);
    return Number((performance.now() - startedAt).toFixed(3));
  });

const recordJson = (name: string, index: number): ConfirmedRecordInput => ({
  industry: index % 2 ? 'game' : 'apparel',
  material: {
    schemaVersion: 1,
    displayName: name,
    mediaKind: index % 3 ? 'video' : 'image',
    byteSize: 1024 + index,
    fingerprintSha256: null,
    durationMs: null,
    width: null,
    height: null,
    sourceStatus: index % 5 ? 'available' : 'needs_relocation',
  },
  productSnapshot: null,
  report: {
    schemaVersion: 1,
    title: '固定性能样例报告',
    summary: '用于本地列表、搜索和详情性能验证。',
    scriptStructure: [],
    shotSummary: [],
    visualSummary: [],
    subtitleSummary: [],
    voiceAndSoundSummary: [],
    sellingPoints: [],
    emotionSummary: [],
    ctaSummary: [],
    score: { total: index % 101, dimensions: [] },
    tags: [],
    diagnoses: [],
    limitations: [],
    evidence: [],
  },
  rules: {
    schemaVersion: 1,
    templateId: index % 2 ? 'game-video' : 'apparel-video',
    templateVersion: '1.0.0',
    scoringRuleId: 'performance-score',
    scoringRuleVersion: '1.0.0',
    tagPackageVersion: '1.0.0',
  },
  run: {
    schemaVersion: 1,
    modelConfigurationName: '性能样例配置',
    modelId: 'performance-model',
    capabilityVersion: 'performance-1',
    completedAt: '2026-08-24T06:00:00.000Z',
  },
  visibleConversation: [],
  conversionContext: '',
  sourceRecordId: null,
});

describe('analysis records 10,000 item performance baseline', () => {
  let directory: string;
  let databasePath: string;
  let repository: RecordRepository;

  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'material-record-performance-'));
    databasePath = path.join(directory, 'records.sqlite3');
    repository = new RecordRepository(databasePath);
    repository.close();

    const database = new DatabaseSync(databasePath);
    const statement = database.prepare(
      `INSERT INTO analysis_records (
         id, industry, media_kind, material_display_name, product_display_name,
         total_score, source_status, source_record_id, confirmed_at,
         search_text, record_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    );
    database.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 10_000; index += 1) {
      const id = `record-${index.toString().padStart(5, '0')}`;
      const name = `确认素材 ${index.toString().padStart(5, '0')}.${index % 3 ? 'mp4' : 'png'}`;
      const input = recordJson(name, index);
      statement.run(
        id,
        input.industry,
        input.material.mediaKind,
        name,
        index % 4 ? null : `产品 ${index}`,
        input.report.score.total,
        input.material.sourceStatus,
        new Date(1_700_000_000_000 + index).toISOString(),
        name.toLocaleLowerCase('zh-CN'),
        JSON.stringify(input),
      );
    }
    database.exec('COMMIT');
    database.close();
    repository = new RecordRepository(databasePath);
  });

  afterAll(() => {
    repository.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it('keeps list, search and detail reads below the adjustable P95 baseline', () => {
    repository.list({ limit: 50 });
    const listSamples = measure(30, (index) => {
      expect(repository.list({ limit: 50, offset: index * 50 }).items).toHaveLength(50);
    });
    const searchSamples = measure(30, (index) => {
      const suffix = (5_000 + index).toString().padStart(5, '0');
      expect(repository.list({ query: `确认素材 ${suffix}` }).total).toBe(1);
    });
    const detailSamples = measure(30, (index) => {
      expect(repository.get(`record-${index.toString().padStart(5, '0')}`).id).toBeTruthy();
    });

    const summary = {
      datasetSize: 10_000,
      listMs: listSamples,
      listP95Ms: percentile95(listSamples),
      searchMs: searchSamples,
      searchP95Ms: percentile95(searchSamples),
      detailMs: detailSamples,
      detailP95Ms: percentile95(detailSamples),
    };
    console.info(`[record-performance] ${JSON.stringify(summary)}`);

    expect(summary.listP95Ms).toBeLessThan(1_000);
    expect(summary.searchP95Ms).toBeLessThan(1_000);
    expect(summary.detailP95Ms).toBeLessThan(1_000);
  });
});
