import React, {
  ChangeEvent,
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
  MaterialSummary,
  toMaterialSummary,
  validateDraft,
} from '../analysis/draft';
import { ProductListItem } from '../product/types';
import { ProductLibraryPage } from './ProductLibraryPage';

type AppPage = 'new-analysis' | 'products' | 'records' | 'workspace';

interface SelectedMaterial {
  file: File;
  objectUrl: string;
  summary: MaterialSummary;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const industryLabel = (industry: Industry): string => {
  if (industry === 'apparel') {
    return '服饰';
  }
  if (industry === 'game') {
    return '游戏';
  }
  return '未选择';
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
  const currentSection = page === 'workspace' ? 'new-analysis' : page;

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
      <button className="settings-entry" disabled type="button">
        模型与工具设置
        <span>后续接入</span>
      </button>
    </aside>
  );
};

interface NewAnalysisPageProps {
  conversionContext: string;
  industry: Industry;
  material: SelectedMaterial | null;
  modelId: string;
  productId: string;
  products: ProductListItem[];
  onConversionContextChange: (value: string) => void;
  onIndustryChange: (value: Industry) => void;
  onMaterialChange: (value: SelectedMaterial | null) => void;
  onModelChange: (value: string) => void;
  onProductChange: (value: string) => void;
  onPreviewWorkspace: () => void;
}

