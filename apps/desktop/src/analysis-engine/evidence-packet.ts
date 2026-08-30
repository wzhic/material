import { AnalysisEngineError } from './errors';
import type { EvidencePacket } from './types';
import type { MediaEvidenceOutput } from '../media-tools';
import { validateEvidenceBatch } from '../tooling/evidence';

const MAX_EVIDENCE_ITEMS = 300;
const MAX_EVIDENCE_TEXT = 800;
const MAX_PACKET_BYTES = 100_000;

const evenlySelect = <T>(values: readonly T[], maximum: number): T[] => {
  if (values.length <= maximum) return [...values];
  if (maximum === 1) return [values[0]];
  const selected: T[] = [];
  const used = new Set<number>();
  for (let index = 0; index < maximum; index += 1) {
    const position = Math.round(index * (values.length - 1) / (maximum - 1));
    if (!used.has(position)) {
      used.add(position);
      selected.push(values[position]);
    }
  }
  return selected;
};

export const buildEvidencePacket = (media: MediaEvidenceOutput): EvidencePacket => {
  if (media.schemaVersion !== 1) {
    throw new AnalysisEngineError('EVIDENCE_INVALID', '不支持的媒体证据版本');
  }
  if (media.evidence.length === 0) {
    throw new AnalysisEngineError('EVIDENCE_INVALID', '当前素材没有可供分析的结构化证据');
  }
  const durationMs = media.material.kind === 'video'
    ? Math.max(0, ...media.timeline.map((item) => item.endMs ?? item.startMs))
    : undefined;
  const validation = validateEvidenceBatch(media.evidence, {
    durationMs,
    mediaKind: media.material.kind,
  });
  if (!validation.ok) {
    throw new AnalysisEngineError('EVIDENCE_INVALID', '确定性媒体证据未通过合同校验');
  }

  const candidates = evenlySelect(media.evidence, MAX_EVIDENCE_ITEMS);
  const items: EvidencePacket['items'] = [];
  let truncatedTextCount = 0;
  for (const evidence of candidates) {
    const normalized = evidence.text.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    const text = normalized.length > MAX_EVIDENCE_TEXT
      ? `${normalized.slice(0, MAX_EVIDENCE_TEXT - 1)}…`
      : normalized;
    const item = {
      confidence: evidence.confidence,
      evidenceId: evidence.evidenceId,
      evidenceType: evidence.evidenceType,
      locator: structuredClone(evidence.locator),
      source: structuredClone(evidence.source),
      text,
    };
    const nextBytes = Buffer.byteLength(JSON.stringify([...items, item]), 'utf8');
    if (nextBytes > MAX_PACKET_BYTES) break;
    items.push(item);
    if (text.length < normalized.length) truncatedTextCount += 1;
  }
  if (media.evidence.length > 0 && items.length === 0) {
    throw new AnalysisEngineError('EVIDENCE_INVALID', '确定性媒体证据超过模型输入安全上限');
  }
  const omittedEvidenceCount = media.evidence.length - items.length;
  const limitations = [...media.limitations];
  if (omittedEvidenceCount > 0) {
    limitations.push(`模型证据包按时间范围抽样，未发送 ${omittedEvidenceCount} 条证据`);
  }
  if (truncatedTextCount > 0) {
    limitations.push(`模型证据包中 ${truncatedTextCount} 条长文本已按可见上限截断`);
  }
  return {
    includedEvidenceIds: new Set(items.map((item) => item.evidenceId)),
    items,
    limitations,
    omittedEvidenceCount,
    schemaVersion: 1,
    truncatedTextCount,
  };
};
