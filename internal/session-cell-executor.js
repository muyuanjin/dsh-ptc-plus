import {
  decodeValue,
  encodeValue,
  normalizeValueWire,
  prepareValueWire,
  valueWiresEqual,
} from './value-wire.js'
import { diagnostic, renderDiagnostic } from './diagnostic.js'
import { normalizeBindingDescriptors } from './binding-descriptors.js'
import {
  firstLine,
  cellPosition,
  exceptionOriginPosition,
  limitLogs,
  LONG_CELL_CODE_UNITS,
  markBindingFailure,
  messageOf,
  missingDescriptionPath,
  oneLineMessage,
  safeProperty,
} from './failure-reporting.js'
import { assertStateName, LIVE_USER_BINDINGS_REUSE_POLICY } from './session-journal.js'
import { LIVE_USER_BINDINGS_SHADOW_POLICY, normalizeUserBindingNames } from './session-journal-schema.js'
import { PreflightError, prepareProgram } from './compiler-service.js'
import { executionPolicies } from './binding-update-policy.js'
import { createReplMemorySnapshot } from './repl-memory-projection.js'
import { ModuleRewriteError } from './cell-error.js'
import { mapSourcePosition } from './source-position-map.js'
import { durabilityState, transitionDurability } from './session-state.js'
import { dynamicBindingOrigin } from './dynamic-binding-evidence.js'
import { validatedEofClosureRepair } from './validated-parse-repair.js'
import {
  normalizeUserBindingsSnapshot,
  selectUserBindingsSnapshot,
} from './user-bindings.js'

const OUTPUT_LIMIT_MESSAGE = bytes => `output exceeded ${bytes} bytes; this cell was discarded and the worker reset. Only bindings in the verified recovery frontier can be restored. External effects may already have occurred and are not undone. For future cells, bound console output and return a smaller value; do not assume this cell's values remain available.`

function earlyResult(kind, message) {
  return { logs: [], error: { kind, message } }
}

function desiredDurability(kernel, replayRecord, prepared, config) {
  if (replayRecord !== undefined) return 'durable'
  if (!config.durableReplay || kernel.durability.status === 'volatile') return 'volatile'
  return prepared.durability
}

function hostCause(error) {
  const candidate = safeProperty(error, 'diagnostic') ?? safeProperty(error, 'cause') ?? error
  const candidateMessage = safeProperty(candidate, 'message')
  const message = firstLine(candidateMessage, oneLineMessage(error))
  const candidateCode = safeProperty(candidate, 'code')
  const errorCode = safeProperty(error, 'code')
  const code = firstLine(candidateCode, firstLine(errorCode, undefined))
  return { ...(code === undefined ? {} : { code }), message }
}

function isBindingReferenceError(error) {
  return error.name === 'ReferenceError'
    && (/\bis not defined\b/.test(error.message)
      || /Cannot access ['"][^'"]+['"] before initialization/.test(error.message))
}

/**
 * Parse failures carry original cell coordinates in ModuleRewriteError.cellPosition; the rewriter
 * owns any generated-source mapping, so the executor never re-applies wrapper offsets.
 */
function parseCellPosition(error) {
  const cellPosition = error instanceof ModuleRewriteError ? error.cellPosition : undefined
  return Number.isSafeInteger(cellPosition?.line) && cellPosition.line >= 1
    && Number.isSafeInteger(cellPosition?.column) && cellPosition.column >= 1
    ? { line: cellPosition.line, column: cellPosition.column }
    : undefined
}

function parseDiagnostic(error, source, position, repair) {
  return diagnostic({
    code: 'PTC-C001',
    severity: 'error',
    phase: 'parse',
    message: `cell could not be parsed: ${oneLineMessage(error)}`,
    stateEffect: 'unchanged',
    ...(position === undefined ? {} : {
      source: { cell: 'current', start: position },
    }),
    help: repair === undefined
      ? source.length >= LONG_CELL_CODE_UNITS
        ? ['this cell was not executed; when edit_run_code is declared for the current request and the correction is small and localized, use it to avoid resending this long source; otherwise retry only this cell with corrected source in run_code']
        : ['this cell was not executed; correct the reported syntax and retry only this cell with run_code']
      : [
          `this cell was not executed; validated syntax repair: append ${JSON.stringify(repair.delimiter)} at the end of this cell`,
          `when this correction matches your intent and edit_run_code is declared, prefer the direct tool call ${repair.invocation} with its target guard to run the complete corrected cell; validation proves syntax/preflight acceptance, not intended behavior; otherwise submit corrected source in run_code`,
        ],
  })
}

function preflightDiagnostic(error) {
  return diagnostic({
    code: 'PTC-C002',
    severity: 'error',
    phase: 'preflight',
    message: oneLineMessage(error),
    stateEffect: 'unchanged',
    /* c8 ignore next */
    ...(error.span === undefined ? {} : {
      source: {
        cell: 'current',
        start: { line: error.span.line, column: error.span.column },
        /* c8 ignore next */
        ...(error.span.end === undefined ? {} : { end: error.span.end }),
      },
    }),
    help: ['remove the kernel-control import and use the provided REPL or tools bindings'],
  })
}

function committedRedeclarationSet(message, prepared) {
  if (!Array.isArray(message.committedRedeclarations)) {
    throw new Error('kernel returned an invalid committed redeclaration set')
  }
  const allowed = prepared.commitTargets
  const committed = new Set()
  for (const name of message.committedRedeclarations) {
    if (typeof name !== 'string' || committed.has(name) || !allowed.has(name)) {
      throw new Error('kernel returned an invalid committed redeclaration set')
    }
    committed.add(name)
  }
  return committed
}

