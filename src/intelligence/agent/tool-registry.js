import { IntelligenceError, PermissionAction } from '../constants.js';

/**
 * Application-owned tools. The model may request them; the app executes them.
 */
export class ToolRegistry {
  constructor() {
    /** @type {Map<string, {
     *   name: string,
     *   description: string,
     *   parameters: Record<string, unknown>,
     *   permission: string,
     *   execute: (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown> | unknown
     * }>} */
    this.tools = new Map();
  }

  /**
   * @param {{
   *   name: string,
   *   description: string,
   *   parameters?: Record<string, unknown>,
   *   permission?: string,
   *   execute: (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown> | unknown
   * }} tool
   */
  register(tool) {
    if (!tool?.name || typeof tool.execute !== 'function') {
      throw new IntelligenceError('Invalid tool definition', { code: 'INVALID_TOOL' });
    }
    this.tools.set(tool.name, {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
      permission: tool.permission ?? PermissionAction.EXECUTE_INTERNAL_TOOL,
      execute: tool.execute,
    });
  }

  /**
   * @returns {import('../providers/provider.interface.js').AiToolDefinition[]}
   */
  listDefinitions() {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /**
   * @param {string} name
   */
  get(name) {
    return this.tools.get(name) ?? null;
  }
}

/**
 * @param {{
 *   contextService: import('../context/context-service.js').ContextService,
 *   importService: import('../import/import-service.js').ImportService,
 *   historyRepository: import('../import/history-repository.js').HistoryRepository,
 * }} deps
 */
export function createDefaultToolRegistry(deps) {
  const registry = new ToolRegistry();

  registry.register({
    name: 'get_business_context',
    description: 'Retrieve the currently active brand, business, and strategy context.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    permission: PermissionAction.READ_CONTEXT,
    execute: () => deps.contextService.getRelevantBusinessContext(),
  });

  registry.register({
    name: 'search_historical_decisions',
    description: 'Search imported historical decisions by keyword and optional success status.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        successStatus: { type: 'string' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    permission: PermissionAction.SEARCH_HISTORY,
    execute: (args) =>
      deps.importService.search({
        query: args.query ? String(args.query) : '',
        successStatus: args.successStatus ? String(args.successStatus) : undefined,
        limit: args.limit ? Number(args.limit) : 20,
      }),
  });

  registry.register({
    name: 'list_context_versions',
    description: 'List version history for a context record.',
    parameters: {
      type: 'object',
      properties: {
        contextId: { type: 'string' },
      },
      required: ['contextId'],
      additionalProperties: false,
    },
    permission: PermissionAction.READ_CONTEXT,
    execute: (args) => deps.contextService.listVersions(String(args.contextId)),
  });

  return registry;
}
