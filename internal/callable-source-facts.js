import { parse } from '@babel/parser'
import { tokenizer } from 'acorn'
import { types as t } from '@babel/core'
import { createHash } from 'node:crypto'
import { SourceMap } from 'node:module'
import { applySourceEdits, identitySourceMap, mappedSourceTransform, sourceLineStarts, sourceOffsetAt, visitSourceMappings } from './source-position-map.js'
import { createCallableSourceCatalog } from './callable-source-encoding.js'
import { regionInput, visitRegionSource } from './compiler-region-output.js'
import { lowerCallableSource, undecoratedMethodSource, decoratedClassSource } from './callable-source-lowering.js'
import { supportsNativeUsing, transformTypeScriptSource } from './typescript-transform.js'

const isCallable = node => t.isFunction(node) || t.isClass(node)
const isMethod = node => t.isObjectMethod(node) || t.isClassMethod(node) || t.isClassPrivateMethod(node)
const requiresTypeErasure = node => node.type.startsWith('TS') || node.type === 'Decorator' || node.type === 'ClassAccessorProperty'
  || node.accessibility !== undefined && node.accessibility !== null || node.abstract || node.declare
  || node.override || node.readonly || node.definite || node.optional

class CallableSourceFacts {
  constructor(source) { this.buffers = [source]; this.entries = []; this.length = 0; this.aliases = [] }
  add(marker, start, end, override) {
    let buffer = 0
    if (override !== undefined) { buffer = this.buffers.length; this.buffers.push(override); start = 0; end = override.length }
    this.entries.push({ marker, buffer, start, end })
    this.length++
  }
  *[Symbol.iterator]() { for (const entry of this.entries) yield [entry.marker, this.buffers[entry.buffer].slice(entry.start, entry.end)] }
  map(callback) { return [...this].map(callback) }
}

const factMap = sources => sources instanceof CallableSourceFacts
  ? new Map(sources.entries.map(entry => [entry.marker, { entry, buffers: sources.buffers }]))
  : new Map(sources.map(([marker, original]) => [marker, { original }]))
const originalText = fact => fact.entry === undefined ? fact.original
  : fact.buffers[fact.entry.buffer].slice(fact.entry.start, fact.entry.end)

// Native method source starts after the static modifier and its trivia. Read
// tokens only at this parsed method boundary, without retaining file tokens.
function callableSourceStart(source, node) {
  if (!(node.staticMethod ?? (node.static && node.type.endsWith('Method')))) return node.start
  const start = node.decorators?.at(-1)?.end ?? node.start
  const tokens = tokenizer(source.slice(start, node.end), { ecmaVersion: 'latest' })
  while (tokens.getToken().value !== 'static') {}
  return start + tokens.getToken().start
}

export function callableMarkerPosition(node, source, comments) {
  if (node.type !== 'ArrowFunctionExpression') return node.body.start + 1
  let start = source.lastIndexOf('=>', node.body.start - 1)
  while (true) {
    let low = 0, high = comments.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (comments[middle].start <= start) low = middle + 1
      else high = middle
    }
    const comment = comments[low - 1]
    if (comment === undefined || comment.end <= start) return start
    start = source.lastIndexOf('=>', comment.start - 1)
  }
}

