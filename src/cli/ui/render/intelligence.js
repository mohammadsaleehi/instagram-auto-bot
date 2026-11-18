import {
  formatDateTime,
  truncateId,
  truncateText,
} from '../format.js';
import {
  renderDivider,
  renderHeader,
  renderKeyValue,
  renderSectionTitle,
  renderTable,
} from '../layout.js';

/**
 * @param {any} theme
 * @param {Array<[string, unknown]>} pairs
 */
function renderPairs(theme, pairs) {
  return pairs
    .map(([label, value]) =>
      renderKeyValue(theme, {
        label,
        value: value === null || value === undefined ? '' : String(value),
        tone: 'muted',
        marker: 'bullet',
      }),
    )
    .join('\n');
}

/**
 * @param {any} result
 * @param {any} theme
 * @param {{ timezone?: string }} [options]
 */
export function renderExecuteResult(result, theme, options = {}) {
  const lines = [
    renderHeader(theme, 'Intelligence Execute', result.operationId),
    renderDivider(theme),
    renderPairs(theme, [
      ['Status', result.status],
      ['Provider', result.isMock ? 'mock (deterministic, not real AI)' : 'openrouter'],
      ['Instruction', truncateId(result.instruction?.id ?? '', 12)],
    ]),
  ];

  if (result.status === 'needs_clarification') {
    lines.push(renderSectionTitle(theme, 'Clarification required'));
    for (const item of result.parsed?.missingPrerequisites ?? []) {
      lines.push(`- ${item}`);
    }
    for (const item of result.parsed?.ambiguities ?? []) {
      lines.push(`- ${item}`);
    }
    return lines.join('\n');
  }

  if (result.decision) {
    lines.push(renderSectionTitle(theme, 'Decision'));
    lines.push(
      renderPairs(theme, [
        ['ID', result.decision.id],
        ['Type', result.decision.decisionType],
        ['Confidence', result.decision.confidence],
        ['Model', result.decision.modelUsed ?? result.decision.modelRequested ?? 'n/a'],
      ]),
    );
    lines.push(truncateText(result.decision.selectedDecision, theme.columns));
    lines.push('');
    lines.push(truncateText(result.decision.reasoningSummary, theme.columns * 2));
  }

  if (result.plan) {
    lines.push(renderSectionTitle(theme, 'Execution plan'));
    lines.push(
      renderPairs(theme, [
        ['ID', result.plan.id],
        ['Status', result.plan.status],
        ['Risk', result.plan.riskLevel],
        ['Steps', result.plan.steps?.length ?? 0],
      ]),
    );
    for (const step of result.plan.steps ?? []) {
      lines.push(`${step.stepIndex + 1}. ${step.title}`);
    }
  }

  if (options.timezone) {
    lines.push('');
    lines.push(`Timezone: ${options.timezone}`);
  }

  return lines.join('\n');
}

/**
 * @param {any[]} decisions
 * @param {any} theme
 * @param {{ timezone?: string }} [options]
 */
export function renderDecisionList(decisions, theme, options = {}) {
  if (!decisions.length) {
    return 'No decisions recorded.';
  }
  return renderTable(theme, {
    columns: [
      { key: 'id', header: 'ID', width: 10 },
      { key: 'status', header: 'Status', width: 16 },
      { key: 'confidence', header: 'Conf', width: 6 },
      { key: 'createdAt', header: 'Created', width: 20 },
      { key: 'selectedDecision', header: 'Decision', width: 40 },
    ],
    rows: decisions.map((item) => ({
      id: truncateId(item.id),
      status: item.status,
      confidence: item.confidence ?? '',
      createdAt: formatDateTime(item.createdAt, { timezone: options.timezone }),
      selectedDecision: truncateText(item.selectedDecision, 40),
    })),
  });
}

/**
 * @param {any} decision
 * @param {any} theme
 * @param {{ timezone?: string }} [options]
 */
export function renderDecisionDetail(decision, theme, options = {}) {
  return [
    renderHeader(theme, 'Decision', decision.id),
    renderDivider(theme),
    renderPairs(theme, [
      ['Status', decision.status],
      ['Type', decision.decisionType],
      ['Confidence', decision.confidence],
      ['Provider', decision.provider],
      ['Model', decision.modelUsed ?? decision.modelRequested],
      ['Prompt', decision.promptVersion],
      ['Created', formatDateTime(decision.createdAt, { timezone: options.timezone })],
    ]),
    renderSectionTitle(theme, 'Selected decision'),
    decision.selectedDecision,
    renderSectionTitle(theme, 'Reasoning'),
    decision.reasoningSummary,
    renderSectionTitle(theme, 'Missing information'),
    ...(decision.missingInformation?.length
      ? decision.missingInformation.map((item) => `- ${item}`)
      : ['- none recorded']),
  ].join('\n');
}

/**
 * @param {any[]} plans
 * @param {any} theme
 * @param {{ timezone?: string }} [options]
 */
export function renderPlanList(plans, theme, options = {}) {
  if (!plans.length) return 'No plans recorded.';
  return renderTable(theme, {
    columns: [
      { key: 'id', header: 'ID', width: 10 },
      { key: 'status', header: 'Status', width: 18 },
      { key: 'approval', header: 'Approval', width: 12 },
      { key: 'risk', header: 'Risk', width: 8 },
      { key: 'steps', header: 'Steps', width: 6 },
      { key: 'createdAt', header: 'Created', width: 20 },
    ],
    rows: plans.map((item) => ({
      id: truncateId(item.id),
      status: item.status,
      approval: item.approvalStatus,
      risk: item.riskLevel,
      steps: item.steps?.length ?? 0,
      createdAt: formatDateTime(item.createdAt, { timezone: options.timezone }),
    })),
  });
}

/**
 * @param {any} plan
 * @param {any} theme
 * @param {{ timezone?: string }} [options]
 */
export function renderPlanDetail(plan, theme, options = {}) {
  const lines = [
    renderHeader(theme, 'Execution plan', plan.id),
    renderDivider(theme),
    renderPairs(theme, [
      ['Status', plan.status],
      ['Approval', plan.approvalStatus],
      ['Risk', plan.riskLevel],
      ['Decision', truncateId(plan.decisionId, 12)],
      ['Created', formatDateTime(plan.createdAt, { timezone: options.timezone })],
    ]),
    renderSectionTitle(theme, 'Objective'),
    plan.objective,
    renderSectionTitle(theme, 'Steps'),
  ];
  for (const step of plan.steps ?? []) {
    lines.push(
      `${step.stepIndex + 1}. [${step.status}] ${step.title}${step.toolName ? ` (${step.toolName})` : ''}`,
    );
  }
  return lines.join('\n');
}

/**
 * @param {any} status
 * @param {any} theme
 */
export function renderAiStatus(status, theme) {
  return [
    renderHeader(theme, 'AI Provider Status'),
    renderDivider(theme),
    renderPairs(theme, [
      ['Provider', status.provider],
      ['Mock', status.isMock ? 'yes' : 'no'],
      ['Configured', status.configured ? 'yes' : 'no'],
      ['ModelConfigured', status.modelConfigured ? 'yes' : 'no'],
      ['Model', status.model ?? '(not set)'],
      ['FallbackModels', (status.fallbackModels ?? []).join(', ') || '(none)'],
      ['BaseURL', status.baseUrl ?? '(n/a)'],
      ['AppName', status.appName ?? ''],
      ['ApiKey', status.hasApiKey ? '[SET]' : '[MISSING]'],
    ]),
  ].join('\n');
}
