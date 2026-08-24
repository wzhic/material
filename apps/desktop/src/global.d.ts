import { ProductApi } from './product/types';
import { RecordApi } from './record/types';

declare global {
  interface Window {
    materialApi: {
      products: ProductApi;
      records: RecordApi;
    };
  }
}

export {};
