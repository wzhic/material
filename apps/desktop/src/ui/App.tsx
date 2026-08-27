import React, {
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button, Input, Tag } from 'tdesign-react';

import {
  AnalysisDraft,
  formatFileSize,
  Industry,
  validateDraft,
} from '../analysis/draft';
import { prepareReanalysisDraft } from '../analysis/reanalysis';
import type {
  AnalysisRuntimeProgress,
  AnalysisRuntimeResult,
} from '../analysis-runtime/types';
import {
  CODEX_SUBSCRIPTION_CONFIGURATION_DISPLAY_NAME,
  CODEX_SUBSCRIPTION_CONFIGURATION_ID,
  CodexSubscriptionState,
} from '../codex-subscription/types';
import { MaterialSession } from '../media/types';
import { ModelConfigurationSummary } from '../model/types';
import { ProductListItem } from '../product/types';
import { createConfirmedRecordInput } from '../record/confirmation';
import type { AnalysisRecord, VisibleConversationItem } from '../record/types';
import { AnalysisReportPreviewPage } from './AnalysisReportPreviewPage';
import { ModelSettingsPage } from './ModelSettingsPage';
import { ProductLibraryPage } from './ProductLibraryPage';
import { RecordsPage } from './RecordsPage';
import {
  clampLayoutValue,
  DEFAULT_WORKSPACE_LAYOUT,
  nextTimelineZoom,
  parseWorkspaceLayout,
  serializeWorkspaceLayout,
  WORKSPACE_LAYOUT_STORAGE_KEY,
} from './workspace-layout';
import type { WorkspaceLayout } from './workspace-layout';

type AppPage = 'new-analysis' | 'products' | 'records' | 'report' | 'settings' | 'workspace';

type SelectedMaterial = MaterialSession;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const loadWorkspaceLayout = (): WorkspaceLayout => {
  try {
    return parseWorkspaceLayout(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_WORKSPACE_LAYOUT };
  }
};

const persistWorkspaceLayout = (layout: WorkspaceLayout): void => {
  try {
    window.localStorage.setItem(
      WORKSPACE_LAYOUT_STORAGE_KEY,
      serializeWorkspaceLayout(layout),
    );
  } catch {
    // A denied storage area must not make the analysis workspace unusable.
  }
};

const industryLabel = (industry: Industry): string => {
  if (industry === 'apparel') {
    return '服饰';
  }
  if (industry === 'game') {
    return '游戏';
  }
  return '未选择';
};

const formatTimelineTime = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

const MaterialLogo = (): React.JSX.Element => (
  <div className="brand-mark" aria-hidden="true">
    M
  </div>
);

interface SidebarProps {
  onNavigate: (page: AppPage) => void;
  page: AppPage;
}

const Sidebar = ({ onNavigate, page }: SidebarProps): React.JSX.Element => {
  const currentSection = page === 'workspace' || page === 'report' ? 'new-analysis' : page;

  return (
    <aside className="app-sidebar" aria-label="主导航">
      <div className="brand">
        <MaterialLogo />
        <div>
          <strong>Material</strong>
          <span>素材分析</span>
        </div>
      </div>

      <nav className="nav-list">
        <button
          className={`nav-item ${currentSection === 'new-analysis' ? 'is-active' : ''}`}
          onClick={() => onNavigate('new-analysis')}
          type="button"
        >
          <span className="nav-icon">＋</span>
          <span>新建分析</span>
        </button>
        <button
          className={`nav-item ${currentSection === 'records' ? 'is-active' : ''}`}
          onClick={() => onNavigate('records')}
          type="button"
        >
          <span className="nav-icon">▤</span>
          <span>分析记录</span>
        </button>
        <button
          className={`nav-item ${currentSection === 'products' ? 'is-active' : ''}`}
          onClick={() => onNavigate('products')}
          type="button"
        >
          <span className="nav-icon">◇</span>
          <span>产品库</span>
        </button>
      </nav>

      <div className="sidebar-spacer" />
      <div className="sidebar-status">
        <span className="status-dot" />
        <div>
          <strong>本地优先</strong>
          <span>素材不会复制到应用目录</span>
        </div>
      </div>
      <button
        className={`settings-entry ${currentSection === 'settings' ? 'is-active' : ''}`}
        onClick={() => onNavigate('settings')}
        type="button"
      >
        模型管理
        <span>API Key / Codex</span>
      </button>
    </aside>
  );
};

export interface ModelSelectionOption {
  configurationDisplayName: string;
  configurationId: string;
  label: string;
  modelId: string;
  providerId: string;
  source: 'api-key' | 'codex-subscription';
  value: string;
}

const modelSelectionValue = (
  source: ModelSelectionOption['source'],
  configurationId: string,
  modelId: string,
): string => [source, configurationId, modelId]
  .map((part) => encodeURIComponent(part))
  .join('/');

const codexRateLimitReached = (state: CodexSubscriptionState): boolean =>
  state.rateLimits?.buckets.some((bucket) => (
    bucket.spendControlReached === true
    || bucket.rateLimitReachedType !== null
    || (bucket.primary?.usedPercent ?? 0) >= 100
    || (bucket.secondary?.usedPercent ?? 0) >= 100
  )) ?? false;

export const createAnalysisModelOptions = (
  configurations: ModelConfigurationSummary[],
  codexState: CodexSubscriptionState | null,
): ModelSelectionOption[] => {
  const apiKeyOptions = configurations
    .filter((configuration) => configuration.connectionStatus === 'ready')
    .flatMap((configuration) => configuration.availableModels.map((model) => ({
      configurationDisplayName: configuration.displayName,
      configurationId: configuration.id,
      label: `${configuration.displayName} · ${model.id} · API Key`,
      modelId: model.id,
      providerId: configuration.providerId,
      source: 'api-key' as const,
      value: modelSelectionValue('api-key', configuration.id, model.id),
    })));

  if (
    codexState?.status !== 'ready'
    || codexRateLimitReached(codexState)
  ) {
    return apiKeyOptions;
  }

  const seenModelIds = new Set<string>();
  const codexOptions = codexState.models.flatMap((model) => {
    if (!model.inputModalities.includes('text') || seenModelIds.has(model.id)) return [];
    seenModelIds.add(model.id);
    return [{
      configurationDisplayName: CODEX_SUBSCRIPTION_CONFIGURATION_DISPLAY_NAME,
      configurationId: CODEX_SUBSCRIPTION_CONFIGURATION_ID,
      label: `${model.displayName} · ${model.id} · ${model.modelSlug}`
        + ` · ${model.defaultReasoningEffort} · Codex 订阅 · Beta`,
      modelId: model.id,
      providerId: CODEX_SUBSCRIPTION_CONFIGURATION_ID,
      source: 'codex-subscription' as const,
      value: modelSelectionValue(
        'codex-subscription',
        CODEX_SUBSCRIPTION_CONFIGURATION_ID,
        model.id,
      ),
    }];
  });
  return [...apiKeyOptions, ...codexOptions];
};

export const keepValidModelSelection = (
  current: string,
  options: ModelSelectionOption[],
  codexState: CodexSubscriptionState | null = null,
): string => {
  if (current && options.some((option) => option.value === current)) return current;
  const codexPrefix = `${encodeURIComponent('codex-subscription')}/`;
  if (current.startsWith(codexPrefix) && codexState?.status === 'testing') return current;
  return '';
};

