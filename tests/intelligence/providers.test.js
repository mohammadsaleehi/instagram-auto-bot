import { describe, expect, it, vi } from 'vitest';
import { createAiProvider } from '../../src/intelligence/providers/provider.factory.js';
import { MockProvider } from '../../src/intelligence/providers/mock/mock.provider.js';
import { OpenRouterProvider } from '../../src/intelligence/providers/openrouter/openrouter.provider.js';
import { resolveOpenRouterConfig, assertOpenRouterReady } from '../../src/intelligence/providers/openrouter/openrouter.config.js';
import { classifyOpenRouterError } from '../../src/intelligence/providers/openrouter/openrouter.errors.js';
import { runToolLoop, validateAgainstSchema } from '../../src/intelligence/agent/tool-loop.js';
import { ToolRegistry } from '../../src/intelligence/agent/tool-registry.js';
import { IntelligenceError } from '../../src/intelligence/constants.js';

describe('AI providers and tool loop', () => {
  it('requires OpenRouter API key and model for real operations', () => {
    const resolved = resolveOpenRouterConfig({
      openrouterApiKey: null,
      openrouterModel: null,
    });
    expect(() => assertOpenRouterReady(resolved)).toThrow(/OPENROUTER_API_KEY/i);

    const withKey = resolveOpenRouterConfig({
      openrouterApiKey: 'test-key',
      openrouterModel: null,
    });
    expect(() => assertOpenRouterReady(withKey)).toThrow(/OPENROUTER_MODEL/i);

    expect(() =>
      assertOpenRouterReady(
        resolveOpenRouterConfig({
          openrouterApiKey: 'test-key',
          openrouterModel: 'gpt-4o-mini',
        }),
      ),
    ).toThrow(/provider\/model-name/i);
  });

  it('creates OpenRouter or Mock providers via factory', () => {
    const mock = createAiProvider({ aiProvider: 'mock' });
    expect(mock.isMock).toBe(true);

    const openrouter = createAiProvider({
      aiProvider: 'openrouter',
      openrouterApiKey: 'test-key',
      openrouterModel: 'openai/gpt-4o-mini',
    });
    expect(openrouter).toBeInstanceOf(OpenRouterProvider);
    expect(openrouter.getStatus().hasApiKey).toBe(true);
    expect(openrouter.getStatus().model).toBe('openai/gpt-4o-mini');
  });

  it('classifies auth and rate-limit errors', () => {
    expect(classifyOpenRouterError({ status: 401, message: 'unauthorized' }).code).toBe(
      'OPENROUTER_AUTH',
    );
    expect(classifyOpenRouterError({ status: 429, message: 'rate limit' }).retryable).toBe(true);
  });

  it('classifies Cloudflare security-policy 403 separately from auth failures', () => {
    const classified = classifyOpenRouterError({
      status: 403,
      message: '403',
      error: { success: false, error: 'Access denied by security policy.' },
    });
    expect(classified.code).toBe('OPENROUTER_SECURITY_POLICY');
    expect(classified.retryable).toBe(false);
    expect(classified.message).not.toMatch(/OPENROUTER_API_KEY/i);
  });

  it('classifies missing endpoint model errors as MODEL_NOT_FOUND', () => {
    const classified = classifyOpenRouterError({
      status: 404,
      message: 'No endpoints found for inclusionai/ling-3.2-flash.',
    });
    expect(classified.code).toBe('OPENROUTER_MODEL_NOT_FOUND');
  });

  it('prefers IPv4 DNS order when constructing the OpenRouter client', async () => {
    const dns = await import('node:dns');
    const previous = dns.getDefaultResultOrder();
    try {
      const { preferOpenRouterIpv4, createOpenRouterClient } = await import(
        '../../src/intelligence/providers/openrouter/openrouter.client.js'
      );
      expect(preferOpenRouterIpv4()).toBe(true);
      expect(dns.getDefaultResultOrder()).toBe('ipv4first');
      createOpenRouterClient({
        openrouterApiKey: 'test-key',
        openrouterModel: 'openai/gpt-4o-mini',
        openrouterBaseUrl: 'https://openrouter.ai/api/v1',
      });
      expect(dns.getDefaultResultOrder()).toBe('ipv4first');
    } finally {
      dns.setDefaultResultOrder(previous);
    }
  });

  it('MockProvider marks output as mock and can fail without fake success', async () => {
    const provider = new MockProvider({
      failWith: new IntelligenceError('boom', { code: 'MOCK_FAIL' }),
    });
    await expect(provider.complete({ messages: [] })).rejects.toThrow(/boom/);

    const ok = new MockProvider();
    const result = await ok.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.isMock).toBe(true);
    expect(result.provider).toBe('mock');
  });

  it('OpenRouter provider retries retryable failures and records fallback model usage', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce({ status: 429, message: 'rate limit' })
      .mockResolvedValueOnce({
        id: 'resp-1',
        model: 'openai/fallback-model',
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      });

    class FakeOpenAI {
      constructor() {
        this.chat = { completions: { create } };
        this.models = { list: async () => ({ data: [] }) };
      }
    }

    const provider = new OpenRouterProvider(
      {
        openrouterApiKey: 'test-key',
        openrouterModel: 'openai/primary-model',
        openrouterFallbackModels: ['openai/fallback-model'],
        aiMaxRetries: 1,
        aiRequestTimeoutMs: 1000,
      },
      { OpenAIClass: FakeOpenAI },
    );

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(result.modelRequested).toBe('openai/primary-model');
    expect(result.modelUsed).toBe('openai/fallback-model');
    expect(result.usage.totalTokens).toBe(3);
    expect(result.isMock).toBe(false);
  });

  it('tool loop validates arguments, permissions, and unknown tools', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'safe_tool',
      description: 'safe',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      permission: 'analyze',
      execute: (args) => ({ echo: args.query }),
    });

    const provider = new MockProvider({
      responses: [
        {
          provider: 'mock',
          modelRequested: 'mock/deterministic',
          modelUsed: 'mock/deterministic',
          content: null,
          toolCalls: [
            { id: '1', name: 'missing_tool', arguments: {} },
            { id: '2', name: 'safe_tool', arguments: { query: 'hello' } },
          ],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: null },
          durationMs: 1,
          isMock: true,
        },
        {
          provider: 'mock',
          modelRequested: 'mock/deterministic',
          modelUsed: 'mock/deterministic',
          content: '{"done":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: null },
          durationMs: 1,
          isMock: true,
        },
      ],
    });

    const result = await runToolLoop({
      provider,
      toolRegistry: registry,
      permissionService: {
        assertAllowed() {
          return { allowed: true };
        },
      },
      messages: [{ role: 'user', content: 'go' }],
      maxIterations: 3,
    });

    expect(result.result.content).toContain('done');
    expect(result.toolTrace.some((item) => item.name === 'missing_tool' && item.ok === false)).toBe(
      true,
    );
    expect(result.toolTrace.some((item) => item.name === 'safe_tool' && item.ok === true)).toBe(
      true,
    );
  });

  it('rejects invalid tool schemas', () => {
    expect(() =>
      validateAgainstSchema(
        { unexpected: 1 },
        { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
      ),
    ).toThrow(/Unexpected tool argument/);
  });

  it('does not invent token usage when absent', async () => {
    class FakeOpenAI {
      constructor() {
        this.chat = {
          completions: {
            create: async () => ({
              model: 'openai/gpt-test',
              choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
              usage: undefined,
            }),
          },
        };
      }
    }
    const provider = new OpenRouterProvider(
      {
        openrouterApiKey: 'test-key',
        openrouterModel: 'openai/gpt-test',
        aiMaxRetries: 0,
      },
      { OpenAIClass: FakeOpenAI },
    );
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'ping' }],
    });
    expect(result.usage.promptTokens).toBeNull();
    expect(result.usage.totalTokens).toBeNull();
    expect(result.usage.cost).toBeNull();
  });
});