/** Accept value-free worker facts only for this compilation's logical root. */
function completedRootBindingFacts(message, prepared, committed) {
  if (prepared.rootRuntimeName === undefined && prepared.rootBindingFacts !== true) return undefined
  if (!Array.isArray(message.rootBindingFacts)) throw new TypeError('kernel returned invalid root binding facts')
  const established = new Map(prepared.rootBindings.established)
  const initialized = new Set(prepared.declarations.filter(declaration => committed.has(declaration.commitDependency)
    && (prepared.languageSemantics !== 'legacy-v1' || established.has(declaration.name)))
    .map(declaration => declaration.name))
  const candidates = new Map(prepared.rootBindings.candidates)
  const dynamicOrigins = new Set(prepared.rootBindings.dynamicOrigins)
  const available = new Set([...prepared.rootBindings.known, ...established.keys(), ...initialized])
  const allowed = new Set([...available, ...candidates.values()])
  const required = new Set([...established.keys(), ...initialized])
  const imports = new Set([...prepared.rootBindings.legacyImports.map(([name]) => name),
    ...[...established].filter(([, source]) => source === 'import').map(([name]) => name),
    ...prepared.declarations.filter(declaration => declaration.kind === 'import' && committed.has(declaration.commitDependency))
      .map(declaration => declaration.name)])
  const seen = new Set()
  const facts = message.rootBindingFacts.map(fact => {
    const dynamicOrigin = dynamicBindingOrigin(fact?.write, fact?.name, dynamicOrigins)
    if (fact === null || typeof fact !== 'object' || Array.isArray(fact)
      || Object.keys(fact).length !== (Object.hasOwn(fact, 'write') ? 3 : 2)
      || !Object.hasOwn(fact, 'name') || !Object.hasOwn(fact, 'source')
      || typeof fact.name !== 'string' || !allowed.has(fact.name) && dynamicOrigin === undefined || seen.has(fact.name)
      || !['local', 'import', 'absent'].includes(fact.source)
      || Object.hasOwn(fact, 'write') && (typeof fact.write !== 'string'
        || candidates.get(fact.write) !== fact.name && dynamicOrigin === undefined || fact.source === 'import')
      || !available.has(fact.name) && !Object.hasOwn(fact, 'write')
      || fact.source === 'import' && !imports.has(fact.name)
      || fact.source === 'absent' && initialized.has(fact.name)) throw new TypeError('kernel returned invalid root binding facts')
    seen.add(fact.name)
    required.delete(fact.name)
    return { name: fact.name, source: fact.source, ...(Object.hasOwn(fact, 'write') ? { write: fact.write } : {}) }
  })
  if (required.size !== 0) throw new TypeError('kernel returned incomplete root binding facts')
  return facts
}

function completedUserBindingNames(active, message, snapshot) {
  const facts = normalizeUserBindingNames(message.userBindingNames)
  const required = active.userBindingBaseCatalog.userBindingNameSet(snapshot)
  const allowed = active.userBindingBaseCatalog.userBindingNameSet(snapshot, true)
  const providers = new Map((snapshot?.entries ?? []).flatMap(entry => (
    (entry.scope === 'namespace' ? [entry.name] : entry.symbols).map(name => [name, entry.id])
  )))
  for (const fact of facts) {
    if (!allowed.has(fact.name) || (fact.state === 'provider'
      && (providers.get(fact.name) !== fact.entryId || active.request.bindingDescriptors.reservedNames.has(fact.name)))) {
      throw new TypeError('kernel returned user binding name evidence with invalid ownership')
    }
    required.delete(fact.name)
  }
  if (required.size !== 0) throw new TypeError('kernel returned incomplete user binding name evidence')
  if (active.replay !== undefined && JSON.stringify(facts) !== JSON.stringify(active.replay.userBindingNames)) {
    throw new TypeError('cell replay produced different user binding name evidence')
  }
  return facts
}

function validateUserBindingActivation(active, message, ids) {
  if (!Array.isArray(message.userBindingFailures)) throw new TypeError('kernel returned invalid user binding failures')
  const expected = new Set(active.userBindings.entries.map(entry => entry.id))
  for (const id of ids) expected.delete(id)
  for (const failure of message.userBindingFailures) {
    if (failure === null || typeof failure !== 'object' || Object.keys(failure).length !== 2
      || typeof failure.error !== 'string' || !expected.delete(failure.id)) {
      throw new TypeError('kernel returned invalid user binding failures')
    }
  }
  if (expected.size !== 0) throw new TypeError('kernel omitted user binding activation outcomes')
  if ([...ids].some(id => active.userBindingFailures.some(failure => failure.id === id))) {
    throw new TypeError('kernel activated a request-owned user binding name')
  }
}

/** A reserved program binding (`tools` and the injected error classes) is not shadowable at the
 * session root, so a collision on it is not a repeated declaration. The collision producer records
 * that reason, and rendering the recorded reason keeps "top-level bindings already exist" from
 * implying the cell redeclared a name the session never created. */
