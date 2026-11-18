#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  createTheme,
  installSqliteWarningFilter,
  renderError,
  writeJson,
  writeOutput,
} from '../ui/index.js';
import { parseContentArgs } from '../ui/content-args.js';
import {
  intelligenceErrorPayload,
  openIntelligenceRuntime,
} from '../intelligence-runtime.js';
import {
  renderAiStatus,
  renderDecisionDetail,
  renderDecisionList,
  renderExecuteResult,
  renderPlanDetail,
  renderPlanList,
} from '../ui/render/intelligence.js';
import { ContextKind } from '../../intelligence/constants.js';
import { MockProvider } from '../../intelligence/providers/mock/mock.provider.js';

installSqliteWarningFilter();

const USAGE = `Usage: npm run agent -- <command> [args] [--json]

Commands:
  context show [--kind=brand|business|strategy|...]
  context import <file.json> [--kind=...] [--name=...] [--confirm]
  context versions <context-id>

  history import <file.csv|xlsx> [--worksheet=name] [--confirm] [--allow-invalid]
  history search [--query=...] [--limit=20]

  analyze [--json]
  execute "<instruction>" [--json]

  decisions list [--limit=20]
  decisions show <id>

  plans list [--limit=20]
  plans show <id>
  plans approve <id> [--actor=owner] [--note=...] [--prepare]
  plans reject <id> [--actor=owner] [--note=...]

  ai status
  ai test
  ai models
  ai usage [--limit=20]

  evaluate <decision-id> [--outcome="..."]
`;

async function main() {
  const args = parseContentArgs();
  const theme = createTheme();
  const [command, subcommand, ...rest] = args.positionals;

  if (args.help || !command) {
    writeOutput(theme, USAGE);
    if (!command && !args.help) process.exitCode = 1;
    return;
  }

  const useMock = Boolean(args.flags.mock);
  const runtime = openIntelligenceRuntime({
    provider: useMock ? new MockProvider() : undefined,
  });

  try {
    const result = await dispatch(runtime, {
      command,
      subcommand,
      rest,
      args,
    });

    if (args.json) {
      writeJson(theme, { ok: true, ...wrapResult(command, subcommand, result) });
      return;
    }

    writeOutput(theme, renderHuman(command, subcommand, result, theme, runtime.config));
  } catch (error) {
    if (args.json) {
      writeJson(theme, intelligenceErrorPayload(error));
    } else {
      writeOutput(
        theme,
        renderError(theme, error instanceof Error ? error.message : String(error)),
        'stderr',
      );
    }
    process.exitCode = 1;
  } finally {
    runtime.close();
  }
}

/**
 * @param {ReturnType<typeof openIntelligenceRuntime>} runtime
 * @param {{ command: string, subcommand?: string, rest: string[], args: any }} input
 */
