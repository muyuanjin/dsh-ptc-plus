import { prepareProgram, prepareConsoleProgram, classifyDurability } from './cell-analysis.js'
import { PreflightError } from './cell-analysis-contract.js'
import { ModuleRewriteError } from './cell-rewriter.js'
import { compileDynamicEnvironmentSource } from './dynamic-environment-compiler.js'
import { compileStatefulModule, detectModuleSourceFormat, attachModuleNamespace,
  linkCommonJsEvidenceSource } from './module-compilation.js'
import { copyCompilerData } from './compiler-data.js'
import { identifier, exportedSymbols, sourceDurability } from './binding-source-analysis.js'
import { hashText, deflateText, inflateText } from './compiler-text.js'
import { createCallableSourceCatalog } from './callable-source-encoding.js'
import { createCachedDynamicCompiler } from './compiler-dynamic-cache.js'

const operations = { prepareProgram, prepareConsoleProgram, classifyDurability,
  compileDynamicEnvironmentSource: createCachedDynamicCompiler(compileDynamicEnvironmentSource),
  compileStatefulModule, detectModuleSourceFormat, attachModuleNamespace, linkCommonJsEvidenceSource,
  identifier, exportedSymbols, sourceDurability, hashText, deflateText, inflateText, createCallableSourceCatalog }

/** Synchronous source preparation has no module loader or runtime state. */
export function compile(operation, input, originalSource) {
  try {
    const args = copyCompilerData(input)
    if (originalSource !== undefined) args[1].resolveOriginalSource = source => originalSource(source)
    return { value: operations[operation](...args) }
  } catch (error) {
    const properties = {}
    // Parser errors may own methods for cloning diagnostics. Only diagnostic
    // data crosses the boundary; native error prototypes belong to the caller.
    for (const [name, field] of Object.entries(Object.getOwnPropertyDescriptors(error))) {
      if ('value' in field && typeof field.value !== 'function') properties[name] = field
    }
    return { error: { kind: error instanceof ModuleRewriteError ? 'ModuleRewriteError'
      : error instanceof PreflightError ? 'PreflightError' : error.name,
    message: error.message, properties } }
  }
}