const RESERVED_BINDING_REASON = 'reserved-program-binding-not-shadowable'
/** Reasons whose only remaining guidance is to reuse the binding already in session state. */
const REUSE_BINDING_REASONS = new Set([
  'variable-redeclarations-disabled', 'redeclaration-splitting-disabled', 'protected-root-redeclaration',
  'import-binding-redeclaration', RESERVED_BINDING_REASON,
])

function reservedBindingNote(collisions) {
  const reserved = [...new Set(collisions.filter(collision => collision.reason === RESERVED_BINDING_REASON)
    .map(collision => collision.name))]
  return reserved.length === 0
    ? ''
    : ` ${reserved.join(', ')} cannot be redeclared or overwritten because reserved program bindings are not shadowable.`
}

/** The model-visible structured form of every recorded collision, reduced to public fields. */
function collisionRecords(collisions) {
  return collisions.map(collision => ({ name: collision.name, kind: collision.kind,
    reason: collision.reason, start: collision.start, end: collision.end }))
}

function collisionDiagnostic(collisions) {
  const names = [...new Set(collisions.map(item => item.name))]
  const reasons = new Set(collisions.map(item => item.reason).filter(Boolean))
  const disabledKinds = new Set(collisions
    .filter(item => item.reason === 'function-class-redeclarations-disabled')
    .map(item => item.kind))
  const first = collisions[0]
  const alternatives = [
    ...(disabledKinds.size === 2
      ? ['assign function or class expressions to the existing writable bindings']
      : disabledKinds.has('function')
        ? ['assign a function expression to the existing writable binding']
        : disabledKinds.has('class')
          ? ['assign a class expression to the existing writable binding']
          : []),
    ...((reasons.size === 0 || [...reasons].some(reason => REUSE_BINDING_REASONS.has(reason)))
      ? ['reuse the existing bindings']
      : []),
  ]
  const help = [
    ...(reasons.has('binding-not-writable')
      ? ['use a fresh name because the existing binding is immutable']
      : []),
    ...(alternatives.length === 0 ? [] : [alternatives.join('; ')]),
    'place one-off declarations inside a block',
  ]
  const reservedNote = reservedBindingNote(collisions)
  return diagnostic({
    code: 'PTC-N001',
    severity: 'error',
    phase: 'preflight',
    message: `top-level bindings already exist: ${names.join(', ')}.${reservedNote} This cell was not executed; the REPL state is unchanged.`,
    stateEffect: 'unchanged',
    source: { cell: 'current', start: first.start, end: first.end },
    help,
    collisions: collisionRecords(collisions),
  })
}

function exceptionDiagnostic({
  error,
  cause,
  position,
  declared,
  longCellFailure = false,
  failureOrigin,
  languageSemantics = 'legacy-v1',
}) {
  const missingPath = error.name === 'ToolCallError' ? missingDescriptionPath(error) : undefined
  const missingDescription = missingPath !== undefined
  const message = missingDescription
    ? `nested native tool arguments are missing required \`description\` at JSON path $.${missingPath} (${error.toolName ?? 'unknown tool'}); this does not satisfy the outer run_code transport`
    : firstLine(error.message, 'Unknown exception')
  const rawName = typeof error.name === 'string' && error.name.length > 0
    ? error.name
    /* c8 ignore next */
    : typeof error.kind === 'string' && error.kind.length > 0 ? error.kind : 'Error'
  const name = firstLine(rawName, 'Error')
  const source = position === undefined || !Number.isSafeInteger(position.line) || position.line < 1
    || !Number.isSafeInteger(position.column) || position.column < 1
    ? undefined
    : { cell: 'current', start: { line: position.line, column: position.column } }
  return diagnostic({
    code: 'PTC-X001',
    severity: 'error',
    phase: 'execute',
    message: `uncaught ${name}: ${message}`,
    stateEffect: 'partially-applied',
    ...(cause === undefined ? {} : { cause }),
    ...(source === undefined ? {} : { source }),
    help: [
      'earlier statements or the failing operation may have caused effects; choose continuation using the operation owner\'s retry/idempotence contract and available execution facts; a thrown call or recorded-value replay does not prove a live retry is safe',
      ...(failureOrigin === 'lease'
        ? ['this REPL-captured capability reference belongs to an ended cell; obtain the member from the current program namespace, and have retained helpers resolve it at invocation']
        : failureOrigin === 'capability'
          ? ['inspect the current capability with capabilities.tree(), capabilities.find(), or capabilities.inspect(); availability may have changed']
          : missingDescription
            ? ['add a string `description` property to the nested native-tool argument object']
            : []),
      ...(error.name === 'ToolCallError'
        && typeof error.toolName === 'string'
        && error.toolName.startsWith('cordis_')
        ? ['bindings assigned before this Cordis failure remain live; reuse them instead of resending large source']
        : longCellFailure
          ? ['inspect relevant live state in a new short `run_code` cell; edit_run_code executes the complete corrected cell, not only the failing expression']
          : languageSemantics !== 'legacy-v1'
            ? ['completed declarations and actual assignments remain available; correct the failed initializer and continue with the same binding names']
          : declared.size === 0 ? []
            : ['use fresh names for one-off top-level bindings after partial execution; later declarations may be uninitialized']),
    ],
  })
}

function invalidOutputDiagnostic(detail) {
  return diagnostic({
    code: 'PTC-O001',
    severity: 'error',
    phase: 'execute',
    message: `cell result could not cross the PTC Value V1 boundary: ${firstLine(detail, 'unknown output encoding failure')}`,
    stateEffect: 'partially-applied',
    help: [
      'the worker remains live; inspect a retained binding in a later cell without rerunning the failed cell',
      'reduce the returned graph when it exceeds the configured value budget',
    ],
  })
}