/** Carry source identity through transforms without wrapping callable values. */
export function markCallableSources(source, sourceMap = identitySourceMap(source.length), parserOptions = {}, {
  lowerNativeSource, resolveOriginalSource, nativeUsing = supportsNativeUsing(),
} = {}) {
  const options = { sourceType: 'unambiguous', allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true, errorRecovery: true, ...parserOptions }
  let tree, nativeJavaScript = false
  try {
    tree = parse(source, { ...options, errorRecovery: false, plugins: ['importAttributes'] })
    nativeJavaScript = true
  } catch {
    tree = parse(source, options)
  }
  const identity = createHash('sha256').update(source).digest('hex')
  const sources = new CallableSourceFacts(source)
  const typedCallables = new WeakSet()
  const resourceCallables = new WeakSet()
  const lowerResources = !nativeUsing && source.includes('using')
  const typed = node => {
    if (!node) return 0
    let needed = requiresTypeErasure(node) ? 1 : 0
    if (lowerResources && t.isVariableDeclaration(node) && (node.kind === 'using' || node.kind === 'await using')) needed |= 2
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = node[key]
      if (Array.isArray(child)) { for (const value of child) needed |= typed(value) }
      else needed |= typed(child)
    }
    if (needed && isCallable(node)) typedCallables.add(node)
    if ((needed & 2) && isCallable(node)) resourceCallables.add(node)
    return needed
  }
  if (!nativeJavaScript || lowerResources) typed(tree.program)
  const edits = [], typedRecords = []
  const contexts = new WeakMap()
  const context = (node, privateNames = []) => {
    if (!node) return
    if (isCallable(node)) contexts.set(node, privateNames)
    const names = t.isClass(node) ? [...new Set([...privateNames, ...node.body.body
      .filter(member => t.isPrivateName(member.key)).map(member => member.key.id.name)])] : privateNames
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = node[key]
      if (Array.isArray(child)) { for (const value of child) context(value, names) }
      else context(child, names)
    }
  }
  if (!nativeJavaScript || lowerResources) context(tree.program)
  t.traverseFast(tree, node => {
    if (t.isVariableDeclaration(node) && (node.kind === 'using' || node.kind === 'await using')) nativeJavaScript = false
    if (!isCallable(node)) return
    if (node.body === undefined || node.body === null) return
    // A constructor method's callable value is the class itself. It cannot
    // have a separate source identity from Class.prototype.constructor.
    if (t.isClassMethod(node, { kind: 'constructor' })) return
    const marker = `__dsh_ptc_callable_${identity}_${sources.length}__`
    const startOffset = callableSourceStart(source, node)
    sources.add(marker, startOffset, node.end, resolveOriginalSource?.(source.slice(startOffset, node.end)))
    const start = callableMarkerPosition(node, source, tree.comments)
    edits.push({ start, end: start, text: `/*${marker}*/` })
    if (typedCallables.has(node)) typedRecords.push({ marker, node, entry: sources.entries.at(-1), privateNames: contexts.get(node),
      resources: resourceCallables.has(node) })
  })
  const marked = applySourceEdits(source, sourceMap, edits)
  if (typedRecords.length === 0) return { ...marked, callableSources: sources, nativeJavaScript }
  // Every descendant has a source identity before its parent is lowered.
  const markedTree = parse(marked.code, options)
  const markedNodes = new Map([...markedCallableOwners(markedTree, sources)].map(([node, fact]) => [fact.marker, node]))
  const originals = new Map(sources)
  const nativeFunctions = typedRecords.map(record => markedNodes.get(record.marker))
    .filter(node => t.isFunction(node) && !isMethod(node)).sort((left, right) => left.start - right.start)
  const nativeRecipes = new Map()
  const nativeFunctionIndex = start => {
    let low = 0, high = nativeFunctions.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (nativeFunctions[middle].start < start) low = middle + 1
      else high = middle
    }
    return low
  }
  for (const record of typedRecords.sort((a, b) => a.node.end - a.node.start - (b.node.end - b.node.start))) {
    const { marker, entry, privateNames } = record
    const node = markedNodes.get(marker)
    const start = callableSourceStart(marked.code, node)
    let original = marked.code.slice(start, node.end)
    const method = isMethod(node)
    const classRecipe = t.isClass(node) && (node.decorators?.length || node.abstract)
    const methodRecipe = method && (node.decorators?.length || node.params.some(parameter => parameter.decorators?.length))
    const reused = []
    if (classRecipe) original = decoratedClassSource(node)
    else if (methodRecipe) original = undecoratedMethodSource(node)
    else {
      // A lowered function closes its generated helpers over its own source.
      // Reuse that complete function in enclosing reflection recipes; class
      // and method definition phases retain their separate grammar owners.
      // Descendants are complete before their parent. Select the outermost
      // reusable functions, jumping over the descendants each one already owns.
      for (let index = nativeFunctionIndex(start); index < nativeFunctions.length;) {
        const child = nativeFunctions[index]
        if (child.start >= node.end) break
        const replacement = nativeRecipes.get(child)
        if (replacement === undefined) { index++; continue }
        reused.push(replacement)
        index = nativeFunctionIndex(child.end)
      }
      if (reused.length > 0) original = applySourceEdits(original, identitySourceMap(original.length), reused
        .map(value => ({ start: value.start - start, end: value.end - start, text: value.text }))).code
    }
    const prefix = method ? 'class Source {' : '('
    const suffix = method ? '}' : ')'
    const lowerCallable = () => {
      const lowered = lowerCallableSource(original, { method,
        lowerNativeSource: (source, options) => lowerNativeSource(source, { ...options, nativeUsing }),
        privateNames, sourceType: tree.program.sourceType })
      original = lowered.source
      const entries = [...originals].map(([key, text]) => [key, key === marker ? original : text])
      for (const [node, fact] of markedCallableOwners(lowered.emitted, entries)) {
        sources.aliases.push([lowered.emittedSource.slice(node.start, node.end), fact.original])
      }
    }
    // Prefer source-preserving erasure. Runtime TypeScript constructs such as
    // parameter properties require equivalent JavaScript initialization too.
    let resources = record.resources
    let erase = true
    if (reused.length > 0) {
      resources = false
      erase = false
      const reusedNodes = new Set(reused.map(value => value.node))
      t.traverseFast(node, child => {
        if (reusedNodes.has(child)) return t.traverseFast.skip
        if (requiresTypeErasure(child)) erase = true
        if (record.resources && t.isVariableDeclaration(child) && (child.kind === 'using' || child.kind === 'await using')) resources = true
      })
    }
    // Replacing complete functions with proven native functions leaves native
    // surrounding syntax intact. Their generated bodies need no erasure pass.
    if (resources) lowerCallable()
    else if (erase) try {
      const erased = transformTypeScriptSource(`${prefix}${original}${suffix}`, { mode: 'strip-only' }).code
      parse(erased, { errorRecovery: true })
      original = erased.slice(prefix.length, erased.length - suffix.length)
    } catch {
      lowerCallable()
    }
    entry.buffer = sources.buffers.length
    sources.buffers.push(original)
    entry.start = 0
    entry.end = original.length
    originals.set(marker, original)
    if (!method && t.isFunction(node)) nativeRecipes.set(node, { node, start, end: node.end, text: original })
  }
  return { ...marked, callableSources: sources, nativeJavaScript }
}