export const codexAnalysisAvailabilityNotice = (
  state: CodexSubscriptionState | null,
  loaded: boolean,
): string | null => {
  if (!loaded) return '正在读取 Codex 订阅状态；不会自动改用其他模型。';
  if (!state || state.status === 'unavailable') {
    return 'Codex 本地运行组件当前不可用；请前往“模型管理”检查后重试。';
  }
  if (state.status === 'signedOut') {
    return 'Codex 尚未连接 ChatGPT 订阅；请前往“模型管理”登录。';
  }
  if (state.status === 'loginPending') {
    return 'Codex 正在等待登录完成；完成后会刷新可用模型。';
  }
  if (state.status === 'limited' || codexRateLimitReached(state)) {
    return 'Codex 订阅额度当前受限；请等待重置后刷新状态。';
  }
  if (state.status === 'error') {
    return 'Codex 订阅状态异常；请前往“模型管理”刷新或重新连接。';
  }
  if (state.status === 'testing') {
    return 'Codex 正在执行测试调用；已有 Codex 草稿选择会暂时保留，但此时不能新选或启动 Codex 模型。';
  }
  if (!state.models.some((model) => model.inputModalities.includes('text'))) {
    return 'Codex 当前没有可用于文本分析的模型；请前往“模型管理”刷新模型目录。';
  }
  return null;
};

export type AnalysisRunUiStatus =
  | 'cancelled'
  | 'cancelling'
  | 'failed'
  | 'running'
  | 'succeeded';

export const isAnalysisInFlight = (status: AnalysisRunUiStatus | undefined): boolean =>
  status === 'running' || status === 'cancelling';

export const requestAnalysisCancellation = (
  status: AnalysisRunUiStatus,
): { shouldCancel: boolean; status: AnalysisRunUiStatus } => (
  status === 'running'
    ? { shouldCancel: true, status: 'cancelling' }
    : { shouldCancel: false, status }
);

export const dispatchAnalysisCancellation = (
  run: { clientRunId: string; status: AnalysisRunUiStatus },
  requestedRunIds: Set<string>,
  publishStatus: (status: AnalysisRunUiStatus) => void,
  cancel: (clientRunId: string) => void,
): boolean => {
  const transition = requestAnalysisCancellation(run.status);
  if (!transition.shouldCancel || requestedRunIds.has(run.clientRunId)) return false;
  requestedRunIds.add(run.clientRunId);
  publishStatus(transition.status);
  cancel(run.clientRunId);
  return true;
};

export const analysisStatusAfterResult = (
  result: { ok: true } | { error: { code: string }; ok: false },
): AnalysisRunUiStatus => {
  if (result.ok) return 'succeeded';
  return result.error.code === 'CANCELLED' ? 'cancelled' : 'failed';
};

type RuntimeReportData = Extract<AnalysisRuntimeResult, { ok: true }>['data'];

interface ActiveAnalysisRun {
  clientRunId: string;
  conversation: VisibleConversationItem[];
  conversionContext: string;
  data?: RuntimeReportData;
  error?: string;
  material: SelectedMaterial;
  materialName: string;
  progress: AnalysisRuntimeProgress[];
  previousReports: RuntimeReportData[];
  queuedGuidance: Array<{
    reference: ConversationReference | null;
    text: string;
  }>;
  sourceRecordId: string | null;
  status: AnalysisRunUiStatus;
}

interface ConversationReference {
  label: string;
  timeMs: number;
}

interface ReanalysisOrigin {
  fingerprintSha256: string;
  materialName: string;
  recordId: string;
  warnings: string[];
}

interface NewAnalysisPageProps {
  analysisBusy: boolean;
  codexSubscriptionLoaded: boolean;
  codexSubscriptionState: CodexSubscriptionState | null;
  conversionContext: string;
  industry: Industry;
  material: SelectedMaterial | null;
  modelId: string;
  modelOptions: ModelSelectionOption[];
  productId: string;
  products: ProductListItem[];
  reanalysisOrigin: ReanalysisOrigin | null;
  onClearReanalysisOrigin: () => void;
  onConversionContextChange: (value: string) => void;
  onIndustryChange: (value: Industry) => void;
  onMaterialChange: (value: SelectedMaterial | null) => void;
  onModelChange: (value: string) => void;
  onProductChange: (value: string) => void;
  onPreviewWorkspace: () => void;
  onStartAnalysis: (material: SelectedMaterial) => void;
}

