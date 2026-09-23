export function paragraphs(text) {
  return text.split(/\n\s*\n/).map(value => value.replace(/\s+/g, ' ').trim()).filter(value => value.length >= 40)
}

export function duplicateParagraphs(text) {
  const counts = new Map()
  for (const paragraph of paragraphs(text)) counts.set(paragraph, (counts.get(paragraph) ?? 0) + 1)
  return [...counts.entries()].filter(([, count]) => count > 1).map(([text, count]) => ({ text, count }))
}

export function multisetDifference(left, right) {
  const remaining = new Map()
  for (const value of right) remaining.set(value, (remaining.get(value) ?? 0) + 1)
  const difference = []
  for (const value of left) {
    const count = remaining.get(value) ?? 0
    if (count > 0) remaining.set(value, count - 1)
    else difference.push(value)
  }
  return difference
}

export function trajectoryDelta(plugin, baseline) {
  const fields = [
    'eventCount', 'modelRequests', 'headerEpochs', 'headerChanges', 'historyReplacements', 'turnWallMs', 'toolCallCount', 'toolErrorCount', 'ptcWarningCount', 'nestedCallCount', 'nestedErrorCount',
    'sourceChars', 'repeatedSourceCalls', 'resultOutputChars', 'assistantTextChars', 'finalAnswerChars', 'questionMarks',
  ]
  const result = Object.fromEntries(fields.map(field => [field, plugin[field] - baseline[field]]))
  for (const field of Object.keys(plugin.usage)) {
    result[field] = plugin.usageComplete === false || baseline.usageComplete === false
      ? null : plugin.usage[field] - baseline.usage[field]
  }
  result.promptChars = plugin.prompt.chars - baseline.prompt.chars
  result.promptBytes = plugin.prompt.bytes - baseline.prompt.bytes
  result.runCodeSchemaChars = plugin.prompt.runCodeSchemaChars - baseline.prompt.runCodeSchemaChars
  return result
}

export function aggregateTrajectories(sessions, variant) {
  const selected = sessions.filter(session => session.variant === variant)
  const sum = field => selected.reduce((total, session) => total + session[field], 0)
  const result = {
    sessions: selected.length,
    inputTokens: selected.reduce((total, session) => total + session.usage.inputTokens, 0),
    cacheReadTokens: selected.reduce((total, session) => total + session.usage.cacheReadTokens, 0),
    cacheWriteTokens: selected.reduce((total, session) => total + session.usage.cacheWriteTokens, 0),
    outputTokens: selected.reduce((total, session) => total + session.usage.outputTokens, 0),
    modelRequests: sum('modelRequests'),
    headerEpochs: sum('headerEpochs'),
    headerChanges: sum('headerChanges'),
    historyReplacements: sum('historyReplacements'),
    toolCalls: sum('toolCallCount'),
    toolErrors: sum('toolErrorCount'),
    ptcWarnings: sum('ptcWarningCount'),
    nestedCallsObserved: sum('nestedCallCount'),
    nestedErrorsObserved: sum('nestedErrorCount'),
    sourceChars: sum('sourceChars'),
    resultOutputChars: sum('resultOutputChars'),
    assistantTextChars: sum('assistantTextChars'),
    uncertaintySignals: selected.reduce((total, session) => total + session.uncertaintySignals.length, 0),
    failures: selected.reduce((total, session) => total + session.failures.length, 0),
    taskPasses: selected.filter(session => session.taskValidation?.status === 'pass').length,
    taskFailures: selected.filter(session => session.taskValidation?.status === 'fail').length,
    taskBlindPending: selected.filter(session => session.taskValidation?.status === 'blind-pending').length,
  }
  result.totalTraffic = result.inputTokens + result.cacheReadTokens + result.cacheWriteTokens + result.outputTokens
  result.usageComplete = selected.every(session => session.usageComplete !== false)
  if (!result.usageComplete) {
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTraffic']) result[key] = null
  }
  return result
}

