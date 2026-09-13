/** Historical legacy-v1 catalog transition, retained from c51616c8d6c8:session-state.js. */
export function advanceLegacyBindings(previousEntries, prepared, extractDefinition, committedRedeclarations) {
  const entries = new Map(previousEntries)
  const touched = new Set()
  const redeclared = new Set((prepared.redeclared ?? []).map(declaration => declaration.name))
  const commitGated = prepared.commitTargets
  const committed = committedRedeclarations instanceof Set
    ? committedRedeclarations
    : new Set([...redeclared, ...commitGated])
  const uncommitted = new Set()
  for (const declaration of prepared.declarations ?? []) {
    if (typeof declaration?.name !== 'string') continue
    const dependency = typeof declaration.commitDependency === 'string'
      && commitGated.has(declaration.commitDependency)
      ? declaration.commitDependency
      : commitGated.has(declaration.name) ? declaration.name : undefined
    if (dependency !== undefined && !committed.has(dependency)) {
      uncommitted.add(declaration.name)
      continue
    }
    touched.add(declaration.name)
    const previous = entries.get(declaration.name)
    const definition = extractDefinition(declaration.definitionSpan)
    entries.set(declaration.name, {
      kind: declaration.kind ?? 'variable',
      definition: definition ?? previous?.definition,
      writable: redeclared.has(declaration.name) ? previous?.writable === true : declaration.writable === true,
    })
  }
  for (const name of prepared.declared) {
    if (!uncommitted.has(name)) touched.add(name)
  }
  for (const name of touched) {
    const entry = entries.get(name) ?? { kind: 'variable', writable: false }
    entries.delete(name)
    entries.set(name, entry)
  }
  const imports = new Map(prepared.imports)
  for (const [name, binding] of imports) {
    if (typeof binding?.commitDependency !== 'string'
      || !commitGated.has(binding.commitDependency)
      || committed.has(binding.commitDependency)) continue
    if (previousEntries.get(name)?.import !== undefined) imports.set(name, previousEntries.get(name).import)
    else imports.delete(name)
  }
  for (const [name, entry] of entries) entries.set(name, { ...entry, import: imports.get(name) })
  return { entries, namespaces: prepared.importNamespaces }
}
