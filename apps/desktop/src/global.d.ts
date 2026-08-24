import { ProductApi } from './product/types';

declare global {
  interface Window {
    materialApi: {
      products: ProductApi;
    };
  }
}

export {};
