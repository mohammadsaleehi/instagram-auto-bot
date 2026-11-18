import { IntelligenceError } from '../../constants.js';

/**
 * Deterministic provider for automated tests.
 * Outputs must never be represented as real AI-generated content.
 */
export class MockProvider {
  /**
   * @param {{
   *   responses?: Array<import('../provider.interface.js').AiCompletionResult | ((request: any) => import('../provider.interface.js').AiCompletionResult)>,
   *   failWith?: Error | null,
   * }} [options]
   */
  constructor(options = {}) {
    this.name = 'mock';
    this.isMock = true;
    this.responses = options.responses ?? [];
    this.failWith = options.failWith ?? null;
    this.calls = [];
  }

  getStatus() {
    return {
      provider: this.name,
      isMock: true,
      configured: true,
      modelConfigured: true,
      model: 'mock/deterministic',
      fallbackModels: [],
      baseUrl: null,
      appName: 'Mock Provider',
      hasApiKey: false,
    };
  }

  /**
   * @param {import('../provider.interface.js').AiCompletionResult | ((request: any) => import('../provider.interface.js').AiCompletionResult)} response
   */
  enqueue(response) {
    this.responses.push(response);
  }

  /**
   * @param {import('../provider.interface.js').AiCompletionRequest} request
   */
  async complete(request) {
    this.calls.push(request);
    if (this.failWith) {
      throw this.failWith;
    }

    const next = this.responses.shift();
    if (typeof next === 'function') {
      return next(request);
    }
    if (next) {
      return {
        ...next,
        isMock: true,
        provider: this.name,
      };
    }

    // Default deterministic decision-shaped JSON when no scripted response exists.
    const content = JSON.stringify({
      decisionType: 'operational_recommendation',
      objective: 'Analyze available evidence and propose an authorized operational plan',
      selectedDecision:
        'Produce an evidence-based analysis and an internal execution plan pending owner approval',
      evidence: [],
      historicalRefs: [],
      contextRefs: [],
      reasoningSummary:
        'Insufficient scripted mock evidence was provided; returning a constrained operational recommendation without fabricating metrics.',
      alternativesConsidered: [
        'Request clarification from the owner',
        'Defer decision until more performance data is available',
      ],
      confidence: 0.35,
      risks: ['Limited evidence available in mock mode'],
      missingInformation: ['Real performance metrics', 'Owner-confirmed recent outcomes'],
      requiredPermissions: ['analyze', 'create_plan'],
      expectedOutcome: 'Owner-reviewable operational plan',
      facts: [],
      assumptions: ['Mock provider is being used for deterministic testing'],
      recommendations: ['Import historical decisions and register business context before live use'],
      proposedPlanSteps: [
        {
          title: 'Retrieve brand and strategy context',
          toolName: 'get_business_context',
          inputs: {},
          expectedOutput: 'Active context bundle',
        },
        {
          title: 'Search historical decisions',
          toolName: 'search_historical_decisions',
          inputs: { query: 'performance' },
          expectedOutput: 'Matching historical records',
        },
        {
          title: 'Generate owner-reviewable operational recommendation',
          toolName: null,
          inputs: {},
          expectedOutput: 'Structured decision and plan',
        },
      ],
    });

    return {
      provider: this.name,
      modelRequested: request.model ?? 'mock/deterministic',
      modelUsed: 'mock/deterministic',
      content,
      toolCalls: [],
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        cost: null,
      },
      durationMs: 1,
      isMock: true,
      raw: { finishReason: 'stop' },
    };
  }

  async testConnection() {
    if (this.failWith) {
      throw this.failWith;
    }
    return {
      ok: true,
      detail: 'Mock provider is available (not a real AI connection)',
      model: 'mock/deterministic',
      isMock: true,
    };
  }

  async listModels() {
    return [{ id: 'mock/deterministic', created: null, ownedBy: 'local' }];
  }
}

/**
 * @param {string} message
 * @param {string} [code]
 */
export function mockProviderFailure(message, code = 'MOCK_PROVIDER_FAILURE') {
  return new IntelligenceError(message, { code });
}