export function markedCallableOwners(tree, sources) {
  const declarations = []
  t.traverseFast(tree, node => { if (isCallable(node)) declarations.push(node) })
  declarations.sort((left, right) => left.start - right.start || right.end - left.end)
  const facts = factMap(sources)
  const originals = new Map()
  const stack = []
  let next = 0
  for (const comment of tree.comments) {
    const fact = facts.get(comment.value)
    if (fact === undefined) continue
    while (next < declarations.length && declarations[next].start <= comment.start) {
      const node = declarations[next++]
      while (stack.length > 0 && stack.at(-1).end < node.end) stack.pop()
      stack.push(node)
    }
    while (stack.length > 0 && stack.at(-1).end < comment.end) stack.pop()
    if (stack.length > 0) originals.set(stack.at(-1), { marker: comment.value, ...fact })
  }
  return originals
}

function sourceOwnerPositions(code, sources, parserOptions) {
  return new Map([...markedCallableOwners(parse(code, parserOptions), sources)]
    .map(([node, fact]) => [`${node.type}:${node.start}`, fact]))
}

function callableSourceOwners(code, sources, parserOptions, transformation) {
  const options = { sourceType: 'unambiguous', allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true, ...parserOptions }
  if (transformation === undefined) {
    const tree = parse(code, options)
    return { tree, owners: markedCallableOwners(tree, sources) }
  }
  // Retain numeric owner facts, not a second complete AST while reading output.
  const owners = sourceOwnerPositions(transformation.code, sources, options)
  const sourceMap = new SourceMap(JSON.parse(transformation.map))
  const starts = sourceLineStarts(transformation.code)
  const emitted = parse(code, options)
  const matched = new Map()
  t.traverseFast(emitted, node => {
    if (!isCallable(node)) return
    const position = sourceMap.findEntry(node.loc.start.line - 1, node.loc.start.column)
    // A preceding segment does not prove a generated callable's source owner.
    if (position.generatedLine !== node.loc.start.line - 1 || position.generatedColumn !== node.loc.start.column
      || starts[position.originalLine] === undefined) return
    const fact = owners.get(`${node.type}:${starts[position.originalLine] + position.originalColumn}`)
    if (fact !== undefined) matched.set(node, fact)
  })
  return { tree: emitted, owners: matched }
}

/** Source marks own callables before transforms; exact mappings retain that ownership afterward. */
export function collectCallableSources(code, sources, parserOptions = {}, transformation) {
  if (sources.length === 0) return []
  const { owners } = callableSourceOwners(code, sources, parserOptions, transformation)
  return [...owners].map(([node, fact]) => {
    return [code.slice(callableSourceStart(code, node), node.end), originalText(fact)]
  }).concat(sources.aliases ?? [])
}

