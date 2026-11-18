import { IntelligenceError } from '../constants.js';

/**
 * Controlled tool-calling loop. The model never executes tools directly.
 *
 * @param {{
 *   provider: { complete: Function, isMock?: boolean, name: string },
 *   toolRegistry: import('./tool-registry.js').ToolRegistry,
 *   permissionService: { assertAllowed: Function },
 *   auditService?: { record: Function } | null,
 *   maxIterations?: number,
 *   messages: import('../providers/provider.interface.js').AiMessage[],
 *   responseFormat?: Record<string, unknown>,
 *   model?: string,
 *   signal?: AbortSignal,
 *   operationId?: string,
 *   actor?: string,
 * }} options
 */
export async function runToolLoop(options) {
  const maxIterations = Math.max(1, Number(options.maxIterations ?? 8));
  const messages = [...options.messages];
  /** @type {Array<Record<string, unknown>>} */
  const toolTrace = [];
  /** @type {import('../providers/provider.interface.js').AiCompletionResult | null} */
  let lastResult = null;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (options.signal?.aborted) {
      throw new IntelligenceError('AI tool loop aborted', { code: 'AI_ABORTED' });
    }

    lastResult = await options.provider.complete({
      messages,
      tools: options.toolRegistry.listDefinitions(),
      responseFormat: options.responseFormat,
      model: options.model,
      signal: options.signal,
      operationId: options.operationId,
    });

    if (!lastResult.toolCalls?.length) {
      return {
        result: lastResult,
        messages,
        toolTrace,
        iterations: iteration + 1,
      };
    }

    messages.push({
      role: 'assistant',
      content: lastResult.content ?? '',
      toolCalls: lastResult.toolCalls,
    });

    for (const call of lastResult.toolCalls) {
      const tool = options.toolRegistry.get(call.name);
      if (!tool) {
        const payload = {
          ok: false,
          error: {
            code: 'UNKNOWN_TOOL',
            message: `Tool is not registered: ${call.name}`,
          },
        };
        toolTrace.push({ toolCallId: call.id, name: call.name, ok: false, error: payload.error });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify(payload),
        });
        continue;
      }

      if (call.arguments?.__parseError) {
        const payload = {
          ok: false,
          error: {
            code: 'INVALID_TOOL_ARGUMENTS',
            message: 'Tool arguments were not valid JSON',
            raw: call.arguments.__raw ?? null,
          },
        };
        toolTrace.push({ toolCallId: call.id, name: call.name, ok: false, error: payload.error });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify(payload),
        });
        continue;
      }

      try {
        options.permissionService.assertAllowed(tool.permission, {
          actor: options.actor ?? 'system',
        });
        validateAgainstSchema(call.arguments ?? {}, tool.parameters);
        const output = await tool.execute(call.arguments ?? {}, {
          operationId: options.operationId,
        });
        toolTrace.push({
          toolCallId: call.id,
          name: call.name,
          ok: true,
          arguments: call.arguments ?? {},
        });
        options.auditService?.record?.({
          operationId: options.operationId,
          entityType: 'tool',
          entityId: call.name,
          eventType: 'tool.executed',
          summary: `Executed tool ${call.name}`,
          payload: { toolCallId: call.id },
          actor: options.actor ?? 'system',
        });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify({ ok: true, result: output }),
        });
      } catch (error) {
        const payload = {
          ok: false,
          error: {
            code: error instanceof IntelligenceError ? error.code : 'TOOL_EXECUTION_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        };
        toolTrace.push({ toolCallId: call.id, name: call.name, ok: false, error: payload.error });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify(payload),
        });
      }
    }
  }

  throw new IntelligenceError(
    `AI tool loop exceeded maximum iterations (${maxIterations})`,
    { code: 'AI_TOOL_LOOP_LIMIT', details: { toolTrace } },
  );
}

/**
 * Lightweight JSON-schema subset validation for tool args.
 *
 * @param {Record<string, unknown>} args
 * @param {Record<string, unknown>} schema
 */
export function validateAgainstSchema(args, schema) {
  if (!schema || typeof schema !== 'object') return true;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) {
      throw new IntelligenceError(`Missing required tool argument: ${key}`, {
        code: 'INVALID_TOOL_ARGUMENTS',
        details: { key },
      });
    }
  }
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(/** @type {Record<string, unknown>} */ (schema.properties ?? {})));
    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) {
        throw new IntelligenceError(`Unexpected tool argument: ${key}`, {
          code: 'INVALID_TOOL_ARGUMENTS',
          details: { key },
        });
      }
    }
  }
  return true;
}