function metricRow(pair) {
  const p = pair.plugin
  const b = pair.baseline
  const usage = (session, key) => session.usageComplete === false ? 'unknown' : session.usage[key]
  return `| ${pair.taskId} / ${pair.replicate} | ${p.modelRequests}/${b.modelRequests} | ${p.headerEpochs}/${b.headerEpochs} | ${p.headerChanges}/${b.headerChanges} | ${p.toolCallCount}/${b.toolCallCount} | ${p.ptcWarningCount}/${b.ptcWarningCount} | ${usage(p, 'inputTokens')}/${usage(b, 'inputTokens')} | ${usage(p, 'cacheReadTokens')}/${usage(b, 'cacheReadTokens')} | ${usage(p, 'outputTokens')}/${usage(b, 'outputTokens')} | ${p.sourceChars}/${b.sourceChars} | ${p.resultOutputChars}/${b.resultOutputChars} | ${p.turnWallMs}/${b.turnWallMs} | ${p.failures.length}/${b.failures.length} |`
}

export function reportMarkdown(report) {
  return [
    '# PTC Plus ordinary-task A/B trajectories',
    '',
    `- model: ${report.runtime.provider}/${report.runtime.model}`,
    `- DSH: ${report.runtime.dshVersion}; command: ${report.runtime.dshCommand ?? 'unrecorded'}`,
    `- permission: ${report.runtime.permissionMode}`,
    `- fixture: ${report.fixture?.path ?? 'unknown'} v${report.fixture?.version ?? 'unknown'} (${report.fixture?.contentSha256?.slice(0, 12) ?? 'unknown'})`,
    `- replicates: ${report.runtime.replicates}`,
    `- tasks: ${report.tasks.length}`,
    `- sessions: ${report.sessions.length}`,
    `- machine acceptance: ${report.machineAcceptance.status}`,
    `- blind review: ${report.blindReview.status}`,
    `- approval: ${report.approval.status}`,
    '',
    '## Prompt Delta',
    '',
    `- plugin: ${report.promptComparison.pluginChars} chars`,
    `- baseline: ${report.promptComparison.baselineChars} chars`,
    `- delta: ${report.promptComparison.deltaChars} chars`,
    `- plugin-only paragraphs: ${report.promptComparison.pluginOnlyParagraphs.length}`,
    `- baseline-only paragraphs: ${report.promptComparison.baselineOnlyParagraphs.length}`,
    `- duplicate long paragraphs: plugin ${report.promptComparison.pluginDuplicateParagraphs.length}, baseline ${report.promptComparison.baselineDuplicateParagraphs.length}`,
    '',
    '## Aggregate',
    '',
    '| Variant | Sessions | Input | Cache read | Cache write | Output | Total traffic | Model requests | Header epochs | Header changes | History replacements | Tool calls | Failed tool calls | PTC warnings | Source chars | Result chars | Assistant chars | Machine pass/fail | Blind pending | Infrastructure failures |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...['plugin', 'baseline'].map(variant => {
      const value = report.aggregate[variant]
      return `| ${variant} | ${value.sessions} | ${value.inputTokens} | ${value.cacheReadTokens} | ${value.cacheWriteTokens} | ${value.outputTokens} | ${value.totalTraffic} | ${value.modelRequests} | ${value.headerEpochs} | ${value.headerChanges} | ${value.historyReplacements} | ${value.toolCalls} | ${value.toolErrors} | ${value.ptcWarnings} | ${value.sourceChars} | ${value.resultOutputChars} | ${value.assistantTextChars} | ${value.taskPasses}/${value.taskFailures} | ${value.taskBlindPending} | ${value.failures} |`
    }),
    '',
    '## Pairs',
    '',
    '| Task / replicate | Model requests P/B | Header epochs P/B | Header changes P/B | Tool calls P/B | PTC warnings P/B | Input P/B | Cache read P/B | Output P/B | Source chars P/B | Result chars P/B | Turn ms P/B | Failures P/B |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.pairs.map(metricRow),
    '',
    'Full prompts, raw sessions, trajectories, final answers, deterministic metrics, and the blinded review map are stored beside this report.',
    '',
  ].join('\n')
}