/** Retain validated recorded wording while still comparing the actual failure. */
function replayFailureDiagnostic(actual, replay) {
  const recorded = replay?.diagnostics?.find(item => item.code === actual.code)
  return recorded?.message === actual.message ? recorded : actual
}

function stateArguments(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('repl.state expects an object')
  }
  const action = value.action
  if (!['list', 'save', 'restore', 'delete'].includes(action)) {
    throw new TypeError('repl.state action must be list, save, restore, or delete')
  }
  if (action === 'save' || action === 'delete' || (action === 'restore' && value.name !== undefined)) {
    assertStateName(value.name)
  }
  return { action, ...(value.name === undefined ? {} : { name: value.name }) }
}

/** Owns one cell's evaluator lifecycle and the worker-to-host binding bridge. */
export class SessionCellExecutor {
  constructor(kernel) {
    this.kernel = kernel
  }

  async executeCell(request, replayRecord = undefined, config = this.kernel.config) {
    const kernel = this.kernel
    if (kernel.disposed) {
      const result = earlyResult('abort', 'session kernel disposed')
      kernel.completeJournal(request.journal, 'noop', result)
      return result
    }
    if (request.signal?.aborted) {
      const result = earlyResult('abort', String(request.signal.reason))
      kernel.completeJournal(request.journal, 'noop', result)
      return result
    }

    let userBindings
    const userBindingsShadowPolicy = replayRecord?.userBindingsShadowPolicy ?? LIVE_USER_BINDINGS_SHADOW_POLICY
    const perNameUserBindings = userBindingsShadowPolicy === LIVE_USER_BINDINGS_SHADOW_POLICY
    let userBindingBaseCatalog = kernel.bindingCatalog
    let userBindingPlan
    let userBindingFailures = []
    try {
      userBindings = request.userBindings === undefined
        ? undefined
        : normalizeUserBindingsSnapshot(request.userBindings)
      if (userBindings === undefined) {
        const catalog = kernel.bindingCatalog.withoutUserBindings()
        userBindingPlan = perNameUserBindings ? kernel.bindingCatalog.userBindings(undefined, undefined, userBindingsShadowPolicy) : {
          catalog,
          shadowedNames: catalog.inputs().knownBindings,
        }
      } else {
        const activeEntryIds = new Set()
        for (const entry of userBindings.entries) {
          const names = entry.scope === 'namespace' ? [entry.name] : entry.symbols
          const conflict = names.find(name => request.bindingDescriptors.reservedNames.has(name))
          if (conflict === undefined) activeEntryIds.add(entry.id)
          else {
            userBindingFailures.push(Object.freeze({
              id: entry.id,
              error: `conflicts with request-owned program binding ${JSON.stringify(conflict)}`,
            }))
          }
        }
        userBindingPlan = kernel.bindingCatalog.userBindings(userBindings, activeEntryIds, userBindingsShadowPolicy)
      }
    } catch (error) {
      const result = earlyResult('exception', `invalid user binding snapshot: ${messageOf(error)}`)
      kernel.completeJournal(request.journal, 'noop', result)
      return result
    }
    const priorBindingCatalog = userBindingPlan.catalog
    const catalog = priorBindingCatalog.inputs()
    const { bindingPolicy, rewritesEnabled, moduleSemantics, languageSemantics, moduleTransform } = executionPolicies(config, replayRecord)
    const prepareCell = program => prepareProgram(program, {
      knownBindings: catalog.knownBindings,
      bindingPolicy,
      languageSemantics,
      reservedBindings: request.bindingDescriptors.reservedNames,
      rewritesEnabled,
      importBindings: catalog.importBindings,
      importNamespaces: catalog.importNamespaces,
      writableBindings: catalog.writableBindings,
      nativeBindings: catalog.nativeBindings,
      nativeLexicalBindings: catalog.nativeLexicalBindings,
      rootCandidates: catalog.rootCandidates,
      dynamicOrigins: catalog.dynamicOrigins,
      establishedRoots: catalog.establishedRoots,
      moduleSemantics,
    })
    let prepared
    try {
      prepared = prepareCell(request.program)
    } catch (error) {
      const result = earlyResult('exception', messageOf(error))
      const position = parseCellPosition(error)
      const repair = error instanceof PreflightError || replayRecord !== undefined
        ? undefined
        : validatedEofClosureRepair({
            source: request.program,
            position,
            prepare: prepareCell,
            targetCallSeq: request.sourceCallSeq,
          })
      const failure = error instanceof PreflightError
        ? preflightDiagnostic(error)
        : parseDiagnostic(error, request.program, position, repair)
      result.error.message = renderDiagnostic(failure, request.program)
      kernel.completeJournal(request.journal, 'noop', result, undefined, [failure])
      return result
    }
    if (prepared.collisions.length > 0) {
      const result = {
        logs: [],
        error: markBindingFailure({ kind: 'exception', message: 'top-level binding collision' }),
      }
      const failure = collisionDiagnostic(prepared.collisions)
      result.error.message = renderDiagnostic(failure, request.program)
      kernel.completeJournal(request.journal, 'noop', result, undefined, [failure])
      return result
    }

    let worker
    try {
      worker = await kernel.client.ensure(config.maxOldGenerationSizeMb)
    } catch (error) {
      const result = earlyResult('worker-exit', messageOf(error))
      kernel.completeJournal(request.journal, 'discarded', result)
      kernel.rollbackToDurable()
      return result
    }
    if (request.signal?.aborted) {
      const result = earlyResult('abort', String(request.signal.reason))
      kernel.completeJournal(request.journal, 'discarded', result)
      kernel.rollbackToDurable()
      // A refused reclamation stays recorded on the kernel so disposal remains
      // observable instead of becoming an unhandled rejection after this abort.
      kernel.resetWorker(worker)
      return result
    }

    const journal = request.journal
    const durability = desiredDurability(kernel, replayRecord, prepared, config)
    const valueLimits = kernel.valueLimits(config)
    const bindings = this.withControlBinding(request.bindingDescriptors, journal, replayRecord)
    const id = ++kernel.sequence
    return new Promise((resolve) => {
      const active = {
        id,
        started: false,
        request: { ...request, bindings: bindings.namespaces },
        finish: resolve,
        computeTimer: undefined,
        wallTimer: undefined,
        onAbort: undefined,
        journal,
        replay: replayRecord,
        replayIndex: 0,
        replayNextSettle: 0,
        replayPending: new Map(),
        pendingBindings: new Map(),
        settlementSequence: 0,
        diagnostics: [],
        appliedBindingCatalog: undefined,
        completion: undefined,
        config,
        valueLimits,
        durability: durabilityState({
          status: durability,
          reason: kernel.durability.status === 'volatile'
            ? kernel.durability.reason
            : !config.durableReplay
              ? 'durable replay disabled by configuration'
              : prepared.reason || undefined,
        }),
        control: { names: new Set(kernel.history.checkpoints.keys()) },
        rewrites: prepared.rewrites,
        prepared,
        priorBindingCatalog,
        userBindingBaseCatalog,
        userBindings,
        userBindingsShadowPolicy,
        userBindingFailures,
        userBindingSnapshot: userBindings,
        worker,
        settled: false,
      }
      active.resolve = (result, terminate = false) => kernel.settleCell(active, result, terminate)
      active.onAbort = () => active.resolve(
        earlyResult('abort', String(request.signal?.reason)),
        true,
      )
      active.budgetsStarted = false
      active.startBudgets = () => {
        if (active.budgetsStarted) return active.budgetsReady
        active.budgetsStarted = true
        // The wall bound starts at the request, while the compute baseline is
        // sampled from the worker instead of reusing the helper's last periodic
        // cache. Work that completed before this request must not be charged to
        // the new cell, and work after the sample must remain counted.
        active.wallTimer = setTimeout(() => {
          active.resolve(earlyResult('timeout', `wall-clock ceiling reached (${config.maxWallMs}ms); split long-running work into smaller cells`), true)
        }, config.maxWallMs)
        active.budgetsReady = (async () => {
          let started
          try {
            started = await worker.sampleUtilization()
          } catch (error) {
            // No fresh baseline means this request cannot be measured. Use the
            // existing worker-exit route instead of pretending the last cache
            // sample is this request's starting point.
            active.resolve(earlyResult('worker-exit', messageOf(error)), true)
            return
          }
          if (active.settled) return
          active.computeTimer = setInterval(() => {
            if (active.settled) return
            if (worker.performance.eventLoopUtilization(started).active > config.computeMs) {
              active.resolve(earlyResult('timeout', `compute budget exhausted (${config.computeMs}ms event-loop active, including synchronous blocking); this measure does not establish CPU use or the specific cause. Use asynchronous waiting for long waits, or a DSH-owned managed job if available. This cell was discarded and the worker reset; external effects or processes may continue.`), true)
            }
          }, Math.min(100, config.computeMs))
        })()
        return active.budgetsReady
      }
      active.start = async () => {
        if (active.started) return
        active.started = true
        kernel.workerObservation = undefined
        await active.startBudgets()
        if (active.settled) return
        try {
          kernel.client.post({
            type: 'run', id, program: prepared.code, namespaces: bindings.workerDescriptors,
            moduleLoads: prepared.moduleLoads,
            languageSemantics,
            moduleTransform,
            rootRuntimeName: prepared.rootRuntimeName,
            rootBindings: prepared.rootBindings,
            importBindingNamespaces: new Map([...catalog.importBindings].map(([name, binding]) => [name, binding.namespace])),
            preparedImportBindingNamespaces: new Map([...prepared.imports].map(([name, binding]) => [name, binding.namespace])),
            returnSignal: prepared.returnSignal,
            asyncCompletion: prepared.asyncCompletion,
            commitSignal: prepared.commitSignal,
            maxOutputBytes: config.maxOutputBytes,
            valueLimits,
            durability,
            observeNames: replayRecord === undefined && kernel.observeValues()
              ? createReplMemorySnapshot(
                  priorBindingCatalog.advance(prepared, request.program).snapshot(),
                ).entries.map(entry => entry.name)
              : [],
            userBindings,
            userBindingsShadowPolicy,
            userBindingsReusePolicy: replayRecord === undefined
              ? LIVE_USER_BINDINGS_REUSE_POLICY
              : replayRecord.userBindingsReusePolicy,
            ...(userBindings === undefined ? {} : { userBindingsCwd: kernel.userBindingsCwd }),
            userBindingFailures,
            shadowedUserBindingNames: [...new Set([
              ...userBindingPlan.shadowedNames,
              ...request.bindingDescriptors.reservedNames,
            ])],
          })
        } catch (error) {
          active.resolve(earlyResult('worker-exit', messageOf(error)), true)
        }
      }
      kernel.active = active
      request.signal?.addEventListener('abort', active.onAbort, { once: true })
      if (request.signal?.aborted) {
        active.onAbort()
        return
      }
      void (async () => {
        try {
          // Only worker-confirmed observation may defer these budgets; never restart them.
          if (kernel.workerObservation?.worker !== worker
            || kernel.workerObservation.started !== true) await active.startBudgets()
          if (active.settled) return
          kernel.client.post({ type: 'prepare', id })
        } catch (error) {
          active.resolve(earlyResult('worker-exit', messageOf(error)), true)
        }
      })()
    })
  }