async function dispatch(runtime, input) {
  const { command, subcommand, rest, args } = input;

  if (command === 'context') {
    if (subcommand === 'show') {
      if (args.flags.kind) {
        return {
          items: runtime.contextService.list({ kind: String(args.flags.kind) }),
        };
      }
      return { items: runtime.contextService.list({ limit: 50 }) };
    }
    if (subcommand === 'import') {
      const filePath = rest[0] || String(args.flags.file ?? '');
      if (!filePath) {
        throw usageError('context import requires a JSON file path');
      }
      const payload = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
      const kind = String(args.flags.kind ?? payload.kind ?? ContextKind.COMPOSITE);
      const name = args.flags.name ? String(args.flags.name) : payload.name;
      if (!args.flags.confirm) {
        return {
          preview: true,
          kind,
          name,
          payload,
          note: 'Re-run with --confirm to persist',
        };
      }
      const created = runtime.contextService.register({
        kind,
        name,
        payload: payload.payload ?? payload,
        changedBy: args.flags.actor ? String(args.flags.actor) : 'owner',
        changeSummary: args.flags.note ? String(args.flags.note) : `Imported from ${filePath}`,
      });
      return { created };
    }
    if (subcommand === 'versions') {
      const id = rest[0] || String(args.flags.id ?? '');
      if (!id) throw usageError('context versions requires a context id');
      return { versions: runtime.contextService.listVersions(id) };
    }
    throw usageError('Unknown context subcommand');
  }

  if (command === 'history') {
    if (subcommand === 'import') {
      const filePath = rest[0] || String(args.flags.file ?? '');
      if (!filePath) throw usageError('history import requires a file path');
      return runtime.importService.importFile(path.resolve(filePath), {
        worksheet: args.flags.worksheet ? String(args.flags.worksheet) : undefined,
        confirm: Boolean(args.flags.confirm),
        allowInvalid: Boolean(args.flags.allowInvalid),
        actor: args.flags.actor ? String(args.flags.actor) : 'owner',
      });
    }
    if (subcommand === 'search') {
      return {
        items: runtime.importService.search({
          query: args.flags.query ? String(args.flags.query) : rest.join(' '),
          limit: args.limit || Number(args.flags.limit ?? 20),
          successStatus: args.flags.successStatus
            ? String(args.flags.successStatus)
            : undefined,
        }),
      };
    }
    throw usageError('Unknown history subcommand');
  }

  if (command === 'analyze') {
    return runtime.service.analyze();
  }

  if (command === 'execute') {
    const text = [subcommand, ...rest].filter(Boolean).join(' ').trim();
    if (!text) throw usageError('execute requires an instruction string');
    return runtime.service.execute(text);
  }

  if (command === 'decisions') {
    if (subcommand === 'list') {
      return { items: runtime.service.listDecisions(args.limit || Number(args.flags.limit ?? 20)) };
    }
    if (subcommand === 'show') {
      const id = rest[0] || String(args.flags.id ?? '');
      if (!id) throw usageError('decisions show requires an id');
      return { item: runtime.service.getDecision(id) };
    }
    throw usageError('Unknown decisions subcommand');
  }

  if (command === 'plans') {
    if (subcommand === 'list') {
      return { items: runtime.service.listPlans(args.limit || Number(args.flags.limit ?? 20)) };
    }
    if (subcommand === 'show') {
      const id = rest[0] || String(args.flags.id ?? '');
      if (!id) throw usageError('plans show requires an id');
      return { item: runtime.service.getPlan(id) };
    }
    if (subcommand === 'approve') {
      const id = rest[0] || String(args.flags.id ?? '');
      if (!id) throw usageError('plans approve requires an id');
      return runtime.service.approvePlan(id, {
        actor: args.flags.actor ? String(args.flags.actor) : 'owner',
        note: args.flags.note ? String(args.flags.note) : '',
        prepareExecution: Boolean(args.flags.prepare),
      });
    }
    if (subcommand === 'reject') {
      const id = rest[0] || String(args.flags.id ?? '');
      if (!id) throw usageError('plans reject requires an id');
      return runtime.service.rejectPlan(id, {
        actor: args.flags.actor ? String(args.flags.actor) : 'owner',
        note: args.flags.note ? String(args.flags.note) : '',
      });
    }
    throw usageError('Unknown plans subcommand');
  }

  if (command === 'ai') {
    if (subcommand === 'status') return { status: runtime.service.aiStatus() };
    if (subcommand === 'test') return { result: await runtime.service.aiTest() };
    if (subcommand === 'models') return await runtime.service.aiModels();
    if (subcommand === 'usage') {
      return {
        items: runtime.service.aiUsage(args.limit || Number(args.flags.limit ?? 20)),
      };
    }
    throw usageError('Unknown ai subcommand');
  }

  if (command === 'evaluate') {
    const id = subcommand || String(args.flags.id ?? '');
    if (!id) throw usageError('evaluate requires a decision id');
    return {
      evaluation: runtime.evaluator.evaluate(id, {
        outcomeSummary: args.flags.outcome ? String(args.flags.outcome) : undefined,
      }),
    };
  }

  throw usageError(`Unknown command: ${command}`);
}

/**
 * @param {string} message
 */
function usageError(message) {
  const error = new Error(message);
  error.code = 'USAGE';
  return error;
}

function wrapResult(command, subcommand, result) {
  return { command, subcommand: subcommand ?? null, result };
}

function renderHuman(command, subcommand, result, theme, config) {
  if (command === 'execute' || command === 'analyze') {
    return renderExecuteResult(result, theme, { timezone: config.appTimezone });
  }
  if (command === 'decisions' && subcommand === 'list') {
    return renderDecisionList(result.items, theme, { timezone: config.appTimezone });
  }
  if (command === 'decisions' && subcommand === 'show') {
    return renderDecisionDetail(result.item, theme, { timezone: config.appTimezone });
  }
  if (command === 'plans' && subcommand === 'list') {
    return renderPlanList(result.items, theme, { timezone: config.appTimezone });
  }
  if (command === 'plans' && subcommand === 'show') {
    return renderPlanDetail(result.item, theme, { timezone: config.appTimezone });
  }
  if (command === 'plans' && (subcommand === 'approve' || subcommand === 'reject')) {
    return renderPlanDetail(result.plan, theme, { timezone: config.appTimezone });
  }
  if (command === 'ai' && subcommand === 'status') {
    return renderAiStatus(result.status, theme);
  }
  return JSON.stringify(result, null, 2);
}

main();