const NewAnalysisPage = ({
  conversionContext,
  industry,
  material,
  modelId,
  productId,
  products,
  onConversionContextChange,
  onIndustryChange,
  onMaterialChange,
  onModelChange,
  onProductChange,
  onPreviewWorkspace,
}: NewAnalysisPageProps): React.JSX.Element => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState('');
  const draft: AnalysisDraft = {
    industry,
    material: material?.summary ?? null,
    modelId,
  };
  const validation = validateDraft(draft);
  const compatibleProducts = products.filter((product) => product.industry === industry);
  const selectedProduct = products.find((product) => product.id === productId);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.item(0);
    event.target.value = '';
    if (!file) {
      return;
    }

    const summary = toMaterialSummary(file);
    if (!summary) {
      setFileError('当前文件不是可识别的视频或图片，请重新选择。');
      return;
    }

    setFileError('');
    onMaterialChange({
      file,
      objectUrl: URL.createObjectURL(file),
      summary,
    });
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

      <div className="new-analysis-grid">
        <section className="form-card" aria-labelledby="material-heading">
          <div className="section-heading">
            <div>
              <h2 id="material-heading">源素材</h2>
              <p>单次仅选择一个文件；文件仍保存在原位置。</p>
            </div>
            {material ? (
              <Button
                onClick={() => fileInputRef.current?.click()}
                size="small"
                variant="outline"
              >
                重新选择
              </Button>
            ) : null}
          </div>

          <input
            ref={fileInputRef}
            accept="video/*,image/*,.mkv,.heic"
            className="visually-hidden"
            onChange={handleFileChange}
            type="file"
          />

          {material ? (
            <div className="material-preview-card">
              <div className="media-preview">
                {material.summary.kind === 'video' ? (
                  <video
                    aria-label={`视频预览：${material.summary.name}`}
                    controls
                    preload="metadata"
                    src={material.objectUrl}
                  />
                ) : (
                  <img
                    alt={`图片预览：${material.summary.name}`}
                    src={material.objectUrl}
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
              </div>
              <button
                aria-label="移除已选择素材"
                className="remove-material"
                onClick={() => onMaterialChange(null)}
                type="button"
              >
                ×
              </button>
            </div>
          ) : (
            <button
              className="file-dropzone"
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              <span className="upload-glyph">↑</span>
              <strong>选择本地视频或图片</strong>
              <span>支持常见视频、图片格式；暂不支持组图和批量导入</span>
              <span className="choose-file-pill">浏览文件</span>
            </button>
          )}

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
                disabled={!industry}
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
                onChange={(event) => onModelChange(event.target.value)}
                value={modelId}
              >
                <option value="">暂无已配置模型</option>
              </select>
              <small>用户自带 Key 与安全存储将在后续工作包接入。</small>
            </label>

            <label className="form-field field-span-two">
              <span className="field-label">转化依据或关注点</span>
              <Input
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
              <dd>{modelId || '尚未配置'}</dd>
            </div>
          </dl>

          <div className="readiness-panel">
            <strong>真实分析尚不可开始</strong>
            <ul>
              {validation.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>

          <Button block disabled={!validation.canStartAnalysis} theme="primary">
            开始分析
          </Button>
          <Button
            block
            disabled={!validation.canPreviewWorkspace}
            onClick={onPreviewWorkspace}
            variant="outline"
          >
            预览分析工作区
          </Button>
          <p className="summary-footnote">
            工作区预览不会调用模型、生成报告或保存分析记录。
          </p>
        </aside>
      </div>
    </main>
  );
};

interface WorkspacePageProps {
  conversionContext: string;
  industry: Industry;
  material: SelectedMaterial;
  onBack: () => void;
  productName: string | null;
}

const WorkspacePage = ({
  conversionContext,
  industry,
  material,
  onBack,
  productName,
}: WorkspacePageProps): React.JSX.Element => {
  const stageRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const [mediaPercent, setMediaPercent] = useState(58);
  const [timelineHeight, setTimelineHeight] = useState(292);

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
      setMediaPercent(clamp(percentage, 38, 72));
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
      setTimelineHeight(
        clamp(rect.bottom - moveEvent.clientY, 220, Math.min(440, rect.height * 0.55)),
      );
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
      setMediaPercent((current) =>
        clamp(current + (event.key === 'ArrowLeft' ? -2 : 2), 38, 72),
      );
    }
  };

  const resizeVerticalByKeyboard = (
    event: KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setTimelineHeight((current) =>
        clamp(current + (event.key === 'ArrowUp' ? 16 : -16), 220, 440),
      );
    }
  };

  return (
    <main
      ref={workspaceRef}
      className="workspace-page"
      style={{ gridTemplateRows: `minmax(300px, 1fr) 8px ${timelineHeight}px` }}
    >
      <section
        ref={stageRef}
        className="workspace-stage"
        style={{ gridTemplateColumns: `${mediaPercent}% 8px minmax(300px, 1fr)` }}
      >
        <div className="source-panel">
          <div className="workspace-toolbar">
            <Button onClick={onBack} size="small" variant="text">
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
            <Tag theme="warning" variant="light">
              工作区预览
            </Tag>
          </div>
          <div className="source-viewer">
            {material.summary.kind === 'video' ? (
              <video controls preload="metadata" src={material.objectUrl} />
            ) : (
              <img alt={material.summary.name} src={material.objectUrl} />
            )}
          </div>
          <div className="viewer-meta">
            <span>源素材可播放</span>
            <span>{formatFileSize(material.summary.size)}</span>
            <span>未复制到应用目录</span>
          </div>
        </div>

        <div
          aria-label="调整播放器与对话区域宽度"
          aria-orientation="vertical"
          aria-valuemax={72}
          aria-valuemin={38}
          aria-valuenow={Math.round(mediaPercent)}
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
            <button aria-selected="true" role="tab" type="button">
              对话分析
            </button>
            <button aria-selected="false" disabled role="tab" type="button">
              分析进度
            </button>
          </div>
          <div className="conversation-empty">
            <div className="empty-orbit" aria-hidden="true">
              <span />
            </div>
            <h2>等待真实分析能力接入</h2>
            <p>
              当前页面只验证播放器、布局和分析上下文，不会生成虚假的 AI 回复、标签或评分。
            </p>
            {conversionContext ? (
              <div className="context-chip">
                <span>本次关注点</span>
                <strong>{conversionContext}</strong>
              </div>
            ) : null}
          </div>
          <div className="conversation-composer">
            <textarea
              aria-label="补充分析关注点"
              disabled
              placeholder="模型接入后可在运行中补充关注点…"
            />
            <Button disabled size="small" theme="primary">
              发送
            </Button>
          </div>
        </aside>
      </section>

      <div
        aria-label="调整时间轴区域高度"
        aria-orientation="horizontal"
        aria-valuemax={440}
        aria-valuemin={220}
        aria-valuenow={Math.round(timelineHeight)}
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
            <span>等待真实解析结果</span>
          </div>
          <div className="timeline-actions">
            <button disabled type="button">－</button>
            <span>100%</span>
            <button disabled type="button">＋</button>
            <Button disabled size="small" variant="outline">
              适应全片
            </Button>
          </div>
        </div>
        <div className="timeline-chart">
          <div className="timeline-labels">
            <span>情绪变化</span>
            <span>镜头</span>
            <span>画面</span>
            <span>字幕</span>
            <span>口播 / 声音</span>
            <span>分析标签</span>
          </div>
          <div className="timeline-tracks">
            <div className="ruler">
              <span>00:00</span>
              <span>等待时长</span>
              <span>--:--</span>
            </div>
            <div className="emotion-track">
              <svg
                aria-label="情绪曲线等待真实分析数据"
                preserveAspectRatio="none"
                role="img"
                viewBox="0 0 1000 64"
              >
                <path d="M0 38 C150 38 210 38 330 38 S560 38 710 38 S900 38 1000 38" />
              </svg>
              <span>未生成情绪结论</span>
            </div>
            {['镜头', '画面', '字幕', '口播 / 声音', '分析标签'].map((track) => (
              <div className="empty-track" key={track}>
                <span>{track}结果将在分析运行后增量出现</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
};

const RecordsPage = ({ onCreate }: { onCreate: () => void }): React.JSX.Element => (
  <main className="page-shell records-page">
    <header className="page-header">
      <div>
        <span className="eyebrow">本地报告</span>
        <h1>分析记录</h1>
        <p>这里只会出现用户确认并保存成功的正式报告。</p>
      </div>
      <Button onClick={onCreate} theme="primary">
        新建分析
      </Button>
    </header>
    <section className="records-toolbar" aria-label="分析记录筛选">
      <Input disabled placeholder="搜索素材名称或产品名称" />
      <select disabled><option>全部行业</option></select>
      <select disabled><option>全部媒体</option></select>
      <select disabled><option>确认时间：从新到旧</option></select>
    </section>
    <section className="records-empty">
      <div className="records-empty-illustration" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <h2>尚无已确认的分析记录</h2>
      <p>真实分析、用户确认与本地持久化将在后续工程工作包接入。</p>
      <Button onClick={onCreate} variant="outline">
        先选择一个素材
      </Button>
    </section>
  </main>
);

export const App = (): React.JSX.Element => {
  const [page, setPage] = useState<AppPage>('new-analysis');
  const [material, setMaterial] = useState<SelectedMaterial | null>(null);
  const [industry, setIndustry] = useState<Industry>('');
  const [modelId, setModelId] = useState('');
  const [conversionContext, setConversionContext] = useState('');
  const [products, setProducts] = useState<ProductListItem[]>([]);
  const [productId, setProductId] = useState('');

  const refreshProducts = useCallback(async (): Promise<void> => {
    const result = await window.materialApi.products.list({ limit: 500 });
    if (result.ok) {
      setProducts(result.data.items);
      setProductId((current) =>
        current && result.data.items.some((product) => product.id === current) ? current : '',
      );
    }
  }, []);

  useEffect(() => {
    void refreshProducts();
  }, [refreshProducts]);

  useEffect(() => {
    const objectUrl = material?.objectUrl;
    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [material?.objectUrl]);

  const content = useMemo(() => {
    if (page === 'workspace' && material) {
      return (
        <WorkspacePage
          conversionContext={conversionContext}
          industry={industry}
          material={material}
          onBack={() => setPage('new-analysis')}
          productName={products.find((product) => product.id === productId)?.name ?? null}
        />
      );
    }
    if (page === 'records') {
      return <RecordsPage onCreate={() => setPage('new-analysis')} />;
    }
    if (page === 'products') {
      return <ProductLibraryPage onProductsChanged={() => void refreshProducts()} />;
    }
    return (
      <NewAnalysisPage
        conversionContext={conversionContext}
        industry={industry}
        material={material}
        modelId={modelId}
        productId={productId}
        products={products}
        onConversionContextChange={setConversionContext}
        onIndustryChange={(value) => {
          setIndustry(value);
          setProductId((current) =>
            products.some((product) => product.id === current && product.industry === value)
              ? current
              : '',
          );
        }}
        onMaterialChange={setMaterial}
        onModelChange={setModelId}
        onProductChange={setProductId}
        onPreviewWorkspace={() => setPage('workspace')}
      />
    );
  }, [conversionContext, industry, material, modelId, page, productId, products, refreshProducts]);

  return (
    <div className="app-frame">
      <Sidebar onNavigate={setPage} page={page} />
      <div className="app-content">{content}</div>
    </div>
  );
};