  withControlBinding(bindingDescriptors, journal, replayRecord) {
    if (replayRecord === undefined && journal === undefined) return bindingDescriptors
    const control = async args => {
      const parsed = stateArguments(args)
      if (replayRecord !== undefined) return { action: parsed.action, ...(parsed.name === undefined ? {} : { name: parsed.name }) }
      return this.controlState(parsed)
    }
    const namespace = Object.freeze({
      global: 'repl',
      functions: Object.freeze({ state: control }),
      members: Object.freeze(['state']),
    })
    return Object.freeze({
      namespaces: Object.freeze([...bindingDescriptors.namespaces, namespace]),
      reservedNames: bindingDescriptors.reservedNames,
      workerDescriptors: Object.freeze([
        ...bindingDescriptors.workerDescriptors,
        ...normalizeBindingDescriptors([namespace]).workerDescriptors,
      ]),
    })
  }

  controlState(parsed) {
    const kernel = this.kernel
    const active = kernel.active
    if (active?.control === undefined || active.journal === undefined) {
      throw new Error('REPL state control is unavailable outside a cell')
    }
    const { action, name } = parsed
    if (action === 'list') {
      return {
        names: [...active.control.names].sort(),
        mode: active.durability.status,
        ...(active.durability.reason === undefined ? {} : { volatileReason: active.durability.reason }),
      }
    }
    if (action === 'save') {
      if (active.durability.status === 'volatile') {
        throw new Error('cannot save a durable REPL state from a volatile segment; restore a durable state first')
      }
      active.control.names.add(name)
      active.journal.operations.push({ action, name })
      return { action, name, saved: true }
    }
    if (action === 'delete') {
      active.control.names.delete(name)
      active.journal.operations.push({ action, name })
      return { action, name, deleted: true }
    }
    if (name !== undefined && !active.control.names.has(name)) throw new Error(`REPL state "${name}" does not exist`)
    active.journal.operations.push({ action, ...(name === undefined ? {} : { name }) })
    return { action, ...(name === undefined ? {} : { name }), restored: true }
  }

