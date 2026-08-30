export type Industry = '' | 'apparel' | 'game';
export type MediaKind = 'image' | 'video';

export interface MaterialSummary {
  kind: MediaKind;
  mimeType: string;
  name: string;
  size: number;
}

export interface AnalysisDraft {
  industry: Industry;
  material: MaterialSummary | null;
  modelId: string;
}

export interface DraftValidation {
  canPreviewWorkspace: boolean;
  canStartAnalysis: boolean;
  errors: string[];
}

const VIDEO_EXTENSIONS = new Set([
  'avi',
  'm4v',
  'mkv',
  'mov',
  'mp4',
  'webm',
]);

const IMAGE_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'gif',
  'heic',
  'jpeg',
  'jpg',
  'png',
  'webp',
]);

const extensionOf = (name: string): string => {
  const parts = name.toLowerCase().split('.');
  return parts.length > 1 ? parts[parts.length - 1] ?? '' : '';
};

export const detectMediaKind = (
  file: Pick<File, 'name' | 'type'>,
): MediaKind | null => {
  if (file.type.startsWith('video/')) {
    return 'video';
  }
  if (file.type.startsWith('image/')) {
    return 'image';
  }

  const extension = extensionOf(file.name);
  if (VIDEO_EXTENSIONS.has(extension)) {
    return 'video';
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image';
  }
  return null;
};

export const toMaterialSummary = (file: File): MaterialSummary | null => {
  const kind = detectMediaKind(file);
  if (!kind) {
    return null;
  }
  return {
    kind,
    mimeType: file.type || `${kind}/unknown`,
    name: file.name,
    size: file.size,
  };
};

export const validateDraft = (draft: AnalysisDraft): DraftValidation => {
  const errors: string[] = [];
  if (!draft.material) {
    errors.push('请选择一个本地视频或图片');
  }
  if (!draft.industry) {
    errors.push('请选择素材所属行业');
  }
  if (!draft.modelId) {
    errors.push('尚未配置并选择分析模型');
  }

  return {
    canPreviewWorkspace: Boolean(draft.material && draft.industry),
    canStartAnalysis: errors.length === 0,
    errors,
  };
};

export const formatFileSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '未知大小';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};
