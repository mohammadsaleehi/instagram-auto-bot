/**
 * Shared OpenRouter response helpers.
 */

/**
 * @param {unknown} toolCall
 * @returns {{ id: string, name: string, arguments: Record<string, unknown> } | null}
 */
export function normalizeToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return null;
  const call = /** @type {Record<string, unknown>} */ (toolCall);
  const fn = /** @type {Record<string, unknown>} */ (call.function ?? {});
  const name = String(fn.name ?? '');
  if (!name) return null;

  let args = {};
  const rawArgs = fn.arguments;
  if (typeof rawArgs === 'string' && rawArgs.trim()) {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      args = { __raw: rawArgs, __parseError: true };
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = /** @type {Record<string, unknown>} */ (rawArgs);
  }

  return {
    id: String(call.id ?? `${name}-${Date.now()}`),
    name,
    arguments: args,
  };
}

/**
 * @param {unknown} usage
 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      cost: null,
    };
  }
  const row = /** @type {Record<string, unknown>} */ (usage);
  const promptTokens = Number.isFinite(Number(row.prompt_tokens))
    ? Number(row.prompt_tokens)
    : null;
  const completionTokens = Number.isFinite(Number(row.completion_tokens))
    ? Number(row.completion_tokens)
    : null;
  const totalTokens = Number.isFinite(Number(row.total_tokens))
    ? Number(row.total_tokens)
    : promptTokens !== null && completionTokens !== null
      ? promptTokens + completionTokens
      : null;
  const cost = Number.isFinite(Number(row.cost)) ? Number(row.cost) : null;
  return { promptTokens, completionTokens, totalTokens, cost };
}

/**
 * @param {import('./openrouter.config.js').resolveOpenRouterConfig extends Function ? any : never} _
 */
export {};