  onMessage(message) {
    if (message?.type === 'observation-started') {
      const kernel = this.kernel
      const observation = kernel.workerObservation
      if (observation !== undefined && observation.id === message.id
        && observation.worker === kernel.client.worker) observation.started = true
      return
    }
    if (message?.type === 'ready') {
      const inspection = this.kernel.pendingInspection
      if (inspection !== undefined && inspection.id === message.id) inspection.start()
      const active = this.kernel.active
      if (active !== undefined && active.id === message.id) void active.start()
      return
    }
    if (message?.type === 'observation') {
      const kernel = this.kernel
      const observation = kernel.workerObservation
      if (observation !== undefined && observation.id === message.id) {
        kernel.workerObservation = undefined
        if (kernel.active?.worker === observation.worker) kernel.active.startBudgets()
      }
      kernel.finishObservation(message)
      return
    }
    if (message === null || typeof message !== 'object') return
    const handler = {
      volatile: this.handleVolatile,
      call: this.handleCall,
      'output-limit': this.handleOutputLimit,
      done: this.handleDone,
    }[message.type]
    handler?.call(this, message)
  }

  handleVolatile(message) {
    const active = this.kernel.active
    if (active?.id !== message.id) return
    active.durability = transitionDurability(active.durability, {
        type: 'volatile',
        reason: typeof message.reason === 'string' ? message.reason : undefined,
    })
  }

  handleCall(message) {
    void this.invokeBinding(message)
  }

  handleOutputLimit(message) {
    const kernel = this.kernel
    const active = kernel.active
    if (active?.id !== message.id) return
    /* c8 ignore next */
    const logs = Array.isArray(message.logs) && message.logs.every(log => typeof log === 'string') ? message.logs : []
    active.resolve({
        logs: limitLogs(logs),
        error: { kind: 'output-limit', message: OUTPUT_LIMIT_MESSAGE(active.config.maxOutputBytes) },
    }, true)
  }

