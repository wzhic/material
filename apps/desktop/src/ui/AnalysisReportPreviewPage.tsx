import React from 'react';
import { Button, Tag } from 'tdesign-react';

import type { AnalysisRuntimeResult } from '../analysis-runtime/types';
import type { AnalysisClaim } from '../analysis-engine';

type ReportData = Extract<AnalysisRuntimeResult, { ok: true }>['data'];

interface AnalysisReportPreviewPageProps {
  data: ReportData;
  materialName: string;
  onBackToConfiguration: () => void;
  onBackToWorkspace: () => void;
}

const formatTime = (milliseconds: number | null): string => {
  if (milliseconds === null) return '区域证据';
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

const ClaimSection = ({ items, title }: { items: AnalysisClaim[]; title: string }): React.JSX.Element => (
  <section className="report-section">
    <h2>{title}</h2>
    {items.length ? (
      <ul className="report-claim-list">
        {items.map((item, index) => (
          <li key={`${title}-${index}`}>
            <span>{item.text}</span>
            <small>{item.evidenceIds.length} 条证据</small>
          </li>
        ))}
      </ul>
    ) : <p className="report-empty">当前证据不足，未形成该项结论。</p>}
  </section>
);

export const AnalysisReportPreviewPage = ({
  data,
  materialName,
  onBackToConfiguration,
  onBackToWorkspace,
}: AnalysisReportPreviewPageProps): React.JSX.Element => {
  const { report } = data;
  const scoreDimensions = report.score.dimensions;
  const maximumTime = Math.max(
    data.media.durationMs,
    ...report.emotion.map((item) => item.timeMs ?? 0),
  );
  const emotionPoints = report.emotion
    .filter((item) => item.timeMs !== null && item.intensity !== null)
    .map((item) => ({
      ...item,
      x: maximumTime > 0 ? ((item.timeMs as number) / maximumTime) * 100 : 0,
      y: 30 - ((item.intensity as number) * 22),
    }));
  const emotionPolyline = emotionPoints.map((item) => `${item.x},${item.y}`).join(' ');

  return (
    <main className="page-shell report-preview-page">
      <header className="report-preview-header">
        <div>
          <button className="text-back" onClick={onBackToWorkspace} type="button">
            ← 返回分析工作区
          </button>
          <span className="eyebrow">待确认报告</span>
          <h1>{report.title}</h1>
          <p>{materialName} · {report.industry === 'apparel' ? '服饰' : '游戏'} · {
            report.mediaKind === 'video' ? '视频' : '图片'
          }</p>
        </div>
        <div className="report-header-actions">
          <Tag theme="warning" variant="light">尚未保存</Tag>
          <Button disabled theme="primary">确认并保存 · 下一阶段接入</Button>
        </div>
      </header>

      <section className="report-hero-card">
        <div
          aria-label={`素材总评分 ${report.score.total ?? '未评分'}`}
          className="report-score-ring"
          style={{
            background: `radial-gradient(circle, white 58%, transparent 60%), conic-gradient(${report.score.total === null ? '#b8c3d1' : '#0052d9'} ${report.score.total ?? 0}%, #e7edf5 0)`,
          }}
        >
          <strong>{report.score.total ?? '—'}</strong>
          <span>素材评分</span>
        </div>
        <div className="report-summary-copy">
          <span>融合判断</span>
          <h2>{report.summary}</h2>
          <p>
            目标场景：{
              report.goalScene === 'purchase_conversion' ? '下单转化'
                : report.goalScene === 'acquisition' ? '游戏拉新'
                  : report.goalScene === 'reactivation' ? '游戏拉活' : '证据不足，暂不判断'
            }
          </p>
          {report.productSnapshot ? (
            <Tag variant="light">产品快照：{report.productSnapshot.name}</Tag>
          ) : <Tag variant="light">未绑定产品</Tag>}
        </div>
        <div className="report-model-audit">
          <span>本次模型</span>
          <strong>{report.model.configurationDisplayName}</strong>
          <small>{report.model.providerId} · {report.model.modelId}</small>
          <small>规则 {report.ruleSnapshot.package.packageVersion}</small>
        </div>
      </section>

      <section className="report-card">
        <div className="report-card-heading">
          <div><span>评分结构</span><h2>各维度表现</h2></div>
          <small>证据不足的维度不按 0 分处理</small>
        </div>
        <div className="score-dimension-grid">
          {scoreDimensions.map((dimension) => (
            <article key={dimension.dimensionId}>
              <div><strong>{dimension.label}</strong><span>{dimension.score ?? '—'}</span></div>
              <div className="score-bar" aria-hidden="true">
                <span style={{ width: `${dimension.score ?? 0}%` }} />
              </div>
              <small>{dimension.status === 'scored' ? `${dimension.evidenceIds.length} 条证据` : '证据不足 / 不适用'}</small>
            </article>
          ))}
        </div>
      </section>

      <section className="report-card">
        <div className="report-card-heading">
          <div><span>素材标签</span><h2>固定标签与动态标签</h2></div>
          <small>仅用于本次报告，不写入标签库</small>
        </div>
        <div className="report-tags">
          {report.tags.map((tag) => (
            <Tag key={`${tag.id}-${tag.label}`} theme={tag.kind === 'fixed' ? 'primary' : undefined} variant="light">
              {tag.label}{tag.kind === 'dynamic' ? ' · 动态' : ''}
            </Tag>
          ))}
          {!report.tags.length ? <span className="report-empty">当前没有可靠标签。</span> : null}
        </div>
      </section>

      {report.mediaKind === 'video' ? (
        <section className="report-card report-emotion-card">
          <div className="report-card-heading">
            <div><span>情绪变化</span><h2>素材表达强度时间线</h2></div>
            <small>这是素材表达判断，不是用户真实情绪测量</small>
          </div>
          {emotionPoints.length ? (
            <div className="report-emotion-chart">
              <svg aria-label="情绪变化曲线" preserveAspectRatio="none" role="img" viewBox="0 0 100 60">
                <line x1="0" x2="100" y1="30" y2="30" />
                <polyline points={emotionPolyline} />
                {emotionPoints.map((item, index) => (
                  <circle cx={item.x} cy={item.y} key={index} r="1.5" />
                ))}
              </svg>
              <div className="emotion-node-list">
                {emotionPoints.map((item, index) => (
                  <span key={index}><strong>{formatTime(item.timeMs)}</strong>{item.text}</span>
                ))}
              </div>
            </div>
          ) : <p className="report-empty">当前没有足够的时间证据生成情绪变化曲线。</p>}
        </section>
      ) : null}

      <div className="report-two-column">
        <section className="report-card">
          <div className="report-card-heading"><div><span>问题诊断</span><h2>主要问题</h2></div></div>
          {report.diagnoses.length ? (
            <ol className="diagnosis-list">
              {report.diagnoses.map((item, index) => (
                <li key={index}>
                  <Tag theme={item.severity === 'high' ? 'danger' : item.severity === 'medium' ? 'warning' : undefined} variant="light">
                    {item.severity === 'high' ? '高' : item.severity === 'medium' ? '中' : '低'}影响
                  </Tag>
                  <strong>{item.problem}</strong>
                  <p>{item.impact}</p>
                  <small>{item.evidenceIds.length} 条证据</small>
                </li>
              ))}
            </ol>
          ) : <p className="report-empty">当前证据没有形成可靠问题诊断。</p>}
        </section>
        <section className="report-card">
          <div className="report-card-heading"><div><span>优化建议</span><h2>下一步动作</h2></div></div>
          {report.recommendations.length ? (
            <ol className="recommendation-list">
              {report.recommendations.map((item, index) => (
                <li key={index}>
                  <span>{index + 1}</span>
                  <div><strong>{item.action}</strong><p>{item.rationale}</p></div>
                </li>
              ))}
            </ol>
          ) : <p className="report-empty">当前没有足够依据生成可执行建议。</p>}
        </section>
      </div>

      <div className="report-detail-grid">
        <ClaimSection items={report.scriptStructure} title={report.mediaKind === 'video' ? '脚本结构' : '视觉叙事结构'} />
        <ClaimSection items={report.shotBreakdown} title="镜头拆解" />
        <ClaimSection items={report.visualContent} title="画面内容" />
        <ClaimSection items={report.subtitleContent} title="字幕" />
        <ClaimSection items={report.voiceAndSound} title="口播与声音" />
        <ClaimSection items={report.productOrGameplay} title="商品 / 玩法" />
        <ClaimSection items={report.sellingPoints} title="卖点" />
        <ClaimSection items={report.cta} title="CTA" />
      </div>

      <section className="report-card">
        <div className="report-card-heading">
          <div><span>证据与局限</span><h2>本次分析边界</h2></div>
          <small>{report.evidence.length} 条结构化证据</small>
        </div>
        <ul className="limitation-list">
          {report.limitations.map((item, index) => <li key={index}>{item}</li>)}
          {!report.limitations.length ? <li>本次没有额外能力局限。</li> : null}
        </ul>
      </section>

      <footer className="report-preview-footer">
        <p>这是一份待确认预览，关闭应用或离开当前会话不会形成正式分析记录。</p>
        <div>
          <Button onClick={onBackToConfiguration} variant="outline">返回配置</Button>
          <Button disabled theme="primary">确认并保存 · 下一阶段接入</Button>
        </div>
      </footer>
    </main>
  );
};