const NewAnalysisPage = ({
  analysisBusy,
  codexSubscriptionLoaded,
  codexSubscriptionState,
  conversionContext,
  industry,
  material,
  modelId,
  modelOptions,
  productId,
  products,
  reanalysisOrigin,
  onClearReanalysisOrigin,
  onConversionContextChange,
  onIndustryChange,
  onMaterialChange,
  onModelChange,
  onProductChange,
  onPreviewWorkspace,
  onStartAnalysis,
}: NewAnalysisPageProps): React.JSX.Element => {
  const [fileError, setFileError] = useState('');
  const [fileBusy, setFileBusy] = useState(false);
  const selectedModel = modelOptions.find((option) => option.value === modelId);
  const codexAvailabilityNotice = codexAnalysisAvailabilityNotice(
    codexSubscriptionState,
    codexSubscriptionLoaded,
  );
  const draft: AnalysisDraft = {
    industry,
    material: material?.summary ?? null,
    modelId: selectedModel ? modelId : '',
  };
  const validation = validateDraft(draft);
  const compatibleProducts = products.filter((product) => product.industry === industry);
  const selectedProduct = products.find((product) => product.id === productId);

  const handleSelectMaterial = async (): Promise<void> => {
    setFileBusy(true);
    setFileError('');
    const result = await window.materialApi.media.select();
    setFileBusy(false);
    if (!result.ok) {
      setFileError(result.error.message);
      return;
    }
    if (!result.data.cancelled) {
      onMaterialChange(result.data.session);
    }
  };

  const handleInspectMaterial = async (
    nextAction: 'none' | 'preview' | 'start' = 'none',
  ): Promise<void> => {
    if (!material) {
      return;
    }
    setFileBusy(true);
    setFileError('');
    const result = await window.materialApi.media.inspect(material.sessionId);
    setFileBusy(false);
    if (!result.ok) {
      setFileError(result.error.message);
      return;
    }
    onMaterialChange(result.data);
    if (result.data.sourceStatus === 'available') {
      if (nextAction === 'preview') {
        onPreviewWorkspace();
      } else if (nextAction === 'start') {
        onStartAnalysis(result.data);
      }
      return;
    }
    setFileError(
      result.data.sourceStatus === 'mismatch'
        ? '素材内容已发生变化。请选择原文件，或移除后把新文件作为新素材。'
        : '素材已移动、删除或权限失效，请重新定位同一个文件。',
    );
  };

  const handleRelocateMaterial = async (): Promise<void> => {
    if (!material) {
      return;
    }
    setFileBusy(true);
    setFileError('');
    const result = await window.materialApi.media.relocate(material.sessionId);
    setFileBusy(false);
    if (!result.ok) {
      setFileError(result.error.message);
      return;
    }
    if (result.data.cancelled) {
      return;
    }
    onMaterialChange(result.data.session);
    if (result.data.mismatch) {
      setFileError(
        `所选文件与原素材不一致：需要 ${result.data.mismatch.expected.name}，当前选择 ${result.data.mismatch.candidate.name}。旧引用未被替换。`,
      );
    }
  };

  return (
    <main className="page-shell new-analysis-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">单素材分析</span>
          <h1>新建分析</h1>
          <p>选择一个本地视频或图片，确认本次分析上下文。</p>
        </div>
        <Tag theme="primary" variant="light">
          V1 开发中
        </Tag>
      </header>

      {reanalysisOrigin ? (
        <section className="reanalysis-origin-banner" aria-label="重新分析来源">
          <div>
            <strong>从历史记录重新分析：{reanalysisOrigin.materialName}</strong>
            <span>草稿已预填，但不会自动运行，也不会修改原记录。</span>
            {reanalysisOrigin.warnings.map((warning) => <small key={warning}>{warning}</small>)}
          </div>
          <Button onClick={onClearReanalysisOrigin} size="small" variant="outline">取消关联</Button>
        </section>
      ) : null}

      <div className="new-analysis-grid">
        <section className="form-card" aria-labelledby="material-heading">
          <div className="section-heading">
            <div>
              <h2 id="material-heading">源素材</h2>
              <p>单次仅选择一个文件；文件仍保存在原位置。</p>
            </div>
            {material ? (
              <div className="material-actions">
                <Button
                  disabled={fileBusy || analysisBusy}
                  onClick={() => void handleInspectMaterial('none')}
                  size="small"
                  variant="text"
                >
                  检查素材
                </Button>
                <Button
                  disabled={fileBusy || analysisBusy}
                  loading={fileBusy}
                  onClick={() => void handleSelectMaterial()}
                  size="small"
                  variant="outline"
                >
                  重新选择
                </Button>
              </div>
            ) : null}
          </div>

          {material ? (
            <div className="material-preview-card">
              <div className="media-preview">
                {material.summary.kind === 'video' ? (
                  <video
                    aria-label={`视频预览：${material.summary.name}`}
                    controls
                    preload="metadata"
                    src={material.previewUrl}
                  />
                ) : (
                  <img
                    alt={`图片预览：${material.summary.name}`}
                    src={material.previewUrl}
                  />
                )}
              </div>
              <div className="material-meta">
                <Tag theme="success" variant="light">
                  {material.summary.kind === 'video' ? '视频' : '图片'}
                </Tag>
                <strong title={material.summary.name}>{material.summary.name}</strong>
                <span>{formatFileSize(material.summary.size)}</span>
                <span>{material.summary.mimeType}</span>
                <span title={material.summary.fingerprintSha256}>
                  指纹 {material.summary.fingerprintSha256.slice(0, 12)}…
                </span>
                <Tag
                  theme={material.sourceStatus === 'available' ? 'success' : 'warning'}
                  variant="light"
                >
                  {material.sourceStatus === 'available'
                    ? '本地可用'
                    : material.sourceStatus === 'mismatch'
                      ? '文件不匹配'
                      : '需重新定位'}
                </Tag>
              </div>
              <button
                aria-label="移除已选择素材"
                className="remove-material"
                disabled={analysisBusy}
                onClick={() => onMaterialChange(null)}
                type="button"
              >
                ×
              </button>
            </div>
          ) : (
            <button
              className="file-dropzone"
              disabled={fileBusy || analysisBusy}
              onClick={() => void handleSelectMaterial()}
              type="button"
            >
              <span className="upload-glyph">↑</span>
              <strong>{fileBusy ? '正在读取并生成素材指纹…' : '选择本地视频或图片'}</strong>
              <span>支持常见视频、图片格式；暂不支持组图和批量导入</span>
              <span className="choose-file-pill">{fileBusy ? '请稍候' : '浏览文件'}</span>
            </button>
          )}

          {material && material.sourceStatus !== 'available' ? (
            <div className="material-recovery" role="status">
              <span>分析配置已保留，重新定位同一素材后可继续。</span>
              <Button
                disabled={fileBusy || analysisBusy}
                loading={fileBusy}
                onClick={() => void handleRelocateMaterial()}
                size="small"
                variant="outline"
              >
                重新定位
              </Button>
            </div>
          ) : null}

          {fileError ? (
            <div className="inline-message is-error" role="alert">
              {fileError}
            </div>
          ) : null}

          <div className="form-divider" />

          <div className="field-grid">
            <label className="form-field">
              <span className="field-label">
                行业 <em>必填</em>
              </span>
              <select
                aria-label="选择素材行业"
                disabled={analysisBusy}
                onChange={(event) =>
                  onIndustryChange(event.target.value as Industry)
                }
                value={industry}
              >
                <option value="">请选择行业</option>
                <option value="apparel">服饰</option>
                <option value="game">游戏</option>
              </select>
              <small>导入时确定，决定后续模板与评分规则。</small>
            </label>

            <label className="form-field">
              <span className="field-label">关联产品</span>
              <select
                aria-label="关联产品"
                disabled={!industry || analysisBusy}
                onChange={(event) => onProductChange(event.target.value)}
                value={productId}
              >
                <option value="">不绑定产品</option>
                {compatibleProducts.map((product) => (
                  <option key={product.id} value={product.id}>{product.name}</option>
                ))}
              </select>
              <small>
                {!industry
                  ? '请先选择行业。'
                  : compatibleProducts.length
                    ? '绑定始终可选，一次最多选择一个产品。'
                    : '当前行业还没有产品，可前往产品库创建。'}
              </small>
            </label>

            <label className="form-field">
              <span className="field-label">
                分析模型 <em>必填</em>
              </span>
              <select
                aria-label="选择分析模型"
                disabled={analysisBusy}
                onChange={(event) => onModelChange(event.target.value)}
                value={modelId}
              >
                <option value="">
                  {modelOptions.length ? '请选择分析模型' : '暂无可用模型'}
                </option>
                {modelOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <small>
                {selectedModel?.source === 'codex-subscription'
                  ? '将消耗当前账号的 Codex 订阅额度；V1 只发送结构化文本证据，不发送原始素材。'
                  : modelOptions.length
                    ? '模型由你显式选择；同一任务不会静默切换、回退或改为其他计费方式。'
                    : '请前往“模型管理”连接可用的 Codex 订阅，或保存并验证用户自有 Key。'}
              </small>
              {codexAvailabilityNotice ? (
                <small className="model-availability-note" role="status">
                  Codex：{codexAvailabilityNotice} API Key 配置不受影响；系统也不会自动选中或回退使用其他模型。
                </small>
              ) : null}
            </label>

            <label className="form-field field-span-two">
              <span className="field-label">转化依据或关注点</span>
              <Input
                disabled={analysisBusy}
                maxlength={240}
                onChange={onConversionContextChange}
                placeholder="选填，例如：突出轻薄面料与通勤场景"
                value={conversionContext}
              />
              <small>留空时由后续真实分析根据素材判断。</small>
            </label>
          </div>
        </section>

        <aside className="summary-card" aria-labelledby="summary-heading">
          <div className="summary-card-header">
            <span>开始前复核</span>
            <Tag variant="light">本次分析</Tag>
          </div>
          <h2 id="summary-heading">配置摘要</h2>

          <dl className="summary-list">
            <div>
              <dt>素材</dt>
              <dd>{material?.summary.name ?? '尚未选择'}</dd>
            </div>
            <div>
              <dt>类型</dt>
              <dd>
                {material
                  ? material.summary.kind === 'video'
                    ? '视频'
                    : '图片'
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>行业</dt>
              <dd>{industryLabel(industry)}</dd>
            </div>
            <div>
              <dt>产品</dt>
              <dd>{selectedProduct?.name ?? '不绑定产品'}</dd>
            </div>
            <div>
              <dt>模型</dt>
              <dd>{selectedModel?.label ?? '尚未配置'}</dd>
            </div>
          </dl>

          <div className="readiness-panel">
            <strong>{validation.errors.length ? '开始前还需完成' : '分析上下文已就绪'}</strong>
            <ul>
              {validation.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
              {validation.errors.length === 0 ? (
                <li>素材、行业和所选模型已就绪，可以启动本次分析。</li>
              ) : null}
            </ul>
          </div>

          <Button
            block
            disabled={!validation.canStartAnalysis || fileBusy || analysisBusy}
            loading={analysisBusy}
            onClick={() => void handleInspectMaterial('start')}
            theme="primary"
          >
            开始分析
          </Button>
          <Button
            block
            disabled={!validation.canPreviewWorkspace || fileBusy || analysisBusy}
            loading={fileBusy}
            onClick={() => void handleInspectMaterial('preview')}
            variant="outline"
          >
            预览分析工作区
          </Button>
          <p className="summary-footnote">
            分析会调用所选模型并生成待确认预览；只有确认报告后才会保存分析记录。
          </p>
        </aside>
      </div>
    </main>
  );
};

interface WorkspacePageProps {
  conversation: VisibleConversationItem[];
  conversionContext: string;
  industry: Industry;
  layout: WorkspaceLayout;
  material: SelectedMaterial;
  onBack: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onLayoutChange: (updates: Partial<WorkspaceLayout>) => void;
  onResetLayout: () => void;
  onSubmitConversation: (text: string, reference: ConversationReference | null) => void;
  onViewReport: () => void;
  productName: string | null;
  run: ActiveAnalysisRun | null;
}

const WorkspacePage = ({
  conversation,
  conversionContext,
  industry,
  layout,
  material,
  onBack,
  onCancel,
  onRetry,
  onLayoutChange,
  onResetLayout,
  onSubmitConversation,
  onViewReport,
  productName,
  run,
}: WorkspacePageProps): React.JSX.Element => {
  const stageRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [panelTab, setPanelTab] = useState<'conversation' | 'progress'>('conversation');
  const [conversationText, setConversationText] = useState('');
  const [conversationReference, setConversationReference] = useState<ConversationReference | null>(null);
  const [playbackDurationMs, setPlaybackDurationMs] = useState(0);
  const [playbackTimeMs, setPlaybackTimeMs] = useState(0);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const [timelineZoom, setTimelineZoom] = useState(100);
  const report = run?.data?.report;
  const durationMs = Math.max(run?.data?.media.durationMs ?? playbackDurationMs, 1);
  const evidenceById = new Map(report?.evidence.map((item) => [item.evidenceId, item]) ?? []);
  const emotionPoints = (report?.emotion ?? [])
    .filter((item) => item.timeMs !== null && item.intensity !== null)
    .map((item) => ({
      ...item,
      x: ((item.timeMs as number) / durationMs) * 1000,
      y: 32 - ((item.intensity as number) * 22),
    }));
  const emotionPath = emotionPoints.map((item) => `${item.x},${item.y}`).join(' ');
  const runtimeLabel = run?.status === 'running'
    ? '分析运行中'
    : run?.status === 'cancelling'
      ? '正在取消分析'
    : run?.status === 'succeeded'
      ? '报告待确认'
      : run?.status === 'cancelled'
        ? '分析已取消'
        : run?.status === 'failed'
          ? '分析未完成'
          : '工作区预览';
  const conversationEnabled = Boolean(
    run && (run.status === 'succeeded' || (run.status === 'running' && !run.data)),
  );
  const selectedEvidenceText = selectedEvidenceId
    ? evidenceById.get(selectedEvidenceId)?.text ?? null
    : null;

  const seekToTime = (
    timeMs: number,
    label: string,
    evidenceId: string | null,
  ): void => {
    const nextTime = clamp(timeMs, 0, durationMs);
    if (videoRef.current) {
      videoRef.current.currentTime = nextTime / 1_000;
    }
    setPlaybackTimeMs(nextTime);
    setSelectedEvidenceId(evidenceId);
    setConversationReference({ label, timeMs: nextTime });
  };

  const seekFromTimeline = (event: React.MouseEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest('button')) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) {
      return;
    }
    const percentage = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    seekToTime(percentage * durationMs, '时间轴位置', null);
  };

  const timelineTrack = (
    tracks: Array<'audio' | 'ocr' | 'shot' | 'speech'>,
  ): React.JSX.Element => {
    const entries = report?.timeline.filter((item) => tracks.includes(item.track)) ?? [];
    if (!entries.length) {
      return <div className="empty-track"><span>当前没有可靠的时间证据</span></div>;
    }
    return (
      <div className={`populated-track is-${tracks.join('-')}`}>
        {entries.map((item) => {
          const left = clamp((item.startMs / durationMs) * 100, 0, 100);
          const end = item.endMs ?? item.startMs + Math.max(500, durationMs * 0.02);
          const width = clamp(((end - item.startMs) / durationMs) * 100, 1.5, 100 - left);
          return (
            <button
              aria-label={`引用 ${formatTimelineTime(item.startMs)} ${evidenceById.get(item.evidenceId)?.text ?? item.track}`}
              className={selectedEvidenceId === item.evidenceId ? 'is-selected' : ''}
              key={item.evidenceId}
              onClick={() => seekToTime(
                item.startMs,
                evidenceById.get(item.evidenceId)?.text ?? item.track,
                item.evidenceId,
              )}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={evidenceById.get(item.evidenceId)?.text ?? item.evidenceId}
              type="button"
            >
              {evidenceById.get(item.evidenceId)?.text ?? item.track}
            </button>
          );
        })}
      </div>
    );
  };

  const beginHorizontalResize = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    event.preventDefault();

    const move = (moveEvent: PointerEvent): void => {
      const percentage = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      onLayoutChange({ mediaPercent: clampLayoutValue('mediaPercent', percentage) });
    };
    const stop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  const beginVerticalResize = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const rect = workspaceRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    event.preventDefault();

    const move = (moveEvent: PointerEvent): void => {
      onLayoutChange({
        timelineHeight: clampLayoutValue(
          'timelineHeight',
          Math.min(rect.bottom - moveEvent.clientY, rect.height * 0.55),
        ),
      });
    };
    const stop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  const resizeHorizontalByKeyboard = (
    event: KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      onLayoutChange({
        mediaPercent: clampLayoutValue(
          'mediaPercent',
          layout.mediaPercent + (event.key === 'ArrowLeft' ? -2 : 2),
        ),
      });
    }
  };

  const resizeVerticalByKeyboard = (
    event: KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      onLayoutChange({
        timelineHeight: clampLayoutValue(
          'timelineHeight',
          layout.timelineHeight + (event.key === 'ArrowUp' ? 16 : -16),
        ),
      });
    }
  };

  const submitConversation = (): void => {
    const text = conversationText.trim();
    if (!text || !run || !conversationEnabled) return;
    onSubmitConversation(text, conversationReference);
    setConversationText('');
    setConversationReference(null);
  };

  return (
    <main
      ref={workspaceRef}
      className="workspace-page"
      style={{
        gridTemplateRows: material.summary.kind === 'video'
          ? `minmax(300px, 1fr) 8px ${layout.timelineHeight}px`
          : 'minmax(300px, 1fr)',
      }}
    >
      <section
        ref={stageRef}
        className="workspace-stage"
        style={{ gridTemplateColumns: `${layout.mediaPercent}% 8px minmax(300px, 1fr)` }}
      >
        <div className="source-panel">
          <div className="workspace-toolbar">
            <Button disabled={isAnalysisInFlight(run?.status)} onClick={onBack} size="small" variant="text">
              ← 返回配置
            </Button>
            <div className="workspace-title">
              <strong>{material.summary.name}</strong>
              <span>
                {industryLabel(industry)} ·{' '}
                {material.summary.kind === 'video' ? '视频' : '图片'}
                {productName ? ` · ${productName}` : ''}
              </span>
            </div>
            <Tag
              theme={run?.status === 'succeeded' ? 'success' : run?.status === 'failed' ? 'danger' : 'warning'}
              variant="light"
            >
              {runtimeLabel}
            </Tag>
          </div>
          <div className="source-viewer">
            {material.summary.kind === 'video' ? (
              <video
                controls
                onLoadedMetadata={(event) => {
                  const nextDuration = event.currentTarget.duration * 1_000;
                  const nextTime = event.currentTarget.currentTime * 1_000;
                  setPlaybackDurationMs(Number.isFinite(nextDuration) ? Math.max(0, nextDuration) : 0);
                  setPlaybackTimeMs(Number.isFinite(nextTime) ? Math.max(0, nextTime) : 0);
                }}
                onTimeUpdate={(event) => {
                  const nextTime = event.currentTarget.currentTime * 1_000;
                  if (!Number.isFinite(nextTime)) return;
                  const boundedTime = Math.max(0, nextTime);
                  setPlaybackTimeMs(boundedTime);
                  setSelectedEvidenceId(
                    report?.timeline.find((item) => (
                      boundedTime >= item.startMs
                      && boundedTime <= (item.endMs ?? item.startMs + 500)
                    ))?.evidenceId ?? null,
                  );
                }}
                preload="metadata"
                ref={videoRef}
                src={material.previewUrl}
              />
            ) : (
              <img alt={material.summary.name} src={material.previewUrl} />
            )}
          </div>
          <div className="viewer-meta">
            <span>源素材可播放</span>
            <span>{formatFileSize(material.summary.size)}</span>
            <span>未复制到应用目录</span>
            {run?.status === 'running' ? <span>解析与模型调用进行中</span> : null}
            {run?.status === 'cancelling' ? <span>正在请求停止本次分析</span> : null}
          </div>
        </div>

        <div
          aria-label="调整播放器与对话区域宽度"
          aria-orientation="vertical"
          aria-valuemax={72}
          aria-valuemin={38}
          aria-valuenow={Math.round(layout.mediaPercent)}
          className="panel-resizer is-horizontal"
          onKeyDown={resizeHorizontalByKeyboard}
          onPointerDown={beginHorizontalResize}
          role="separator"
          tabIndex={0}
        >
          <span />
        </div>

        <aside className="conversation-panel">
          <div className="panel-tabs" role="tablist">
            <button
              aria-selected={panelTab === 'conversation'}
              onClick={() => setPanelTab('conversation')}
              role="tab"
              type="button"
            >
              对话分析
            </button>
            <button
              aria-selected={panelTab === 'progress'}
              onClick={() => setPanelTab('progress')}
              role="tab"
              type="button"
            >
              分析进度
            </button>
          </div>
          {panelTab === 'conversation' ? (
            <div className="conversation-content" role="tabpanel">
              <section className="conversation-runtime-summary">
                <div className={`empty-orbit ${run?.status === 'running' ? 'is-running' : ''}`} aria-hidden="true"><span /></div>
                <div>
                  <h2>{run ? runtimeLabel : '分析工作区已就绪'}</h2>
                  <p>
                    {run?.status === 'running'
                      ? run.progress[run.progress.length - 1]?.message ?? '正在准备分析'
                      : run?.status === 'cancelling'
                        ? '取消请求已提交，正在等待当前分析安全停止。请勿重复操作。'
                      : run?.status === 'succeeded'
                        ? report?.summary ?? '待确认报告已经生成。'
                        : run?.status === 'failed' || run?.status === 'cancelled'
                          ? run.error ?? '本次分析没有完成，配置和本地素材仍然保留。'
                          : '当前为工作区预览，不调用模型，也不会生成或保存分析结果。'}
                  </p>
                </div>
              </section>
              {conversionContext ? (
                <div className="context-chip"><span>初始关注点</span><strong>{conversionContext}</strong></div>
              ) : null}
              <div className="conversation-messages" aria-live="polite">
                {conversation.map((item, index) => (
                  <article className={`conversation-message is-${item.role}`} key={`${item.role}-${index}`}>
                    <span>{item.role === 'user' ? '你' : '分析助手'}</span>
                    <p>{item.text}</p>
                    {item.timeReferenceMs !== null ? <small>引用 {formatTimelineTime(item.timeReferenceMs)}</small> : null}
                  </article>
                ))}
                {!conversation.length ? <p className="conversation-placeholder">可补充关注点，或点击时间轴片段后带引用提问。</p> : null}
              </div>
              <div className="runtime-actions">
                {isAnalysisInFlight(run?.status) ? (
                  <Button
                    disabled={run?.status === 'cancelling'}
                    onClick={onCancel}
                    size="small"
                    variant="outline"
                  >
                    {run?.status === 'cancelling' ? '正在取消…' : '取消分析'}
                  </Button>
                ) : null}
                {run?.status === 'failed' || run?.status === 'cancelled' ? <Button onClick={onRetry} size="small" theme="primary">使用当前配置重试</Button> : null}
                {run?.status === 'succeeded' ? <Button onClick={onViewReport} size="small" theme="primary">查看待确认报告</Button> : null}
              </div>
            </div>
          ) : (
            <div className="runtime-progress-panel" role="tabpanel">
              <div className="runtime-progress-heading">
                <div><span>本次运行</span><strong>{runtimeLabel}</strong></div>
                {isAnalysisInFlight(run?.status) ? (
                  <Button
                    disabled={run?.status === 'cancelling'}
                    onClick={onCancel}
                    size="small"
                    variant="outline"
                  >
                    {run?.status === 'cancelling' ? '正在取消…' : '取消'}
                  </Button>
                ) : null}
              </div>
              {run?.progress.length ? (
                <ol className="runtime-progress-list">
                  {run.progress.map((item, index) => (
                    <li className={index === run.progress.length - 1 ? 'is-current' : ''} key={`${item.stage}-${index}`}>
                      <span />
                      <div><strong>{item.message}</strong><small>{item.stage}</small></div>
                    </li>
                  ))}
                </ol>
              ) : <p className="runtime-progress-empty">启动真实分析后，这里会显示工具和模型的阶段进度。</p>}
              {run?.status === 'failed' || run?.status === 'cancelled' ? (
                <div className="runtime-recovery">
                  <p>{run.error}</p>
                  <Button onClick={onRetry} size="small" theme="primary">重试</Button>
                </div>
              ) : null}
            </div>
          )}
          <div className="conversation-composer">
            {conversationReference ? (
              <div className="conversation-reference-chip">
                <span>{formatTimelineTime(conversationReference.timeMs)} · {conversationReference.label}</span>
                <button aria-label="移除时间引用" onClick={() => setConversationReference(null)} type="button">×</button>
              </div>
            ) : null}
            <textarea
              aria-label="补充分析关注点"
              disabled={!conversationEnabled}
              maxLength={2_000}
              onChange={(event) => setConversationText(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  submitConversation();
                }
              }}
              placeholder={run?.status === 'running'
                ? '补充内容将在当前解析完成后生成新版报告…'
                : run?.status === 'cancelling'
                  ? '正在取消本次分析，暂时不能补充内容…'
                  : '补充关注点；提交会再次调用当前模型…'}
              value={conversationText}
            />
            <Button
              disabled={!conversationText.trim() || !conversationEnabled}
              onClick={submitConversation}
              size="small"
              theme="primary"
            >
              {run?.status === 'running' ? '加入本次分析' : '补充并重新分析'}
            </Button>
          </div>
        </aside>
      </section>

      {material.summary.kind === 'video' ? (
        <>
          <div
            aria-label="调整时间轴区域高度"
            aria-orientation="horizontal"
            aria-valuemax={440}
            aria-valuemin={220}
            aria-valuenow={Math.round(layout.timelineHeight)}
            className="panel-resizer is-vertical"
            onKeyDown={resizeVerticalByKeyboard}
            onPointerDown={beginVerticalResize}
            role="separator"
            tabIndex={0}
          >
            <span />
          </div>

          <section className="timeline-panel" aria-label="分析时间轴">
            <div className="timeline-header">
              <div>
                <strong>素材时间轴</strong>
                <span>
                  {formatTimelineTime(playbackTimeMs)} / {formatTimelineTime(durationMs)}
                  {' · '}
                  {report
                    ? `${report.timeline.length} 条时间证据`
                    : isAnalysisInFlight(run?.status)
                      ? runtimeLabel
                      : '等待真实解析结果'}
                  {selectedEvidenceText ? ` · 当前片段 ${selectedEvidenceText}` : ''}
                </span>
              </div>
              <div className="timeline-actions">
                <button
                  aria-label="缩小时间轴"
                  disabled={timelineZoom === 100}
                  onClick={() => setTimelineZoom((current) => nextTimelineZoom(current, 'out'))}
                  type="button"
                >
                  －
                </button>
                <span>{timelineZoom}%</span>
                <button
                  aria-label="放大时间轴"
                  disabled={timelineZoom === 400}
                  onClick={() => setTimelineZoom((current) => nextTimelineZoom(current, 'in'))}
                  type="button"
                >
                  ＋
                </button>
                <Button
                  onClick={() => {
                    setTimelineZoom(100);
                    if (timelineScrollRef.current) timelineScrollRef.current.scrollLeft = 0;
                  }}
                  size="small"
                  variant="outline"
                >
                  适应全片
                </Button>
                <Button onClick={onResetLayout} size="small" variant="text">
                  恢复默认布局
                </Button>
              </div>
            </div>
            <div className="timeline-chart" ref={timelineScrollRef}>
              <div className="timeline-labels">
                <span>情绪变化</span>
                <span>镜头</span>
                <span>画面</span>
                <span>字幕</span>
                <span>口播 / 声音</span>
                <span>分析标签</span>
              </div>
              <div
                className="timeline-tracks"
                onClick={seekFromTimeline}
                style={{ width: `${timelineZoom}%` }}
              >
                <div className="ruler">
                  {[0, 0.25, 0.5, 0.75, 1].map((position) => (
                    <span key={position}>{formatTimelineTime(durationMs * position)}</span>
                  ))}
                </div>
                <div className="emotion-track">
                  <svg
                    aria-label={emotionPoints.length ? '素材表达强度情绪曲线' : '情绪曲线等待真实分析数据'}
                    preserveAspectRatio="none"
                    role="img"
                    viewBox="0 0 1000 64"
                  >
                    {emotionPoints.length ? (
                      <polyline points={emotionPath} />
                    ) : (
                      <path d="M0 38 C150 38 210 38 330 38 S560 38 710 38 S900 38 1000 38" />
                    )}
                  </svg>
                  {emotionPoints.map((item, index) => (
                    <button
                      aria-label={`定位到 ${formatTimelineTime(item.timeMs as number)} ${item.text}`}
                      className="emotion-timeline-node"
                      key={`${item.timeMs}-${index}`}
                      onClick={() => seekToTime(
                        item.timeMs as number,
                        item.text,
                        item.evidenceIds[0] ?? null,
                      )}
                      style={{
                        left: `${clamp(((item.timeMs as number) / durationMs) * 100, 0, 100)}%`,
                        top: `${clamp((item.y / 64) * 100, 0, 100)}%`,
                      }}
                      title={item.text}
                      type="button"
                    />
                  ))}
                  {!emotionPoints.length ? <span>未生成可靠情绪结论</span> : null}
                </div>
                {timelineTrack(['shot'])}
                <div className="empty-track"><span>代表帧仅证明采样位置，不推断画面语义</span></div>
                {timelineTrack(['ocr'])}
                {timelineTrack(['speech', 'audio'])}
                <div className="empty-track"><span>{report?.tags.length ? '报告标签暂不具备可靠时间定位' : '当前没有可靠分析标签'}</span></div>
                <div
                  aria-hidden="true"
                  className="timeline-playhead"
                  style={{ left: `${clamp((playbackTimeMs / durationMs) * 100, 0, 100)}%` }}
                >
                  <span />
                </div>
              </div>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
};

export const App = (): React.JSX.Element => {
  const [page, setPage] = useState<AppPage>('new-analysis');
  const [material, setMaterial] = useState<SelectedMaterial | null>(null);
  const [industry, setIndustry] = useState<Industry>('');
  const [modelId, setModelId] = useState('');
  const [conversionContext, setConversionContext] = useState('');
  const [modelConfigurations, setModelConfigurations] = useState<ModelConfigurationSummary[]>([]);
  const [modelConfigurationsLoaded, setModelConfigurationsLoaded] = useState(false);
  const [codexSubscriptionState, setCodexSubscriptionState] = useState<CodexSubscriptionState | null>(null);
  const [codexSubscriptionLoaded, setCodexSubscriptionLoaded] = useState(false);
  const [products, setProducts] = useState<ProductListItem[]>([]);
  const [productId, setProductId] = useState('');
  const [activeRun, setActiveRun] = useState<ActiveAnalysisRun | null>(null);
  const activeRunRef = useRef<ActiveAnalysisRun | null>(null);
  const cancellationRequestedRunIdsRef = useRef(new Set<string>());
  const [confirmingReport, setConfirmingReport] = useState(false);
  const [confirmReportError, setConfirmReportError] = useState('');
  const [previewVersionIndex, setPreviewVersionIndex] = useState(0);
  const [reanalysisOrigin, setReanalysisOrigin] = useState<ReanalysisOrigin | null>(null);
  const [recordToOpenId, setRecordToOpenId] = useState<string | null>(null);
  const [sourceRecordId, setSourceRecordId] = useState<string | null>(null);
  const appFrameRef = useRef<HTMLDivElement>(null);
  const [workspaceLayout, setWorkspaceLayout] = useState<WorkspaceLayout>(loadWorkspaceLayout);

  useEffect(() => persistWorkspaceLayout(workspaceLayout), [workspaceLayout]);

  const updateWorkspaceLayout = useCallback((updates: Partial<WorkspaceLayout>): void => {
    setWorkspaceLayout((current) => ({
      mediaPercent: clampLayoutValue(
        'mediaPercent',
        updates.mediaPercent ?? current.mediaPercent,
      ),
      sidebarWidth: clampLayoutValue(
        'sidebarWidth',
        updates.sidebarWidth ?? current.sidebarWidth,
      ),
      timelineHeight: clampLayoutValue(
        'timelineHeight',
        updates.timelineHeight ?? current.timelineHeight,
      ),
    }));
  }, []);

  const resetWorkspaceLayout = useCallback((): void => {
    setWorkspaceLayout({ ...DEFAULT_WORKSPACE_LAYOUT });
  }, []);

  const beginSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = appFrameRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    const move = (moveEvent: PointerEvent): void => {
      updateWorkspaceLayout({
        sidebarWidth: clampLayoutValue('sidebarWidth', moveEvent.clientX - rect.left),
      });
    };
    const stop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  }, [updateWorkspaceLayout]);

  const resizeSidebarByKeyboard = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    updateWorkspaceLayout({
      sidebarWidth: workspaceLayout.sidebarWidth + (event.key === 'ArrowLeft' ? -8 : 8),
    });
  }, [updateWorkspaceLayout, workspaceLayout.sidebarWidth]);

  const updateActiveRun = useCallback((
    updater: (current: ActiveAnalysisRun | null) => ActiveAnalysisRun | null,
  ): ActiveAnalysisRun | null => {
    const next = updater(activeRunRef.current);
    activeRunRef.current = next;
    setActiveRun(next);
    return next;
  }, []);

  const refreshProducts = useCallback(async (): Promise<void> => {
    const result = await window.materialApi.products.list({ limit: 500 });
    if (result.ok) {
      setProducts(result.data.items);
      setProductId((current) =>
        current && result.data.items.some((product) => product.id === current) ? current : '',
      );
    }
  }, []);

  const refreshModelConfigurations = useCallback(async (): Promise<void> => {
    const result = await window.materialApi.models.getSettings();
    if (result.ok) {
      setModelConfigurations(result.data.configurations);
    }
    setModelConfigurationsLoaded(true);
  }, []);

  const refreshCodexSubscription = useCallback(async (): Promise<void> => {
    const result = await window.materialApi.codexSubscription.getState();
    if (result.ok) {
      setCodexSubscriptionState(result.data);
    } else {
      setCodexSubscriptionState(null);
    }
    setCodexSubscriptionLoaded(true);
  }, []);

  useEffect(() => {
    void refreshProducts();
    void refreshModelConfigurations();
    void refreshCodexSubscription();
  }, [refreshCodexSubscription, refreshModelConfigurations, refreshProducts]);

  useEffect(() => {
    const removeStateListener = window.materialApi.codexSubscription.onStateChanged((state) => {
      setCodexSubscriptionState(state);
      setCodexSubscriptionLoaded(true);
    });
    const removeRateLimitsListener = window.materialApi.codexSubscription.onRateLimitsChanged(
      (rateLimits) => {
        setCodexSubscriptionState((current) => current ? { ...current, rateLimits } : current);
      },
    );
    const removeLoginListener = window.materialApi.codexSubscription.onLoginCompleted(() => {
      void refreshCodexSubscription();
    });
    return () => {
      removeLoginListener();
      removeRateLimitsListener();
      removeStateListener();
    };
  }, [refreshCodexSubscription]);

  const modelOptions = useMemo<ModelSelectionOption[]>(() =>
    createAnalysisModelOptions(modelConfigurations, codexSubscriptionState),
  [codexSubscriptionState, modelConfigurations]);

  useEffect(() => {
    if (!codexSubscriptionLoaded || !modelConfigurationsLoaded) return;
    setModelId((current) => keepValidModelSelection(
      current,
      modelOptions,
      codexSubscriptionState,
    ));
  }, [codexSubscriptionLoaded, codexSubscriptionState, modelConfigurationsLoaded, modelOptions]);

  useEffect(() => {
    const sessionId = material?.sessionId;
    return () => {
      if (sessionId) {
        void window.materialApi.media.release(sessionId);
      }
    };
  }, [material?.sessionId]);

  useEffect(() => window.materialApi.analysis.onProgress((progress) => {
    updateActiveRun((current) => {
      if (!current || current.clientRunId !== progress.clientRunId) return current;
      const previous = current.progress[current.progress.length - 1];
      if (previous?.stage === progress.stage && previous.message === progress.message) return current;
      return { ...current, progress: [...current.progress, progress] };
    });
  }), [updateActiveRun]);

  const runRefinement = useCallback(async (
    guidance: string,
    reference: ConversationReference | null,
  ): Promise<void> => {
    const source = activeRunRef.current;
    if (!source?.data || source.status !== 'succeeded') return;
    const sourceData = source.data;
    const sourceClientRunId = source.clientRunId;
    const clientRunId = crypto.randomUUID();
    updateActiveRun((current) => current ? {
      ...current,
      clientRunId,
      error: undefined,
      progress: [],
      queuedGuidance: [],
      status: 'running',
    } : current);
    const result = await window.materialApi.analysis.refine({
      clientRunId,
      guidance,
      referenceTimeMs: reference?.timeMs ?? null,
      sourceClientRunId,
    });
    cancellationRequestedRunIdsRef.current.delete(clientRunId);
    const current = activeRunRef.current;
    if (!current || current.clientRunId !== clientRunId) return;
    if (!result.ok) {
      updateActiveRun((latest) => latest ? {
        ...latest,
        clientRunId: sourceClientRunId,
        conversation: [
          ...latest.conversation,
          {
            role: 'assistant',
            text: `重新分析未完成：${result.error.message}。旧预览仍可确认或再次提交反馈。`,
            timeReferenceMs: reference?.timeMs ?? null,
          },
        ],
        data: sourceData,
        error: result.error.message,
        status: 'succeeded',
      } : latest);
      return;
    }
    const nextIndex = source.previousReports.length + 1;
    const nextConversionContext = [source.conversionContext, guidance]
      .filter(Boolean)
      .join('\n')
      .slice(-2_000);
    updateActiveRun((latest) => latest ? {
      ...latest,
      conversation: [
        ...latest.conversation,
        {
          role: 'assistant',
          text: '已按你补充的关注点生成新版报告；原预览仍保留在当前会话中供比较。',
          timeReferenceMs: reference?.timeMs ?? null,
        },
      ],
      conversionContext: nextConversionContext,
      data: result.data,
      previousReports: [...source.previousReports, sourceData],
      status: 'succeeded',
    } : latest);
    setPreviewVersionIndex(nextIndex);
  }, [updateActiveRun]);

  const handleStartAnalysis = useCallback(async (
    verifiedMaterial: SelectedMaterial,
  ): Promise<void> => {
    const selectedModel = modelOptions.find((option) => option.value === modelId);
    if (!selectedModel || !industry || verifiedMaterial.sourceStatus !== 'available') return;
    const clientRunId = crypto.randomUUID();
    updateActiveRun(() => ({
      clientRunId,
      conversation: [],
      conversionContext,
      material: verifiedMaterial,
      materialName: verifiedMaterial.summary.name,
      previousReports: [],
      progress: [],
      queuedGuidance: [],
      sourceRecordId,
      status: 'running',
    }));
    setPreviewVersionIndex(0);
    setPage('workspace');
    const result = await window.materialApi.analysis.start({
      clientRunId,
      configurationDisplayName: selectedModel.configurationDisplayName,
      configurationId: selectedModel.configurationId,
      conversionContext,
      industry,
      modelId: selectedModel.modelId,
      productId: productId || null,
      sessionId: verifiedMaterial.sessionId,
    });
    cancellationRequestedRunIdsRef.current.delete(clientRunId);
    const current = activeRunRef.current;
    if (!current || current.clientRunId !== clientRunId) return;
    if (!result.ok) {
      updateActiveRun((latest) => latest ? {
        ...latest,
        error: result.error.message,
        status: analysisStatusAfterResult(result),
      } : latest);
      return;
    }
    const queued = [...current.queuedGuidance];
    updateActiveRun((latest) => latest ? {
      ...latest,
      data: result.data,
      queuedGuidance: [],
      status: analysisStatusAfterResult(result),
    } : latest);
    if (queued.length) {
      const reference = queued[queued.length - 1]?.reference ?? null;
      await runRefinement(queued.map((item) => item.text).join('\n'), reference);
      setPage('report');
      return;
    }
    setPage('report');
  }, [conversionContext, industry, modelId, modelOptions, productId, runRefinement, sourceRecordId, updateActiveRun]);

  const handleSubmitConversation = useCallback((
    text: string,
    reference: ConversationReference | null,
  ): void => {
    const current = activeRunRef.current;
    if (!current || !['running', 'succeeded'].includes(current.status)) return;
    const userMessage: VisibleConversationItem = {
      role: 'user',
      text,
      timeReferenceMs: reference?.timeMs ?? null,
    };
    if (current.status === 'running') {
      updateActiveRun((latest) => latest ? {
        ...latest,
        conversation: [
          ...latest.conversation,
          userMessage,
          {
            role: 'assistant',
            text: '已接收该关注点；当前素材解析完成后会自动生成新版报告。',
            timeReferenceMs: reference?.timeMs ?? null,
          },
        ],
        queuedGuidance: [...latest.queuedGuidance, { reference, text }],
      } : latest);
      return;
    }
    updateActiveRun((latest) => latest ? {
      ...latest,
      conversation: [...latest.conversation, userMessage],
    } : latest);
    void runRefinement(text, reference);
  }, [runRefinement, updateActiveRun]);

  const handleCancelAnalysis = useCallback((): void => {
    const current = activeRunRef.current;
    if (!current) return;
    dispatchAnalysisCancellation(
      current,
      cancellationRequestedRunIdsRef.current,
      (status) => {
        const next = {
          ...current,
          error: undefined,
          status,
        };
        activeRunRef.current = next;
        setActiveRun(next);
      },
      (requestedClientRunId) => {
        void window.materialApi.analysis.cancel(requestedClientRunId).catch(() => {
          cancellationRequestedRunIdsRef.current.delete(requestedClientRunId);
          updateActiveRun((latest) => (
            latest?.clientRunId === requestedClientRunId && latest.status === 'cancelling'
              ? {
                ...latest,
                error: '取消请求未能送达，分析仍在运行；可再次尝试取消。',
                status: 'running',
              }
              : latest
          ));
        });
      },
    );
  }, [updateActiveRun]);

  const handleConfirmReport = useCallback(async (): Promise<void> => {
    if (!activeRun?.data || activeRun.status !== 'succeeded' || confirmingReport) return;
    setConfirmingReport(true);
    setConfirmReportError('');
    const input = createConfirmedRecordInput(
      activeRun.data,
      activeRun.material,
      activeRun.conversionContext,
      {
        sourceRecordId: activeRun.sourceRecordId,
        visibleConversation: activeRun.conversation,
      },
    );
    const result = await window.materialApi.records.confirm(
      input,
      activeRun.material.sessionId,
    );
    setConfirmingReport(false);
    if (!result.ok) {
      setConfirmReportError(result.error.message);
      return;
    }
    updateActiveRun(() => null);
    setConfirmReportError('');
    setReanalysisOrigin(null);
    setSourceRecordId(null);
    setRecordToOpenId(result.data.id);
    setPage('records');
  }, [activeRun, confirmingReport, updateActiveRun]);

  const leaveReportForConfiguration = useCallback((): void => {
    if (confirmingReport || isAnalysisInFlight(activeRunRef.current?.status)) return;
    if (!window.confirm('当前报告尚未保存，返回配置将放弃这份预览。是否继续？')) return;
    updateActiveRun(() => null);
    setConfirmReportError('');
    setPage('new-analysis');
  }, [confirmingReport, updateActiveRun]);

  const navigate = useCallback((nextPage: AppPage): void => {
    if (page === 'report' && activeRun?.data && nextPage !== 'report') {
      if (confirmingReport || isAnalysisInFlight(activeRun.status)) return;
      if (!window.confirm('当前报告尚未保存，离开将放弃这份预览。是否继续？')) return;
      updateActiveRun(() => null);
      setConfirmReportError('');
    }
    setRecordToOpenId(null);
    if (nextPage === 'new-analysis' && page === 'records') {
      setReanalysisOrigin(null);
      setSourceRecordId(null);
    }
    setPage(nextPage);
  }, [activeRun?.data, activeRun?.status, confirmingReport, page, updateActiveRun]);

  const handleRecordReanalysis = useCallback((
    record: AnalysisRecord,
    selectedMaterial: MaterialSession,
  ): void => {
    const selection = prepareReanalysisDraft(record, modelOptions, products);
    updateActiveRun(() => null);
    setMaterial(selectedMaterial);
    setIndustry(selection.industry);
    setConversionContext(selection.conversionContext);
    setModelId(selection.modelSelectionValue);
    setProductId(selection.productId);
    setSourceRecordId(selection.sourceRecordId);
    setReanalysisOrigin({
      fingerprintSha256: record.material.fingerprintSha256 as string,
      materialName: record.material.displayName,
      recordId: record.id,
      warnings: selection.warnings,
    });
    setRecordToOpenId(null);
    setPage('new-analysis');
  }, [modelOptions, products, updateActiveRun]);

  const createBlankAnalysis = useCallback((): void => {
    updateActiveRun(() => null);
    setReanalysisOrigin(null);
    setSourceRecordId(null);
    setRecordToOpenId(null);
    setPage('new-analysis');
  }, [updateActiveRun]);

  const reportVersions = activeRun?.data
    ? [...activeRun.previousReports, activeRun.data]
    : [];
  const selectedReportData = reportVersions[
    Math.min(previewVersionIndex, Math.max(0, reportVersions.length - 1))
  ];

  const content = useMemo(() => {
    if (page === 'report' && activeRun?.data && selectedReportData) {
      const latestIndex = reportVersions.length - 1;
      return (
        <AnalysisReportPreviewPage
          confirmError={confirmReportError}
          confirming={confirmingReport}
          data={selectedReportData}
          isLatestVersion={previewVersionIndex === latestIndex}
          materialName={activeRun.materialName}
          onBackToConfiguration={leaveReportForConfiguration}
          onBackToWorkspace={() => setPage('workspace')}
          onConfirm={() => void handleConfirmReport()}
          onPreviewVersionChange={setPreviewVersionIndex}
          onReanalyze={(guidance) => handleSubmitConversation(guidance, null)}
          previewVersionCount={reportVersions.length}
          previewVersionIndex={previewVersionIndex}
          reanalyzing={isAnalysisInFlight(activeRun.status)}
        />
      );
    }
    if (page === 'workspace' && material) {
      return (
        <WorkspacePage
          conversation={activeRun?.conversation ?? []}
          conversionContext={conversionContext}
          industry={industry}
          layout={workspaceLayout}
          material={material}
          onBack={() => setPage('new-analysis')}
          onCancel={handleCancelAnalysis}
          onLayoutChange={updateWorkspaceLayout}
          onResetLayout={resetWorkspaceLayout}
          onRetry={() => void handleStartAnalysis(material)}
          onSubmitConversation={handleSubmitConversation}
          onViewReport={() => setPage('report')}
          productName={products.find((product) => product.id === productId)?.name ?? null}
          run={activeRun}
        />
      );
    }
    if (page === 'records') {
      return (
        <RecordsPage
          initialRecordId={recordToOpenId}
          onCreate={createBlankAnalysis}
          onInitialRecordOpened={() => setRecordToOpenId(null)}
          onReanalyze={handleRecordReanalysis}
        />
      );
    }
    if (page === 'products') {
      return <ProductLibraryPage onProductsChanged={() => void refreshProducts()} />;
    }
    if (page === 'settings') {
      return (
        <ModelSettingsPage
          codexSubscriptionApi={window.materialApi.codexSubscription}
          onChanged={() => void refreshModelConfigurations()}
        />
      );
    }
    return (
      <NewAnalysisPage
        analysisBusy={isAnalysisInFlight(activeRun?.status)}
        codexSubscriptionLoaded={codexSubscriptionLoaded}
        codexSubscriptionState={codexSubscriptionState}
        conversionContext={conversionContext}
        industry={industry}
        material={material}
        modelId={modelId}
        modelOptions={modelOptions}
        productId={productId}
        products={products}
        reanalysisOrigin={reanalysisOrigin}
        onClearReanalysisOrigin={() => {
          setReanalysisOrigin(null);
          setSourceRecordId(null);
        }}
        onConversionContextChange={(value) => {
          setConversionContext(value);
          if (!isAnalysisInFlight(activeRun?.status)) updateActiveRun(() => null);
        }}
        onIndustryChange={(value) => {
          setIndustry(value);
          if (!isAnalysisInFlight(activeRun?.status)) updateActiveRun(() => null);
          setProductId((current) =>
            products.some((product) => product.id === current && product.industry === value)
              ? current
              : '',
          );
        }}
        onMaterialChange={(value) => {
          setMaterial(value);
          if (
            reanalysisOrigin
            && value
            && value.summary.fingerprintSha256 !== reanalysisOrigin.fingerprintSha256
          ) {
            setReanalysisOrigin(null);
            setSourceRecordId(null);
          }
          if (!isAnalysisInFlight(activeRun?.status)) updateActiveRun(() => null);
        }}
        onModelChange={(value) => {
          setModelId(value);
          if (!isAnalysisInFlight(activeRun?.status)) updateActiveRun(() => null);
        }}
        onProductChange={(value) => {
          setProductId(value);
          if (!isAnalysisInFlight(activeRun?.status)) updateActiveRun(() => null);
        }}
        onPreviewWorkspace={() => {
          updateActiveRun(() => null);
          setPage('workspace');
        }}
        onStartAnalysis={(value) => void handleStartAnalysis(value)}
      />
    );
  }, [
    activeRun,
    codexSubscriptionLoaded,
    codexSubscriptionState,
    conversionContext,
    confirmReportError,
    confirmingReport,
    handleCancelAnalysis,
    handleConfirmReport,
    handleStartAnalysis,
    industry,
    material,
    modelId,
    modelOptions,
    page,
    productId,
    products,
    recordToOpenId,
    refreshModelConfigurations,
    refreshProducts,
    leaveReportForConfiguration,
    createBlankAnalysis,
    handleRecordReanalysis,
    handleSubmitConversation,
    previewVersionIndex,
    reanalysisOrigin,
    reportVersions,
    selectedReportData,
    updateActiveRun,
    updateWorkspaceLayout,
    resetWorkspaceLayout,
    workspaceLayout,
  ]);

  return (
    <div
      className="app-frame"
      ref={appFrameRef}
      style={{ gridTemplateColumns: `${workspaceLayout.sidebarWidth}px 8px minmax(0, 1fr)` }}
    >
      <Sidebar onNavigate={navigate} page={page} />
      <div
        aria-label="调整主导航栏宽度"
        aria-orientation="vertical"
        aria-valuemax={280}
        aria-valuemin={168}
        aria-valuenow={workspaceLayout.sidebarWidth}
        className="panel-resizer is-horizontal app-sidebar-resizer"
        onKeyDown={resizeSidebarByKeyboard}
        onPointerDown={beginSidebarResize}
        role="separator"
        tabIndex={0}
      >
        <span />
      </div>
      <div className="app-content">{content}</div>
    </div>
  );
};