  handleDone(message) {
    const kernel = this.kernel
    if (kernel.active?.id !== message.id) return
    const active = kernel.active
    const logs = Array.isArray(message.logs) && message.logs.every(log => typeof log === 'string') ? message.logs : []
    if (!['durable', 'volatile'].includes(message.durability)) {
      active.resolve({ logs, error: { kind: 'worker-exit', message: 'kernel returned an invalid durability state' } }, true)
      return
    }
    if (message.durability === 'volatile') {
      active.durability = transitionDurability(active.durability, {
        type: 'volatile',
        reason: typeof message.volatileReason === 'string' ? message.volatileReason : undefined,
      })
    }
    if (active.replay !== undefined && active.durability.status !== 'durable') {
      active.resolve({ logs, error: { kind: 'recovery', message: 'durable history requested a volatile capability during replay' } }, true)
      return
    }
    if (active.replay !== undefined
      && (active.replayIndex !== active.replay.calls.length || active.replayPending.size !== 0)) {
      active.resolve({ logs, error: { kind: 'recovery', message: 'session log replay consumed a different host-call transcript' } }, true)
      return
    }
    let activatedUserBindings
    const perNameUserBindings = active.userBindingsShadowPolicy === LIVE_USER_BINDINGS_SHADOW_POLICY
    try {
      if (active.userBindings === undefined) {
        active.userBindingSnapshot = undefined
        active.priorBindingCatalog = active.userBindingBaseCatalog.withoutUserBindings()
      } else {
        const ids = Array.isArray(message.activatedUserBindings)
          && message.activatedUserBindings.every(id => typeof id === 'string')
          ? new Set(message.activatedUserBindings)
          : undefined
        if (ids === undefined || ids.size !== message.activatedUserBindings.length) {
          throw new TypeError('kernel returned an invalid activated user binding set')
        }
        const expected = new Set(active.userBindings.entries.map(entry => entry.id))
        if ([...ids].some(id => !expected.has(id))) {
          throw new TypeError('kernel activated an unknown user binding entry')
        }
        if (perNameUserBindings) validateUserBindingActivation(active, message, ids)
        activatedUserBindings = selectUserBindingsSnapshot(active.userBindings, ids)
        active.userBindingSnapshot = activatedUserBindings
        active.priorBindingCatalog = active.userBindingBaseCatalog.userBindings(active.userBindings, ids, active.userBindingsShadowPolicy).catalog
        if (!perNameUserBindings) {
          const shadowed = Array.isArray(message.shadowedUserBindings)
            && message.shadowedUserBindings.every(name => typeof name === 'string')
            ? new Set(message.shadowedUserBindings)
            : undefined
          const activeNames = new Set(activatedUserBindings.entries.flatMap(entry => (
            entry.scope === 'namespace' ? [entry.name] : entry.symbols
          )))
          if (shadowed === undefined || shadowed.size !== message.shadowedUserBindings.length
            || [...shadowed].some(name => !activeNames.has(name))) {
            throw new TypeError('kernel returned an invalid shadowed user binding set')
          }
          active.priorBindingCatalog = active.priorBindingCatalog.shadowUserBindings(shadowed)
        }
        if (active.replay !== undefined
          && activatedUserBindings.fingerprint !== active.userBindings.fingerprint) {
          active.resolve({ logs, error: { kind: 'recovery', message: 'recorded user bindings could not be reactivated' } }, true)
          return
        }
      }
      if (perNameUserBindings) active.userBindingNames = completedUserBindingNames(active, message, activatedUserBindings)
    } catch (error) {
      active.resolve(earlyResult('worker-exit', messageOf(error)), true)
      return
    }
    const bytes = Buffer.byteLength(JSON.stringify({ logs, value: message.value }), 'utf8')
    if (bytes > active.config.maxOutputBytes) {
      active.resolve({
        logs: limitLogs(logs),
        error: { kind: 'output-limit', message: OUTPUT_LIMIT_MESSAGE(active.config.maxOutputBytes) },
      }, true)
      return
    }
    let committed
    let rootBindingFacts
    try {
      committed = committedRedeclarationSet(message, active.prepared)
      rootBindingFacts = completedRootBindingFacts(message, active.prepared, committed)
    } catch (error) {
      active.resolve(earlyResult('worker-exit', messageOf(error)), true)
      return
    }
    active.appliedBindingCatalog = message.moduleLoadFailed === true
      ? active.priorBindingCatalog
      : active.priorBindingCatalog.advance(
          active.prepared,
          active.request.program,
          committed,
          rootBindingFacts,
        )
    if (perNameUserBindings) {
      active.appliedBindingCatalog = active.appliedBindingCatalog.reconcileUserBindingNames(
        activatedUserBindings, active.userBindingNames, active.request.program,
      )
    }
    active.observing = message.observing === true
    if (typeof message.error === 'string') {
      const rawError = {
        kind: 'exception',
        name: typeof message.errorName === 'string' ? message.errorName : 'Error',
        message: message.error,
        ...(typeof message.toolName === 'string' ? { toolName: message.toolName } : {}),
      }
      const actualFailure = exceptionDiagnostic({
        error: rawError,
        cause: message.cause,
        // A diagnostic caret must exist in the submitted cell. A native frame
        // is mapped first; an unmappable frame falls back to the recorded
        // source origin rather than attaching an out-of-range position.
        position: message.moduleLoadFailed === true
          ? cellPosition(message.position, active.request.program)
          : cellPosition(
              mapSourcePosition(
                message.position,
                active.prepared.code,
                active.request.program,
                active.prepared.sourceMap,
              ),
              active.request.program,
            ) ?? exceptionOriginPosition(message.exceptionOrigins, active.request.program),
        declared: message.moduleLoadFailed === true ? new Set() : active.prepared.declared,
        languageSemantics: active.prepared.languageSemantics,
        longCellFailure: active.request.program.length >= LONG_CELL_CODE_UNITS,
        failureOrigin: message.failureOrigin,
      })
      const failure = replayFailureDiagnostic(actualFailure, active.replay)
      const error = {
        kind: 'exception',
        message: renderDiagnostic(failure, active.request.program),
      }
      if (isBindingReferenceError(rawError)) markBindingFailure(error)
      else if (message.failureOrigin === 'capability') markBindingFailure(error, 'capability')
      active.diagnostics.push(failure)
      active.resolve({ logs, error })
      return
    }
    if (typeof message.invalidOutput === 'string') {
      const failure = replayFailureDiagnostic(invalidOutputDiagnostic(message.invalidOutput), active.replay)
      const error = { kind: 'invalid-output', message: renderDiagnostic(failure, active.request.program) }
      active.diagnostics.push(failure)
      active.resolve({ logs, error })
      return
    }
    try {
      if (typeof message.hasValue !== 'boolean'
        || (message.hasValue ? message.value === undefined : message.value !== undefined)) {
        throw new TypeError('invalid PTC completion envelope')
      }
      const completion = message.hasValue ? prepareValueWire(message.value, active.valueLimits) : undefined
      active.completion = {
        hasValue: message.hasValue,
        ...(message.hasValue ? { value: completion.wire } : {}),
      }
      if (active.replay?.completion?.kind === 'return'
        && (active.replay.completion.hasValue !== message.hasValue
          || (message.hasValue && !valueWiresEqual(active.replay.completion.value, completion.wire, active.valueLimits)))) {
        active.resolve({ logs, error: { kind: 'recovery', message: 'cell replay produced a different completion value' } }, true)
        return
      }
      active.resolve({
        logs,
        ...(message.hasValue ? { value: completion.projectedValue } : {}),
      })
    } catch (error) {
      const failure = replayFailureDiagnostic(invalidOutputDiagnostic(messageOf(error)), active.replay)
      const invalid = { kind: 'invalid-output', message: renderDiagnostic(failure, active.request.program) }
      active.diagnostics.push(failure)
      active.resolve({ logs, error: invalid })
    }
  }

