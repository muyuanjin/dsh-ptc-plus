import { isBuiltin } from 'node:module'
import { parse } from 'acorn'

/** Compiler-owner named imports are mandatory even on lazy/fallback paths. */
export function compilerPlatformRequirements(source, externalModules) {
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  return tree.body.filter(node => node.type === 'ImportDeclaration' && isBuiltin(node.source.value)
    && (externalModules === undefined || externalModules.has(node.source.value)))
    .map(node => ({ module: node.source.value,
      names: node.specifiers.filter(specifier => specifier.type === 'ImportSpecifier')
        .map(specifier => specifier.imported.name ?? specifier.imported.value) }))
}

/** Availability is checked independently of whether a user sample needs it. */
export function validateCompilerPlatform(requireModule, requirements) {
  for (const requirement of requirements) {
    const exports = requireModule(requirement.module)
    for (const name of requirement.names) {
      if (exports[name] === undefined) throw new Error(`compiler platform is missing ${requirement.module}.${name}`)
    }
  }
}
