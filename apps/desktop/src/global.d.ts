import { MaterialApi } from './media/types';
import { ProductApi } from './product/types';
import { RecordApi } from './record/types';

declare global {
  interface Window {
    materialApi: {
      media: MaterialApi;
      products: ProductApi;
      records: RecordApi;
    };
  }
}

export {};
