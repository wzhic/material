import { ModelServiceError } from './errors';
import { ModelProviderAdapter } from './provider';
import { ModelProviderInfo } from './types';

export class ModelProviderRegistry {
  private readonly providers = new Map<string, ModelProviderAdapter>();

  register(provider: ModelProviderAdapter): void {
    const id = provider.info.id;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) {
      throw new Error('model provider id is invalid');
    }
    if (this.providers.has(id)) {
      throw new Error(`model provider is already registered: ${id}`);
    }
    this.providers.set(id, provider);
  }

  resolve(id: string): ModelProviderAdapter {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new ModelServiceError('PROVIDER_NOT_SUPPORTED');
    }
    return provider;
  }

  list(): ModelProviderInfo[] {
    return [...this.providers.values()]
      .map((provider) => ({
        ...provider.info,
        capabilities: {
          ...provider.info.capabilities,
          inputKinds: [...provider.info.capabilities.inputKinds],
        },
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }
}
