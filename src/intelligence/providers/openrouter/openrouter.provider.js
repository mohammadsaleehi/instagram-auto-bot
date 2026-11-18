import {
  createChatCompletion,
  createOpenRouterClient,
  listOpenRouterModels,
  sleep,
} from './openrouter.client.js';
import { assertOpenRouterReady, resolveOpenRouterConfig } from './openrouter.config.js';
import { OpenRouterError, classifyOpenRouterError } from './openrouter.errors.js';
import { normalizeToolCall, normalizeUsage } from './openrouter.types.js';

export class OpenRouterProvider {
  /**
   * @param {Record<string, unknown>} config
   * @param {{
   *   OpenAIClass?: any,
   *   logger?: { info?: Function, warn?: Function, error?: Function, debug?: Function } | null,
   * }} [options]
   */
  constructor(config, options = {}) {
    this.name = 'openrouter';
    this.isMock = false;
    this.logger = options.logger ?? null;
    this.config = resolveOpenRouterConfig(config);
    const { client } = createOpenRouterClient(config, {
      OpenAIClass: options.OpenAIClass,
    });
    this.client = client;
  }

  getStatus() {
    return {
      provider: this.name,
      isMock: false,
      configured: Boolean(this.config.apiKey),
      modelConfigured: Boolean(this.config.model),
      model: this.config.model,
      fallbackModels: this.config.fallbackModels,
      baseUrl: this.config.baseUrl,
      appName: this.config.appName,
      hasApiKey: Boolean(this.config.apiKey),
    };
  }

  /**
   * @param {import('../provider.interface.js').AiCompletionRequest} request
   */
  async complete(request) {
    assertOpenRouterReady(this.config, { requireModel: true });
    const models = [
      request.model || this.config.model,
      ...this.config.fallbackModels.filter((model) => model !== (request.model || this.config.model)),
    ].filter(Boolean);

    let lastError = null;
    for (const model of models) {
      try {
        return await this._completeWithModel(String(model), request);
      } catch (error) {
        const classified = classifyOpenRouterError(error);
        lastError = classified;
        const canFallback =
          classified.retryable ||
          classified.code === 'OPENROUTER_MODEL_NOT_FOUND' ||
          classified.code === 'OPENROUTER_UNAVAILABLE';
        if (!canFallback || models.indexOf(model) === models.length - 1) {
          throw classified;
        }
        this.logger?.warn?.('OpenRouter model failed; trying fallback', {
          model,
          code: classified.code,
        });
      }
    }

    throw lastError ?? new OpenRouterError('OpenRouter completion failed');
  }

  /**
   * @param {string} model
   * @param {import('../provider.interface.js').AiCompletionRequest} request
   */
  async _completeWithModel(model, request) {
    const started = Date.now();
    const body = {
      model,
      messages: (request.messages ?? []).map((message) => this._toSdkMessage(message)),
      temperature: request.temperature ?? 0.2,
    };

    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters ?? { type: 'object', properties: {} },
        },
      }));
      body.tool_choice = 'auto';
    }

    if (request.responseFormat) {
      body.response_format = request.responseFormat;
    }

    const response = await this._withRetries(() =>
      createChatCompletion(this.client, body, { signal: request.signal }),
    );

    const choice = response?.choices?.[0]?.message ?? {};
    const toolCalls = Array.isArray(choice.tool_calls)
      ? choice.tool_calls.map(normalizeToolCall).filter(Boolean)
      : [];

    return {
      provider: this.name,
      modelRequested: model,
      modelUsed: response?.model ? String(response.model) : model,
      content: choice.content === undefined || choice.content === null ? null : String(choice.content),
      toolCalls,
      usage: normalizeUsage(response?.usage),
      durationMs: Date.now() - started,
      isMock: false,
      raw: {
        id: response?.id ?? null,
        finishReason: response?.choices?.[0]?.finish_reason ?? null,
      },
    };
  }

  /**
   * @param {() => Promise<any>} fn
   */
  async _withRetries(fn) {
    let attempt = 0;
    let lastError = null;
    while (attempt <= this.config.maxRetries) {
      try {
        return await fn();
      } catch (error) {
        const classified = classifyOpenRouterError(error);
        lastError = classified;
        if (!classified.retryable || attempt === this.config.maxRetries) {
          throw classified;
        }
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        this.logger?.warn?.('Retrying OpenRouter request', {
          attempt: attempt + 1,
          delayMs: delay,
          code: classified.code,
        });
        await sleep(delay);
        attempt += 1;
      }
    }
    throw lastError;
  }

  /**
   * @param {import('../provider.interface.js').AiMessage} message
   */
  _toSdkMessage(message) {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content ?? '',
      };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments ?? {}),
          },
        })),
      };
    }
    return {
      role: message.role,
      content: message.content ?? '',
      ...(message.name ? { name: message.name } : {}),
    };
  }

  async testConnection() {
    assertOpenRouterReady(this.config, { requireModel: true });
    const result = await this.complete({
      messages: [
        {
          role: 'user',
          content: 'Reply with exactly: ok',
        },
      ],
      temperature: 0,
    });
    return {
      ok: true,
      detail: 'OpenRouter connection succeeded',
      model: result.modelUsed,
      content: result.content,
      usage: result.usage,
      durationMs: result.durationMs,
    };
  }

  async listModels() {
    assertOpenRouterReady(this.config, { requireModel: false });
    const models = await listOpenRouterModels(this.client);
    return models.map((model) => ({
      id: model.id,
      created: model.created ?? null,
      ownedBy: model.owned_by ?? null,
    }));
  }
}
