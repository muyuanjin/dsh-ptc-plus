function valueRange(values) {
  if (values.length === 0) return undefined
  let min = values[0]
  let max = values[0]
  for (const value of values.slice(1)) {
    if (value < min) min = value
    if (value > max) max = value
  }
  return { min, max }
}

export function summarizeRuntimeSnapshots(snapshots) {
  const ptcPlus = snapshots.filter(snapshot => snapshot.ptcPlusSectionChars > 0)
  return {
    count: snapshots.length,
    ptcPlusCount: ptcPlus.length,
    ptcPlusMessageChars: valueRange(ptcPlus.map(snapshot => snapshot.messageChars)),
    ptcPlusSectionChars: valueRange(ptcPlus.map(snapshot => snapshot.ptcPlusSectionChars)),
    otherSectionChars: valueRange(ptcPlus.map(snapshot => snapshot.otherSectionChars)),
  }
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim()
}

export function scenarioMarkdown(report) {
  const cells = report.timeline.flatMap((cell, index) => [
    `### Cell ${index + 1}: ${cell.description ?? 'missing description'}`,
    '',
    `- result: ${cell.isError ? 'error' : 'ok'}; journal: ${cell.journalStatus ?? 'missing'}; nested calls: ${cell.nestedCalls?.length ?? 0}; output: ${cell.outputChars ?? 0} chars`,
    '',
    '```ts',
    cell.code ?? '',
    '```',
    '',
  ])
  return [
    `# ${report.scenario.title}`,
    '',
    `- scenario: ${report.scenario.id}`,
    `- task: ${report.scenario.task}`,
    `- session: ${report.session.id ?? 'missing'}`,
    `- model: ${report.model?.provider ?? 'missing'}/${report.model?.model ?? 'missing'}`,
    `- events: ${report.eventCount}`,
    `- logical model requests: ${report.modelRequests}; header epochs: ${report.headerEpochs}; header changes: ${report.headerChanges}; history replacements: ${report.historyReplacements}`,
    `- PTC direct calls/results: ${report.toolCallCount}/${report.toolResultCount}`,
    report.usageComplete === false ? '- model tokens: unknown (incomplete accounting)' : `- model tokens: input ${report.usage.inputTokens}, cache read ${report.usage.cacheReadTokens}, cache write ${report.usage.cacheWriteTokens}, output ${report.usage.outputTokens}`,
    `- final answer: ${report.finalAnswerChars} chars`,
    ...(report.programWork?.observations ?? []).map(item =>
      `- workload ${item.global}.${item.member}: ${item.calls} calls; ${item.repeatedArgumentCalls} repeated-argument calls`),
    '',
    '## Prompt Audit',
    '',
    '| Check | Value |',
    '| --- | --- |',
    `| system prompt | ${report.prompt.chars} chars |`,
    `| model-visible tools | ${markdownCell(report.prompt.modelTools.join(', ') || 'missing')} |`,
    `| program SDK | tools=${report.prompt.hasToolsSdk}, repl=${report.prompt.hasReplSdk}, capabilities=${report.prompt.hasCapabilitiesSdk}, code=${report.prompt.hasCodeSdk} |`,
    `| runtime snapshots | ${report.prompt.runtimeSnapshots.length}; PTC Plus-bearing=${summarizeRuntimeSnapshots(report.prompt.runtimeSnapshots).ptcPlusCount} |`,
    '',
    '## Cells',
    '',
    ...cells,
    '## Diagnostics',
    '',
    ...(report.diagnostics.length === 0 ? ['none'] : report.diagnostics.map(item => `- ${item}`)),
    '',
    '## Failures',
    '',
    ...(report.failures.length === 0 ? ['none'] : report.failures.map(item => `- ${item}`)),
    '',
  ].join('\n')
}

export function summaryMarkdown(summary) {
  const snapshot = summary.runtimeSnapshots
  const range = value => value === undefined
    ? 'none'
    : value.min === value.max ? String(value.min) : `${value.min}-${value.max}`
  return [
    '# Expensive DSH multi-scenario acceptance',
    '',
    `- model: ${summary.runtime.provider}/${summary.runtime.model}`,
    `- DSH: ${summary.runtime.dshVersion ?? 'unrecorded'}; command: ${summary.runtime.dshCommand ?? 'unrecorded'}`,
    `- profile/tools mode: ${summary.runtime.profile}/${summary.runtime.toolsMode}`,
    `- permission mode: ${summary.runtime.permissionMode}`,
    `- concurrency: ${summary.runtime.concurrency}`,
    `- scenarios: ${summary.scenarios.length}`,
    summary.usageComplete === false ? '- model tokens: unknown (incomplete accounting)' : `- model tokens: input ${summary.usage.inputTokens}, cache read ${summary.usage.cacheReadTokens}, cache write ${summary.usage.cacheWriteTokens}, output ${summary.usage.outputTokens}`,
    '',
    '| Scenario | Process | Cells | Journal | Failures |',
    '| --- | ---: | ---: | --- | ---: |',
    ...summary.scenarios.map(item => `| ${item.id} | ${item.processCode} | ${item.toolCallCount} | ${markdownCell(item.statuses.join(', '))} | ${item.failures.length} |`),
    '',
    '## Runtime Context Snapshots',
    '',
    `- snapshots: ${snapshot.count}; PTC Plus-bearing: ${snapshot.ptcPlusCount}`,
    `- PTC Plus-bearing message chars: ${range(snapshot.ptcPlusMessageChars)}; PTC Plus section chars: ${range(snapshot.ptcPlusSectionChars)}; other-owner section chars: ${range(snapshot.otherSectionChars)}`,
    '- Runtime snapshots append at the history tail; these measurements describe context growth, not stable-prefix invalidation.',
    '',
    '## Failures',
    '',
    ...(summary.failures.length === 0 ? ['none'] : summary.failures.map(item => `- ${item}`)),
    '',
  ].join('\n')
}
