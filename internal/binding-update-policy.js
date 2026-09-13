import { LIVE_MODULE_SEMANTICS } from './repl-rewrite-contract.js'
import { LEGACY_LANGUAGE_SEMANTICS, STATEFUL_LANGUAGE_SEMANTICS,
  PROTECTED_LANGUAGE_SEMANTICS, normalizeLanguageSemantics } from './language-semantics.js'

/**
 * Translate the public compatibility settings into the execution policy used
 * by the compiler and journal.  Keeping this mapping in one owner prevents
 * individual lowering paths from combining legacy switches differently.
 */
export function executionPolicies(config, replayRecord = undefined) {
  if (config.bindingUpdates !== undefined && !['stateful', 'protected'].includes(config.bindingUpdates)) {
    throw new TypeError('ptc-plus: bindingUpdates must be stateful or protected')
  }
  if (replayRecord !== undefined) {
    const bindingPolicy = Object.freeze({ ...replayRecord.bindingPolicy })
    const rewritesEnabled = Object.freeze({ ...replayRecord.rewritePolicy })
    const moduleSemantics = Object.freeze({ ...replayRecord.moduleSemantics })
    return Object.freeze({
      languageSemantics: normalizeLanguageSemantics(replayRecord.languageSemantics ?? LEGACY_LANGUAGE_SEMANTICS),
      bindingPolicy,
      rewritesEnabled,
      moduleSemantics,
    })
  }
  if (config.bindingUpdates === 'stateful' && config.legacyBindingSettings !== true) {
    return Object.freeze({
      languageSemantics: STATEFUL_LANGUAGE_SEMANTICS,
      bindingPolicy: Object.freeze({ variableRedeclarations: true, functionClassRedeclarations: true }),
      rewritesEnabled: Object.freeze({ autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true }),
      moduleSemantics: LIVE_MODULE_SEMANTICS,
    })
  }
  if (config.bindingUpdates === 'protected' && config.legacyBindingSettings !== true) {
    return Object.freeze({
      languageSemantics: PROTECTED_LANGUAGE_SEMANTICS,
      bindingPolicy: Object.freeze({ variableRedeclarations: false, functionClassRedeclarations: false }),
      // Module syntax is part of the language in protected mode too.  The
      // policy protects existing names; it does not remove valid syntax.
      rewritesEnabled: Object.freeze({ autoRewriteImports: true, autoStripExports: true, autoSplitRedeclarations: true }),
      moduleSemantics: LIVE_MODULE_SEMANTICS,
    })
  }
  return Object.freeze({
    languageSemantics: LEGACY_LANGUAGE_SEMANTICS,
    bindingPolicy: Object.freeze({
      variableRedeclarations: config.looseTopLevelRedeclarations === true,
      functionClassRedeclarations: config.looseTopLevelFunctionClassRedeclarations === true,
    }),
    rewritesEnabled: Object.freeze({
      autoRewriteImports: config.autoRewriteImports === true,
      autoStripExports: config.autoStripExports === true,
      autoSplitRedeclarations: config.autoSplitRedeclarations === true,
    }),
    moduleSemantics: LIVE_MODULE_SEMANTICS,
  })
}

/** Stable prose inputs for the model-visible REPL guidance. */
export function guidancePolicies(config) {
  const policies = executionPolicies(config)
  return Object.freeze({
    ...policies,
    durableReplay: config.durableReplay === true,
    cordisToolsEnabled: config.cordisToolsEnabled === true,
  })
}
