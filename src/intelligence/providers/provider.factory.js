import { AI_PROVIDER, IntelligenceError } from '../constants.js';
import { MockProvider } from './mock/mock.provider.js';
import { OpenRouterProvider } from './openrouter/openrouter.provider.js';

/**
 * @param {Record<string, unknown>} config
 * @param {{
 *   providerName?: string,
 *   logger?: { info?: Function, warn?: Function, error?: Function, debug?: Function } | null,
 *   OpenAIClass?: any,
 *   mockProvider?: MockProvider | null,
 * }} [options]
 */
export function createAiProvider(config, options = {}) {
  const providerName = String(options.providerName ?? config.aiProvider ?? AI_PROVIDER.OPENROUTER)
    .trim()
    .toLowerCase();

  if (providerName === AI_PROVIDER.MOCK) {
    return options.mockProvider ?? new MockProvider();
  }

  if (providerName === AI_PROVIDER.OPENROUTER) {
    return new OpenRouterProvider(config, {
      logger: options.logger,
      OpenAIClass: options.OpenAIClass,
    });
  }

  throw new IntelligenceError(
    `Unsupported AI_PROVIDER: ${providerName}. Phase 1 supports only openrouter or mock.`,
    { code: 'AI_PROVIDER_UNSUPPORTED', details: { providerName } },
  );
}
