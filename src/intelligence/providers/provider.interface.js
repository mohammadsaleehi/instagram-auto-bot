/**
 * @typedef {Object} AiMessage
 * @property {'system' | 'user' | 'assistant' | 'tool'} role
 * @property {string} [content]
 * @property {string} [name]
 * @property {string} [toolCallId]
 * @property {Array<AiToolCall>} [toolCalls]
 */

/**
 * @typedef {Object} AiToolCall
 * @property {string} id
 * @property {string} name
 * @property {Record<string, unknown>} arguments
 */

/**
 * @typedef {Object} AiToolDefinition
 * @property {string} name
 * @property {string} description
 * @property {Record<string, unknown>} parameters
 */

/**
 * @typedef {Object} AiUsage
 * @property {number | null} promptTokens
 * @property {number | null} completionTokens
 * @property {number | null} totalTokens
 * @property {number | null} [cost]
 */

/**
 * @typedef {Object} AiCompletionRequest
 * @property {AiMessage[]} messages
 * @property {AiToolDefinition[]} [tools]
 * @property {Record<string, unknown>} [responseFormat]
 * @property {string} [model]
 * @property {number} [temperature]
 * @property {AbortSignal} [signal]
 * @property {string} [operationId]
 */

/**
 * @typedef {Object} AiCompletionResult
 * @property {string} provider
 * @property {string} modelRequested
 * @property {string | null} modelUsed
 * @property {string | null} content
 * @property {AiToolCall[]} toolCalls
 * @property {AiUsage} usage
 * @property {number} durationMs
 * @property {boolean} isMock
 * @property {unknown} [raw]
 */

/**
 * Provider interface contract (documented for implementers).
 *
 * @typedef {Object} AiProvider
 * @property {string} name
 * @property {boolean} isMock
 * @property {(request: AiCompletionRequest) => Promise<AiCompletionResult>} complete
 * @property {() => Promise<{ ok: boolean, detail: string, model?: string | null }>} [testConnection]
 * @property {() => Promise<unknown>} [listModels]
 * @property {() => Record<string, unknown>} getStatus
 */

export {};
