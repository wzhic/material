import { AnalysisRuntimeApi } from './analysis-runtime/types';
import { MaterialApi } from './media/types';
import { ModelApi } from './model/types';
import { ProductApi } from './product/types';
import { RecordApi } from './record/types';

declare global {
  interface Window {
    materialApi: {
      analysis: AnalysisRuntimeApi;
      media: MaterialApi;
      models: ModelApi;
      products: ProductApi;
      records: RecordApi;
    };
  }
}

export {};