  async invokeBinding(message) {
    const kernel = this.kernel
    const active = kernel.active
    if (active?.worker !== kernel.client.worker || active?.id !== message.runId) {
      kernel.client.postIfAlive({ type: 'reply', runId: message.runId, id: message.id, ok: false, error: 'PTC execution lease expired' })
      return
    }
    const namespace = active.request.bindings.find(binding => binding.global === message.global)
    const binding = namespace?.functions?.[message.member]
    if (typeof binding !== 'function') {
      kernel.client.post({ type: 'reply', runId: message.runId, id: message.id, ok: false, error: `unknown binding ${message.global}.${message.member}` })
      return
    }
    let argsWire
    let args
    try {
      argsWire = normalizeValueWire(message.args, active.valueLimits)
      args = decodeValue(argsWire, active.valueLimits)
    } catch (error) {
      kernel.client.post({ type: 'reply', runId: message.runId, id: message.id, ok: false, error: messageOf(error) })
      return
    }
    const recorded = active.replay?.calls?.[active.replayIndex]
    if (active.replay !== undefined) {
      active.replayIndex += 1
      if (recorded === undefined || recorded.global !== message.global || recorded.member !== message.member
        || !valueWiresEqual(recorded.args, argsWire, active.valueLimits)) {
        kernel.client.post({ type: 'reply', runId: message.runId, id: message.id, ok: false, error: 'session log replay diverged at a host binding call' })
        return
      }
      const pending = { message, recorded }
      active.replayPending.set(recorded.settle, pending)
      this.flushReplayReplies(active)
      return
    }
    /* c8 ignore next */
    const call = active.journal === undefined
      ? undefined
      : { global: message.global, member: message.member, args: argsWire }
    if (call !== undefined) active.journal.calls.push(call)
    active.pendingBindings.set(message.id, `${message.global}.${message.member}`)
    try {
      // Restore the initiator boundary lost across the worker callback.
      const agent = active.request.executionToken?.agent
      const invoke = () => binding(args)
      const value = kernel.withInitiator === undefined || agent === undefined
        ? await invoke()
        : await kernel.withInitiator(agent, invoke)
      const valueWire = encodeValue(value, active.valueLimits)
      if (call !== undefined) {
        call.ok = true
        call.value = valueWire
        call.settle = active.settlementSequence++
      }
      if (active.worker === kernel.client.worker) {
        kernel.client.post({ type: 'reply', runId: message.runId, id: message.id, ok: true, value: valueWire })
      }
    } catch (error) {
      const cause = hostCause(error)
      if (call !== undefined) {
        call.ok = false
        call.error = messageOf(error)
        call.settle = active.settlementSequence++
      }
      if (active.worker === kernel.client.worker) {
        kernel.client.post({
          type: 'reply', runId: message.runId, id: message.id, ok: false,
          error: messageOf(error), cause,
        })
      }
    } finally {
      active.pendingBindings.delete(message.id)
    }
  }

  flushReplayReplies(active) {
    const kernel = this.kernel
    while (active.worker === kernel.client.worker) {
      const pending = active.replayPending.get(active.replayNextSettle)
      if (pending === undefined) return
      if (pending.waiting === true && pending.response === undefined) return
      active.replayPending.delete(active.replayNextSettle)
      active.replayNextSettle += 1
      const { message, recorded } = pending
      const response = pending.response
      const selected = response ?? recorded
      kernel.client.post(selected.ok
        ? { type: 'reply', runId: message.runId, id: message.id, ok: true, value: selected.value }
        : { type: 'reply', runId: message.runId, id: message.id, ok: false, error: selected.error })
    }
  }
}