/** Emission ranges come from typed nodes and exact generator mappings. */
export function regionCallableRanges(input, generated, sourceRanges, parserOptions) {
  if (!sourceRanges?.length) return []
  const sourceByStart = new Map(sourceRanges.map(fact => [fact.start, fact]))
  const local = new Map()
  t.traverseFast(input.selected, node => {
    if (!isCallable(node)) return
    const fact = sourceByStart.get(sourceOffsetAt(input.sourceMap, node.start))
    if (fact && sourceOffsetAt(input.sourceMap, node.end - 1) + 1 === fact.end) local.set(node.start, fact)
  })
  if (!local.size) return []
  const inputStarts = sourceLineStarts(input.code), generatedStarts = sourceLineStarts(generated.code)
  const mapped = new Map()
  for (const item of generated.rawMappings) if (item.original) mapped.set(
    generatedStarts[item.generated.line - 1] + item.generated.column,
    inputStarts[item.original.line - 1] + item.original.column)
  const output = regionInput(generated.code, { ...input.region, start: 0, end: generated.code.length, children: [] },
    { ...parserOptions, attachComment: false })
  const ranges = []
  t.traverseFast(output.selected, node => {
    if (!isCallable(node)) return
    const start = node.start - output.prefix.length
    const fact = local.get(mapped.get(start))
    if (fact) ranges.push({ marker: fact.marker, start, end: node.end - output.prefix.length,
      staticMethod: node.static && node.type.endsWith('Method') })
  })
  return ranges
}

/** Parent shells and child bodies jointly prove ownership, without retaining
 * their ASTs or parsing the expanded module as a whole. */
export function createRegionCallableCollector(sources) {
  const facts = factMap(sources)
  const collect = input => {
    const ranges = []
    t.traverseFast(input.selected, node => {
      if (isCallable(node)) ranges.push({
        start: sourceOffsetAt(input.sourceMap, node.start),
        end: sourceOffsetAt(input.sourceMap, node.end - 1) + 1,
        staticMethod: node.static && node.type.endsWith('Method'),
      })
    })
    for (const comment of input.tree.comments) if (facts.has(comment.value)) ranges.push({
      marker: comment.value, start: sourceOffsetAt(input.sourceMap, comment.start),
      end: sourceOffsetAt(input.sourceMap, comment.end - 1) + 1,
    })
    return ranges
  }
  return { collect, resolve: resolveRegionCallableRanges }
}

function resolveRegionCallableRanges(ranges) {
  const declarations = [], comments = []
  for (const range of ranges) (range.marker === undefined ? declarations : comments).push(range)
  declarations.sort((a, b) => a.start - b.start || b.end - a.end)
  comments.sort((a, b) => a.start - b.start)
  const owners = new Map(), stack = []
  let next = 0
  for (const comment of comments) {
    while (next < declarations.length && declarations[next].start <= comment.start) {
      const node = declarations[next++]
      while (stack.length && stack.at(-1).end < node.end) stack.pop()
      stack.push(node)
    }
    while (stack.length && stack.at(-1).end < comment.end) stack.pop()
    const owner = stack.at(-1)
    if (owner) owners.set(owner.start, { ...owner, marker: comment.marker })
  }
  return owners
}

export function collectRegionCallableRanges(mapped, sources, options) {
  const collector = createRegionCallableCollector(sources)
  const ranges = []
  visitRegionSource(mapped, options, input => {
    for (const range of collector.collect(input)) ranges.push(range)
  })
  return collector.resolve(ranges)
}

/** Restore identities while the maintained transform's bounded tree and exact
 * source-map points are available; child slots remain structural output facts. */
