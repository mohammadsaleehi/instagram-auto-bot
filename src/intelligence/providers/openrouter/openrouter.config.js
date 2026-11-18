import { DEFAULT_OPENROUTER_BASE_URL, IntelligenceError } from '../../constants.js';

/**
 * @param {Record<string, unknown>} config
 */
export function resolveOpenRouterConfig(config) {
  const apiKey = config.openrouterApiKey ? String(config.openrouterApiKey) : null;
  const baseUrl = String(config.openrouterBaseUrl ?? DEFAULT_OPENROUTER_BASE_URL).replace(/\/$/, '');
  const model = config.openrouterModel ? String(config.openrouterModel) : null;
  const fallbackModels = Array.isArray(config.openrouterFallbackModels)
    ? config.openrouterFallbackModels.map(String).filter(Boolean)
    : [];
  const appName = String(config.openrouterAppName ?? 'Instagram Automation Agent');
  const appUrl = config.openrouterAppUrl ? String(config.openrouterAppUrl) : null;
  const timeoutMs = Number(config.aiRequestTimeoutMs ?? 60_000);
  const maxRetries = Number(config.aiMaxRetries ?? 2);

  return {
    apiKey,
    baseUrl,
    model,
    fallbackModels,
    appName,
    appUrl,
    timeoutMs,
    maxRetries,
  };
}

/**
 * @param {ReturnType<typeof resolveOpenRouterConfig>} resolved
 * @param {{ requireModel?: boolean }} [options]
 */
export function assertOpenRouterReady(resolved, options = {}) {
  if (!resolved.apiKey) {
    throw new IntelligenceError(
      'OPENROUTER_API_KEY is not configured. Set it in .env before running real AI operations.',
      { code: 'AI_CONFIG_MISSING_KEY' },
    );
  }
  if (options.requireModel !== false && !resolved.model) {
    throw new IntelligenceError(
      'OPENROUTER_MODEL is not configured. Set an explicit model ID (provider/model-name).',
      { code: 'AI_CONFIG_MISSING_MODEL' },
    );
  }
  if (resolved.model && !resolved.model.includes('/')) {
    throw new IntelligenceError(
      `OPENROUTER_MODEL must use provider/model-name format. Received: "${resolved.model}"`,
      { code: 'AI_CONFIG_INVALID_MODEL' },
    );
  }
  for (const fallback of resolved.fallbackModels) {
    if (!fallback.includes('/')) {
      throw new IntelligenceError(
        `OPENROUTER_FALLBACK_MODELS entries must use provider/model-name format. Received: "${fallback}"`,
        { code: 'AI_CONFIG_INVALID_FALLBACK_MODEL' },
      );
    }
  }
}
