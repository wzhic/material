import type { AnalysisRecord, ReportEvidence } from './types';

const escapeHtml = (value: string | number): string => String(value).replace(
  /[&<>"']/g,
  (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] as string,
);

const formatLocalTime = (value: string): string => new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'long',
  timeStyle: 'short',
}).format(new Date(value));

const formatTime = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const formatEvidenceRange = (evidence: ReportEvidence): string => {
  if (evidence.startMs === null) return '无时间定位';
  if (evidence.endMs === null || evidence.endMs === evidence.startMs) {
    return formatTime(evidence.startMs);
  }
  return `${formatTime(evidence.startMs)}–${formatTime(evidence.endMs)}`;
};

const listSection = (title: string, items: string[]): string => items.length ? `
  <section>
    <h2>${escapeHtml(title)}</h2>
    <ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
  </section>` : '';

const industryLabel = (record: AnalysisRecord): string =>
  record.industry === 'apparel' ? '服饰' : '游戏';

const mediaLabel = (record: AnalysisRecord): string =>
  record.material.mediaKind === 'video' ? '视频' : '图片';

export const buildRecordPdfHtml = (record: AnalysisRecord): string => {
  const score = record.report.score.total === null ? '未评分' : `${record.report.score.total} / 100`;
  const dimensions = record.report.score.dimensions.map((dimension) => `
    <div class="score-item">
      <span>${escapeHtml(dimension.label)}</span>
      <strong>${dimension.score === null ? '—' : escapeHtml(dimension.score)}</strong>
    </div>`).join('');
  const tags = record.report.tags.map((tag) => `
    <span class="tag">${escapeHtml(tag.label)}<small>${tag.source === 'fixed' ? '固定' : '动态'}</small></span>`).join('');
  const diagnoses = record.report.diagnoses.map((diagnosis) => `
    <article class="diagnosis">
      <h3>${escapeHtml(diagnosis.problem)}</h3>
      <p>${escapeHtml(diagnosis.suggestion)}</p>
      <small>证据：${diagnosis.evidenceIds.length ? diagnosis.evidenceIds.map(escapeHtml).join('、') : '无引用'}</small>
    </article>`).join('');
  const evidence = record.report.evidence.map((item) => `
    <article class="evidence">
      <div><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(formatEvidenceRange(item))}</span></div>
      <p>${escapeHtml(item.summary)}</p>
      <small>${item.source === 'tool' ? '工具证据' : item.source === 'model' ? '模型证据' : '融合证据'} · ${escapeHtml(item.id)}</small>
    </article>`).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
  <title>${escapeHtml(record.report.title)}</title>
  <style>
    @page { size: A4; margin: 18mm 15mm 20mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #1d2129; font: 12px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
    header { padding: 0 0 18px; border-bottom: 2px solid #0052d9; }
    h1 { margin: 6px 0 8px; font-size: 25px; line-height: 1.3; }
    h2 { margin: 0 0 10px; font-size: 16px; }
    h3 { margin: 0 0 5px; font-size: 13px; }
    p { margin: 0; white-space: pre-wrap; }
    section { margin-top: 18px; break-inside: avoid; }
    ul { margin: 0; padding-left: 18px; }
    li + li { margin-top: 5px; }
    .eyebrow { color: #0052d9; font-weight: 700; letter-spacing: .08em; }
    .meta { display: flex; flex-wrap: wrap; gap: 6px 18px; color: #5f6b7a; }
    .summary { margin-top: 14px; padding: 14px 16px; border-radius: 8px; background: #f3f6fb; font-size: 13px; }
    .overview { display: grid; grid-template-columns: 120px 1fr; gap: 14px; align-items: stretch; }
    .total-score { display: grid; place-items: center; padding: 14px; border-radius: 8px; color: #fff; background: #0052d9; text-align: center; }
    .total-score strong { display: block; font-size: 22px; }
    .total-score span { font-size: 11px; opacity: .86; }
    .score-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .score-item { display: flex; justify-content: space-between; gap: 8px; padding: 10px; border: 1px solid #d7dce5; border-radius: 6px; }
    .tag-list { display: flex; flex-wrap: wrap; gap: 7px; }
    .tag { padding: 4px 8px; border-radius: 999px; color: #004ec2; background: #e8f1ff; }
    .tag small { margin-left: 5px; color: #66758c; }
    .diagnosis, .evidence { margin-top: 8px; padding: 11px 12px; border: 1px solid #d7dce5; border-radius: 7px; break-inside: avoid; }
    .diagnosis p, .evidence p { margin-top: 4px; }
    .diagnosis small, .evidence small { display: block; margin-top: 6px; color: #66758c; }
    .evidence > div { display: flex; justify-content: space-between; gap: 12px; }
    .evidence > div span { color: #0052d9; white-space: nowrap; }
    footer { margin-top: 22px; padding-top: 10px; border-top: 1px solid #d7dce5; color: #66758c; font-size: 10px; }
  </style>
</head>
<body>
  <header>
    <div class="eyebrow">MATERIAL · 已确认分析报告</div>
    <h1>${escapeHtml(record.report.title)}</h1>
    <div class="meta">
      <span>素材：${escapeHtml(record.material.displayName)}</span>
      <span>行业 / 媒体：${industryLabel(record)} · ${mediaLabel(record)}</span>
      <span>确认时间：${escapeHtml(formatLocalTime(record.confirmedAt))}</span>
      <span>产品：${record.productSnapshot ? escapeHtml(record.productSnapshot.name) : '未绑定产品'}</span>
    </div>
  </header>

  <div class="summary">${escapeHtml(record.report.summary)}</div>

  <section>
    <h2>素材评分</h2>
    <div class="overview">
      <div class="total-score"><div><strong>${escapeHtml(score)}</strong><span>素材总评分</span></div></div>
      <div class="score-grid">${dimensions || '<span>暂无可评分维度</span>'}</div>
    </div>
  </section>

  ${listSection('脚本结构', record.report.scriptStructure)}
  ${listSection('镜头拆解', record.report.shotSummary)}
  ${listSection('画面内容', record.report.visualSummary)}
  ${listSection('字幕', record.report.subtitleSummary)}
  ${listSection('口播与声音', record.report.voiceAndSoundSummary)}
  ${listSection('商品卖点 / 游戏玩法', record.report.sellingPoints)}
  ${listSection('情绪', record.report.emotionSummary)}
  ${listSection('CTA', record.report.ctaSummary)}

  <section><h2>素材标签</h2><div class="tag-list">${tags || '<span>暂无标签</span>'}</div></section>
  <section><h2>问题诊断与优化建议</h2>${diagnoses || '<p>暂无问题诊断。</p>'}</section>
  <section><h2>时间证据</h2>${evidence || '<p>暂无可导出的时间证据。</p>'}</section>
  ${listSection('分析局限', record.report.limitations)}

  <footer>
    报告模板 ${escapeHtml(record.rules.templateId)} ${escapeHtml(record.rules.templateVersion)} ·
    评分规则 ${escapeHtml(record.rules.scoringRuleVersion)} ·
    本文件不包含源素材、本地绝对路径、模型密钥、内部提示词或工具日志。
  </footer>
</body>
</html>`;
};

export const createPdfFilename = (displayName: string): string => {
  const withoutExtension = displayName.replace(/\.[^.]+$/, '');
  const printableName = Array.from(withoutExtension, (character) =>
    character.charCodeAt(0) < 32 ? '_' : character).join('');
  const safeName = printableName
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80);
  return `${safeName || '素材'}-分析报告.pdf`;
};