export function emitRegionCallableSources(input, generated, sourceRanges, options) {
  const originals = new Map()
  t.traverseFast(input.selected, node => {
    if (!isCallable(node)) return
    const fact = sourceRanges.get(sourceOffsetAt(input.sourceMap, node.start))
    if (fact && sourceOffsetAt(input.sourceMap, node.end - 1) + 1 === fact.end) originals.set(node.start, fact)
  })
  const inputStarts = sourceLineStarts(input.code), generatedStarts = sourceLineStarts(generated.code)
  const points = [], origins = new Map()
  visitSourceMappings(generated, (line, column, originalLine, originalColumn) => {
    if (originalLine === undefined) return
    const point = [generatedStarts[line] + column, inputStarts[originalLine] + originalColumn]
    points.push(point)
    origins.set(...point)
  })
  const tree = parse(generated.code, { ...options, plugins: ['importAttributes'],
    allowSuperOutsideMethod: true, allowUndeclaredExports: options.sourceType === 'module', errorRecovery: true })
  for (const error of tree.errors) {
    if (error.reasonCode === 'InvalidPrivateFieldResolution' && input.region.privateNames?.includes(error.details.identifierName)) continue
    throw error
  }
  let from = 0, to = generated.code.length
  if (input.prefix) {
    let statement = tree.program.body[0].body.body[0]
    while (statement.type === 'LabeledStatement') statement = statement.body
    const body = statement.body.body
    from = body[0]?.start ?? statement.body.start + 1
    to = body.at(-1)?.end ?? from
  }
  const owners = []
  const slotStarts = new Map(input.slots.map(slot => [slot.start, slot]))
  const slotEnds = new Map(input.slots.map(slot => [slot.end - 1, slot]))
  const slots = []
  t.traverseFast(tree, node => {
    if (node.type === 'BlockStatement' && node.body.length === 0 && node.directives.length === 0) {
      const slot = slotStarts.get(origins.get(node.start)) ?? slotEnds.get(origins.get(node.end - 1))
      if (slot) slots.push({ sourceStart: slot.start, start: node.start, end: node.end, prefix: '' })
    }
    if (!isCallable(node) || node.start < from || node.end > to) return
    const fact = originals.get(origins.get(node.start))
    if (fact) owners.push({ node, fact })
  })
  const markers = new Set([...originals.values()].map(fact => fact.marker))
  const edits = tree.comments.filter(comment => markers.has(comment.value))
    .map(comment => ({ start: comment.start, end: comment.end, text: '' }))
  for (const { node, fact } of owners) {
    const start = callableMarkerPosition(node, generated.code, tree.comments)
    const text = `/*${fact.marker}*/`
    const slot = slots.find(slot => start > slot.start && start < slot.end)
    if (slot) slot.prefix += text
    else edits.push({ start, end: start, text })
  }
  if (from) edits.push({ start: 0, end: from, text: '' })
  if (to < generated.code.length) edits.push({ start: to, end: generated.code.length, text: '' })
  edits.sort((a, b) => a.start - b.start || a.end - b.end)
  // Non-overlapping edits have ordered ends. Include every edit ending at a
  // queried boundary, including all insertions at that same position.
  const deltas = [0]
  for (const edit of edits) deltas.push(deltas.at(-1) + edit.text.length - (edit.end - edit.start))
  const position = offset => {
    let low = 0, high = edits.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (edits[middle].end > offset) high = middle
      else low = middle + 1
    }
    return offset + deltas[low]
  }
  const emission = mappedSourceTransform(input.code, identitySourceMap(input.code.length), generated)
  const restored = applySourceEdits(emission.code, emission.sourceMap, edits)
  return { code: restored.code, sourceOffsets: restored.sourceMap,
    mappingPoints: points.filter(([output]) => output >= from && output < to)
      .map(([output, original]) => [position(output), original]),
    slotRanges: slots.map(slot => ({ ...slot, start: position(slot.start), end: position(slot.end) })),
    callableRanges: owners.map(({ node, fact }) => ({ marker: fact.marker,
      start: position(node.start), end: position(node.end), staticMethod: node.static && node.type.endsWith('Method') })),
  }
}

export function callableSourceCatalog(code, sources, ranges) {
  const facts = factMap(sources)
  const buffers = [code]
  const indexes = new Map()
  const bufferIndex = text => {
    let index = indexes.get(text)
    if (index === undefined) { index = buffers.length; indexes.set(text, index); buffers.push(text) }
    return index
  }
  const entries = []
  for (const range of ranges) {
    const fact = facts.get(range.marker)
    if (!fact) continue
    const start = callableSourceStart(code, range)
    const entry = fact.entry
    entries.push([0, start, range.end, bufferIndex(entry ? fact.buffers[entry.buffer] : fact.original),
      entry?.start ?? 0, entry?.end ?? fact.original.length])
  }
  for (const [generated, original] of sources.aliases ?? []) entries.push([
    bufferIndex(generated), 0, generated.length, bufferIndex(original), 0, original.length,
  ])
  return createCallableSourceCatalog(buffers, entries)
}
